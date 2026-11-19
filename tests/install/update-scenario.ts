// One install updating itself, the way a user's does: an older tmb is installed, a host
// session starts its tool server and ends it, and the newer build on its channel is swapped
// in only between sessions, even with a task open. Shared by the Install test
// against the real release repo and the integration test against a local one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openProjectStore } from "../../src/engine/project.ts";
import type { Actor } from "../../src/engine/store/index.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const HUMAN: Actor = { kind: "human" };
const IS_WINDOWS = process.platform === "win32";

/** Compiles tmb from this checkout into `outfile`, stamped with `version`. */
export function buildTmb(version: string, outfile: string): void {
  mkdirSync(path.dirname(outfile), { recursive: true });
  const result = spawnSync(
    process.execPath,
    ["build", "--compile", "--define", `TMB_VERSION=${JSON.stringify(version)}`, "--define", `TMB_GIT_SHA="test"`, "src/cli.ts", "--outfile", outfile],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000 },
  );
  if (result.status !== 0) throw new Error(`build of ${version} failed: ${result.stderr}`);
}

export type Scenario = {
  /** The scenario's own scratch folder, holding everything below; `cleanup` removes it. */
  scratch: string;
  /** The installed file, older than the channel's newest build. */
  installed: string;
  /** Env for every tmb run: a scratch HOME and state folder, and any release-repo override. */
  env: Record<string, string>;
  /** Sessions started and not yet ended, ended by `cleanup` so no tmb process holds the folder. */
  sessions: Set<Session>;
  project: string;
  stateDir: string;
};

/** Installs `oldBinary` into a scratch HOME the way the installer lays it out, with a project that has a record. */
export function prepareInstall(oldBinary: string, extraEnv: Record<string, string> = {}): Scenario {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-update-")));
  const home = path.join(scratch, "home");
  const installed = path.join(home, ".local", "bin", IS_WINDOWS ? "tmb.exe" : "tmb");
  mkdirSync(path.dirname(installed), { recursive: true });
  copyFileSync(oldBinary, installed);
  const stateDir = path.join(scratch, "state");
  const project = path.join(scratch, "project");
  mkdirSync(project, { recursive: true });
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  opened.store.close();
  const inherited: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete inherited.TMB_NO_UPDATE;
  delete inherited.TMB_UPDATE_FILE;
  const env: Record<string, string> = { ...inherited, HOME: home, USERPROFILE: home, TMB_STATE_DIR: stateDir, ...extraEnv };
  return { scratch, installed, env, project, stateDir, sessions: new Set() };
}

/**
 * Ends any session still running, then removes the scenario's scratch folder and nothing
 * else. Windows refuses to remove a file a process still has open, so a process that is
 * just exiting gets a few tries.
 */
export async function cleanup(scenario: Scenario): Promise<void> {
  if (!path.basename(scenario.scratch).startsWith("tmb-update-")) throw new Error(`refusing to remove ${scenario.scratch}`);
  for (const session of [...scenario.sessions]) await session.end().catch(() => {});
  rmSync(scenario.scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

export function installedVersion(scenario: Scenario): string {
  const result = spawnSync(scenario.installed, ["--version"], { env: scenario.env, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`tmb --version exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim().split(/\s+/)[1] ?? "";
}

/**
 * Runs `tmb update` with the installed file and returns what it printed. Asynchronous, so a
 * release repo served by the calling process keeps answering while it runs.
 */
export async function runUpdate(scenario: Scenario, ...args: string[]): Promise<{ status: number | null; output: string }> {
  const child = Bun.spawn([scenario.installed, "update", ...args], { env: scenario.env, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { status, output: `${stdout}${stderr}`.trim() };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, done: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

export type Session = { end: () => Promise<void>; pid: number; stderr: () => string };

/** A host session: the installed tmb's tool server, started and answering, until `end` stops it as the host does. */
export async function startSession(scenario: Scenario): Promise<Session> {
  const transport = new StdioClientTransport({
    command: scenario.installed,
    args: ["mcp", "--host", "test", "--project", scenario.project],
    env: scenario.env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "tmb-update-test", version: "0.0.0" });
  await client.connect(transport);
  await client.listTools();
  const pid = transport.pid!;
  const session: Session = {
    pid,
    stderr: () => stderr,
    end: async () => {
      scenario.sessions.delete(session);
      await client.close();
      await waitFor("the tool server to exit", () => !isRunning(pid), 30_000);
    },
  };
  scenario.sessions.add(session);
  return session;
}

/**
 * Waits until a session's background look has kept a newer build for the next swap. On a
 * timeout, says what the look recorded and what the session printed.
 */
export async function waitForStaged(scenario: Scenario, session: Session, timeoutMs = 300_000): Promise<void> {
  const lastCheck = path.join(scenario.stateDir, "last-check.json");
  const staged = path.join(scenario.stateDir, "staged.json");
  try {
    await waitFor("a verified build to be kept", () => {
      if (existsSync(staged)) return true;
      // A look that finished without keeping anything will not keep one later in this session.
      if (existsSync(lastCheck) && !/"outcome":\s*"staged"/.test(readFileSync(lastCheck, "utf8"))) {
        throw new Error("the session's look kept no build");
      }
      return false;
    }, timeoutMs);
  } catch (error) {
    const recorded = existsSync(lastCheck) ? readFileSync(lastCheck, "utf8").trim() : "nothing: the tool server never looked (not a compiled build, or updates off?)";
    throw new Error(`${error instanceof Error ? error.message : String(error)}; the last look recorded ${recorded}; the session printed: ${session.stderr().trim() || "nothing"}`);
  }
}

/** Opens a task in the project's record, as a started task would be; returns a function that closes it. */
export function openTask(scenario: Scenario): () => void {
  const opened = openProjectStore(scenario.project, { create: false });
  if (!opened.ok) throw opened.error;
  const store = opened.store;
  const issueId = store.createIssue(HUMAN, { title: "Work in progress" });
  const taskId = store.appendTask(HUMAN, { issueId, title: "A task in the middle", state: "open" });
  store.close();
  return () => {
    const again = openProjectStore(scenario.project, { create: false });
    if (!again.ok) throw again.error;
    again.store.updateTask(HUMAN, taskId, { state: "closed" });
    again.store.close();
  };
}

/**
 * The whole story for one channel, from an older install to `expected`, with a task open
 * throughout: an open task does not hold an update back, a running session does
 * (trustmybot/tmb#16). Logs the steps it saw, in order, and throws at the first one that is wrong.
 */
export async function updatesItself(scenario: Scenario, expected: string, log: (line: string) => void = () => {}): Promise<void> {
  const before = installedVersion(scenario);
  if (before === expected) throw new Error(`the installed tmb is already ${expected}; the scenario needs an older one`);
  log(`installed ${before}`);

  const closeTask = openTask(scenario);
  const first = await startSession(scenario);
  await waitForStaged(scenario, first);
  log("a session start kept the newer build");

  const during = await runUpdate(scenario);
  if (installedVersion(scenario) !== before) throw new Error(`tmb update swapped the file while a session ran: ${during.output}`);
  log(`while a session runs, tmb update waits: ${during.output}`);

  const second = await startSession(scenario);
  await first.end();
  if (installedVersion(scenario) !== before) throw new Error("the update applied at a session's end while another session still ran");
  log("at a session's end with another session still running, the install keeps its version");

  await second.end();
  const after = installedVersion(scenario);
  if (after !== expected) throw new Error(`after the last session ended, tmb is ${after}, expected ${expected}`);
  log(`after the last session ended, with a task still open, tmb is ${after}`);
  closeTask();

  const again = await runUpdate(scenario);
  if (again.status !== 0 || !again.output.includes("newest")) throw new Error(`tmb update after the swap: ${again.output}`);
  log(`tmb update: ${again.output}`);
}
