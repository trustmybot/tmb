// The tests every host adapter must pass, run once per host through the real doors: tmb init,
// tmb onboard and tmb remove as processes, the hooks init wired run by a shell as the host runs
// them, and the tool server init registered. A new adapter adds a harness to HARNESSES and passes all of it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOST_ADAPTERS } from "../../src/adapters/index.ts";
import { AWAITING_REVIEW_HEADING, OPEN_WORK_HEADING, openProjectStore, projectDbPath, TMB_EVENT_TYPES } from "../../src/engine/index.ts";
import type { Store } from "../../src/engine/store/index.ts";
import { claudeCodeHarness } from "./adapters/claude-code.ts";
import { codexHarness } from "./adapters/codex.ts";
import type { ContractEvent, HostHarness } from "./adapters/harness.ts";

const HARNESSES: readonly HostHarness[] = [claudeCodeHarness, codexHarness];

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli.ts");

let scratch: string;
let env: Record<string, string>;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-adapter-contract-")));
  const hostFolders = HARNESSES.map((harness) => harness.fakeHost(path.join(scratch, harness.adapter.id)));
  env = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: [...hostFolders, process.env.PATH ?? ""].join(path.delimiter),
  };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.TMB_UNATTENDED;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("every host adapter has a harness, so none skips the shared tests", () => {
  expect(HARNESSES.map((harness) => harness.adapter.id).sort()).toEqual(HOST_ADAPTERS.map((adapter) => adapter.id).sort());
});

function tmb(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function newProject(): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  git(project, "init", "-q", "-b", "main");
  writeFileSync(path.join(project, "README.md"), "hello\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "first");
  return project;
}

/** Every file in the project outside .git and the record's folder, with its bytes. */
function snapshot(project: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(project, full);
      if (relative === ".git" || relative === ".tmb") continue;
      if (entry.isDirectory()) walk(full);
      else files[relative] = readFileSync(full, "base64");
    }
  };
  walk(project);
  return files;
}

function withStore<T>(project: string, read: (store: Store) => T): T {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return read(opened.store);
  } finally {
    opened.store.close();
  }
}

for (const harness of HARNESSES) {
  const { adapter } = harness;

  /** Runs the hook init wired for the event through a shell, as the host does; the host's reading of its answer. */
  function raise(project: string, event: ContractEvent) {
    const call = harness.hookCall(project, event);
    if (!call) throw new Error(`${adapter.name} raises no ${event.type} event`);
    const result = spawnSync(call.command, { shell: true, cwd: project, env: { ...env, ...call.env }, input: call.input, encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    return harness.readAnswer(event, result.stdout);
  }

  function setUp(project: string, role = "planner"): string {
    const init = tmb(["init", "--host", adapter.id, "--role", role], project);
    return init + tmb(["onboard", "--host", adapter.id, "--base", "main", "--check", "true", "--yes"], project);
  }

  describe(`${adapter.name} (${adapter.id}): the adapter contract`, () => {
    test("detect finds the host's program on the path it is given, and nothing on an empty one", () => {
      const empty = mkdtempSync(path.join(scratch, "empty-path-"));
      expect(adapter.detect(empty)).toEqual({ installed: false });
      const found = adapter.detect(harness.fakeHost(mkdtempSync(path.join(scratch, "host-"))));
      expect(found.installed).toBe(true);
      expect(found.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    test("limits name only tmb events, always the session start, and the harness raises exactly those", () => {
      expect(adapter.limits.events.every((type) => (TMB_EVENT_TYPES as readonly string[]).includes(type))).toBe(true);
      expect(adapter.limits.events).toContain("session-start");
      const project = newProject();
      setUp(project);
      const samples: Record<string, ContractEvent> = {
        "session-start": { type: "session-start" },
        "before-file-write": { type: "before-file-write", role: "planner", file: "notes.md" },
        "before-agent-start": { type: "before-agent-start", role: "reviewer", prompt: "review" },
        "after-agent-stop": { type: "after-agent-stop", role: "reviewer" },
      };
      for (const type of TMB_EVENT_TYPES) {
        const raised = harness.hookCall(project, samples[type]!) !== null;
        expect({ type, raised }).toEqual({ type, raised: adapter.limits.events.includes(type) });
      }
    });

    test("init writes the record, a second init changes nothing, and remove gives back the Human's files and keeps the record", () => {
      const project = newProject();
      harness.seedHumanFiles(project);
      const gitignore = path.join(project, ".gitignore");
      writeFileSync(gitignore, "node_modules/\n");
      const before = snapshot(project);

      setUp(project);
      const afterSetup = snapshot(project);
      expect(afterSetup).not.toEqual(before);
      expect(withStore(project, () => true)).toBe(true);

      setUp(project);
      expect(snapshot(project)).toEqual(afterSetup);

      tmb(["remove", "--host", adapter.id], project);
      const afterRemove = snapshot(project);
      // The lines init added to .gitignore stay with the record they hide.
      expect(Buffer.from(afterRemove[".gitignore"]!, "base64").toString()).toStartWith("node_modules/\n");
      delete afterRemove[".gitignore"];
      delete before[".gitignore"];
      expect(afterRemove).toEqual(before);
      expect(readdirSync(path.dirname(projectDbPath(project)))).toContain(path.basename(projectDbPath(project)));
    });

    test("the session start the host raises is answered with the planner's role and the open work", () => {
      const project = newProject();
      setUp(project);
      const answer = raise(project, { type: "session-start" });
      expect(answer.deny).toBeNull();
      expect(answer.context).toContain("bro");
      expect(answer.context).toContain(OPEN_WORK_HEADING);
    });

    test("the registered tool server answers, and what it records names this host", async () => {
      const project = newProject();
      setUp(project);
      const server = harness.toolServer(project);
      const client = new Client({ name: "adapter-contract", version: "0.0.0" });
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: project, env, stderr: "pipe" }));
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("issue_create");
        const result = (await client.callTool({ name: "issue_create", arguments: { title: "From the contract" } })) as { content: { text: string }[] };
        const issue = JSON.parse(result.content[0]!.text) as { id: string };
        expect(withStore(project, (store) => store.getIssue(issue.id)?.createdBy)).toEqual({ kind: "agent", role: "planner", host: adapter.id });
      } finally {
        await client.close();
      }
    });

    test("a guarded action is denied in the host's own terms, an allowed one goes through, and both are recorded under this host", () => {
      const project = newProject();
      setUp(project);
      // tmb reads no shell command: a push that skips git's hook is neither refused nor recorded, from any role.
      for (const role of ["planner", "worker", "reviewer"]) {
        expect(raise(project, { type: "shell-command", role, command: "git push --no-verify origin main" }).deny).toBeNull();
      }
      expect(withStore(project, (store) => store.listGuardDecisions())).toHaveLength(0);
      if (adapter.limits.events.includes("before-file-write")) {
        const write = raise(project, { type: "before-file-write", role: "reviewer", file: "README.md" });
        if (adapter.limits.namesAgentOnToolCall) {
          // A reviewer subagent's edit tools are taken away by its agent file, which the host enforces.
          expect(write.deny).toBeNull();
        } else {
          // The host names no agent, so a reviewer subagent's write is judged as the host's own role,
          // the planner's, and goes through; git's pre-push hook still judges every push of it.
          expect(write.deny).toBeNull();
          const last = withStore(project, (store) => store.listGuardDecisions().at(-1));
          expect(last?.createdBy).toEqual({ kind: "agent", role: "planner", host: adapter.id });
          expect(readFileSync(path.join(project, ".git", "hooks", "pre-push"), "utf8")).toContain("pre-push");
        }
      }
      const decisions = withStore(project, (store) => store.listGuardDecisions());
      expect(decisions.length).toBeGreaterThan(0);
      for (const decision of decisions) expect(decision.createdBy).toMatchObject({ kind: "agent", host: adapter.id });
    });

    test("a reviewer started and stopped through the host is recorded as one run of this host", () => {
      if (!adapter.limits.events.includes("before-agent-start")) return;
      const project = newProject();
      setUp(project);
      expect(raise(project, { type: "before-agent-start", role: "reviewer", prompt: "Review the branch." }).deny).toBeNull();
      const open = withStore(project, (store) => store.openRuns("reviewer"));
      expect(open).toHaveLength(1);
      expect(open[0]!.createdBy).toEqual({ kind: "agent", role: "reviewer", host: adapter.id });
      if (adapter.limits.events.includes("after-agent-stop")) {
        raise(project, { type: "after-agent-stop", role: "reviewer" });
        expect(withStore(project, (store) => store.openRuns("reviewer"))).toHaveLength(0);
      }
    });

    test("set up as the reviewer, the host's main agent is briefed, guarded and run as the reviewer", () => {
      const project = newProject();
      setUp(project, "reviewer");
      const started = raise(project, { type: "session-start" });
      expect(started.context).toContain(AWAITING_REVIEW_HEADING);
      expect(started.context).not.toContain(OPEN_WORK_HEADING);
      const open = () => withStore(project, (store) => store.openRuns("reviewer"));
      expect(open().map((run) => run.createdBy)).toEqual([{ kind: "agent", role: "reviewer", host: adapter.id }]);

      if (adapter.limits.events.includes("before-file-write") && adapter.limits.canDenyToolCall) {
        expect(raise(project, { type: "before-file-write", role: "planner", file: "README.md" }).deny).toContain("reviewer");
      }
      expect(raise(project, { type: "session-end" }).deny).toBeNull();
      expect(open()).toHaveLength(0);
    });

    test("a record tmb cannot read denies, and bad input never breaks the host's session", () => {
      const project = newProject();
      setUp(project);
      const dbFile = projectDbPath(project);
      for (const suffix of ["-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
      writeFileSync(dbFile, "this is not a database, only text long enough to look like a header");
      const event: ContractEvent = { type: "before-file-write", role: "planner", file: "README.md" };
      if (adapter.limits.canDenyToolCall) expect(raise(project, event).deny).toContain("cannot read the project's record");

      const call = harness.hookCall(project, event)!;
      const garbled = spawnSync(call.command, { shell: true, cwd: project, env: { ...env, ...call.env }, input: "{not json", encoding: "utf8", timeout: 30_000 });
      expect(garbled.status).toBe(0);
      expect(garbled.stdout).toBe("");
    });
  });
}
