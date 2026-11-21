// Shared helpers for the test drivers run by bun: the second-host agent chain in
// tests/agent-chain, and the install smoke test. Each driver is a plain
// script that prints PASS or FAIL lines and exits 0 when it passes, 1 when it fails and 2 when
// it cannot run (no claude, no tmb, no git or bun). Every temp folder a driver makes is removed
// when it exits. Uses only node built-ins and bun, so the install smoke test can run on a
// machine that has only bun and the checkout.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { asHuman } from "./as-human.ts";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------------------------
// Outcome

/** Prints `FAIL <message>` and exits 1. */
export function fail(message: string): never {
  console.log(`FAIL ${message}`);
  process.exit(1);
}

/** Prints `<label>: <message>` to stderr and exits 2: the test cannot run on this machine. */
export function cannotRun(label: string, message: string): never {
  console.error(`${label}: ${message}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Temp folders and logs

const cleanups: string[] = [];
process.on("exit", () => {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file still locked (Windows) leaves the folder behind; the outcome stands.
    }
  }
});

/**
 * A new empty folder under the system temp folder, named `<prefix>.<random>`. Removed when the
 * driver exits unless `keep` is set.
 */
export function tempDir(prefix: string, keep = false): string {
  let dir: string;
  try {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), `${prefix}.`)));
  } catch (error) {
    console.error(`could not make a temp folder: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  if (!keep) cleanups.push(dir);
  return dir;
}

/** Where a session's answer is saved: TMB_AGENT_LOG, or a new file in a kept temp folder. */
export function agentLog(prefix: string): string {
  return process.env.TMB_AGENT_LOG || path.join(tempDir(`${prefix}-log`, true), "answer.log");
}

/** Prints a saved log between markers, as `--- <label> (saved to <file>) ---`. */
export function show(label: string, file: string): void {
  console.log(`--- ${label} (saved to ${file}) ---`);
  if (existsSync(file)) process.stdout.write(readFileSync(file, "utf8"));
  console.log(`--- end of ${label} ---`);
}

/** The text of a file, trimmed of its last newline; used for the Human-authored prompts. */
export function readPrompt(file: string): string {
  return readFileSync(file, "utf8").replace(/\r?\n$/, "");
}

// ---------------------------------------------------------------------------------------------
// Processes

export type Result = { status: number; stdout: string; stderr: string; output: string };

/** Runs a command to its end and captures what it prints. `status` is -1 when it could not start. */
export function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; input?: string | Buffer } = {}): Result {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.error ? `${result.stderr ?? ""}${result.error.message}\n` : (result.stderr ?? "");
  return { status: result.status ?? -1, stdout, stderr, output: stdout + stderr };
}

/** Runs a command with stdout and stderr both written, in order, to `file`. Returns its exit status. */
export function runToFile(command: string, args: string[], file: string, options: { cwd?: string; env?: Record<string, string | undefined> } = {}): number {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "w");
  try {
    const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", fd, fd] });
    if (result.error) return -1;
    return result.status ?? -1;
  } finally {
    closeSync(fd);
  }
}

/** Runs a command with its output shown as it prints. Returns its exit status. */
export function runShown(command: string, args: string[], options: SpawnSyncOptions = {}): number {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  return result.error ? -1 : (result.status ?? -1);
}

/** `env` with the variables in `changes` set, or removed where undefined; PATH matched in any case. */
export function withEnv(changes: Record<string, string | undefined>, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [name, value] of Object.entries(changes)) {
    for (const key of Object.keys(out)) if (key.toLowerCase() === name.toLowerCase() && key !== name) delete out[key];
    if (value === undefined) delete out[name];
    else out[name] = value;
  }
  return out;
}

/** The PATH of `env`, whatever its case on Windows. */
export function pathOf(env: Record<string, string | undefined> = process.env): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  return (key && env[key]) || "";
}

// ---------------------------------------------------------------------------------------------
// The agent run's tools: tmb, claude, git and bun

/** The model each agent run's claude uses: TMB_AGENT_MODEL, by default haiku. */
export const MODEL = process.env.TMB_AGENT_MODEL || "haiku";

/**
 * What the code-writing runs allow: tmb's tools, the subagent tool (Agent, or Task in older
 * Claude Code), the file tools, and Bash as a whole. The project is a throwaway temp folder, the
 * model wraps commands in compounds such as `cd X && bun test | tail` that narrower Bash rules
 * never match, and no one is there to approve a prompt. Every call still goes through tmb's
 * hooks: nothing here bypasses them.
 */
export const CODE_TOOLS = "mcp__tmb__* Agent Task Read Glob Grep Edit Write Bash";

/**
 * Checks the run can start: claude on PATH, the tmb to set up with (TMB_BIN, by default tmb on
 * PATH), and each of `tools`. Exits 2 naming what is missing. Returns the tmb to run.
 */
export function preflight(label: string, tools: string[] = []): string {
  if (!Bun.which("claude")) cannotRun(label, "claude (Claude Code) is not on PATH; install it and log in, then run this again.");
  const name = process.env.TMB_BIN || "tmb";
  const tmb = Bun.which(name);
  if (!tmb) cannotRun(label, `tmb not found at '${name}'; install it or set TMB_BIN.`);
  for (const tool of tools) {
    if (!Bun.which(tool)) cannotRun(label, `${tool} is not on PATH; install it, then run this again.`);
  }
  return tmb;
}

/**
 * Runs one new `claude -p` session in `project`, its output saved to `log`. No one answers in
 * the run, so it starts in tmb's unattended mode. Returns claude's exit status.
 */
export function askClaude(project: string, prompt: string, log: string, options: { allowedTools?: string; args?: string[] } = {}): number {
  const args = ["-p", prompt, "--model", MODEL];
  if (options.allowedTools) args.push("--allowedTools", options.allowedTools);
  args.push(...(options.args ?? []));
  return runToFile("claude", args, log, { cwd: project, env: withEnv({ TMB_UNATTENDED: "1" }) });
}

/** A tmb run in `project`: `tmb.shown(["init"], why)` shows its output and fails the test on an error. */
export class Tmb {
  constructor(
    readonly bin: string,
    readonly project: string,
  ) {}

  /** Runs tmb with its output shown; fails the test with `what` when it exits non-zero. */
  shown(args: string[], what = `tmb ${args.join(" ")} failed in ${this.project}`): void {
    if (runShown(this.bin, args, { cwd: this.project }) !== 0) fail(what);
  }

  /** Runs a step only the Human may take, on a terminal where the Human types yes; fails the test with `what` when it exits non-zero. */
  human(args: string[], what = `tmb ${args.join(" ")} failed in ${this.project}`): void {
    const result = asHuman(this.bin, args, { cwd: this.project });
    process.stdout.write(result.output);
    if (result.status !== 0) fail(what);
  }

  /** Runs tmb and returns what it printed; fails the test, showing that output, on an error. */
  text(args: string[], what = `tmb ${args.filter((arg) => arg !== "--json").join(" ")} failed`): string {
    const result = run(this.bin, args, { cwd: this.project });
    if (result.status !== 0) fail(`${what}: ${result.output}`);
    return result.stdout;
  }

  /** Runs `tmb <args> --json` and returns the parsed answer and its text. */
  json<T = unknown>(args: string[]): { data: T; text: string } {
    const text = this.text([...args, "--json"]);
    try {
      return { data: JSON.parse(text) as T, text };
    } catch {
      fail(`tmb ${args.join(" ")} --json did not print JSON: ${text}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// git

/** Runs git in `cwd` and returns its trimmed stdout; throws with its output on an error. */
export function git(cwd: string, ...args: string[]): string {
  const result = run("git", args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.output.trim()}`);
  return result.stdout.trim();
}

/** The commit `ref` names, or null when there is none. */
export function revParse(cwd: string, ref: string): string | null {
  const result = run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Copies `fixture` into `project` and makes it a git repository on `base` with one commit.
 * The identity lives in the project's own git config, which tasks' worktrees share.
 */
export function fixtureProject(fixture: string, project: string, options: { base: string; name: string; email: string; message: string; before?: () => void }): void {
  try {
    mkdirSync(project, { recursive: true });
    cpSync(fixture, project, { recursive: true });
  } catch (error) {
    console.error(`could not copy ${fixture}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  options.before?.();
  try {
    git(project, "init", "-q", "-b", options.base);
    git(project, "config", "user.name", options.name);
    git(project, "config", "user.email", options.email);
    git(project, "add", ".");
    git(project, "commit", "-q", "-m", options.message);
  } catch (error) {
    fail(`could not make the fixture project a git repository in ${project}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Gives `project` a new bare repository at `origin` as its origin, holding `base`. */
export function bareOrigin(project: string, origin: string, base: string): void {
  try {
    git(path.dirname(origin), "init", "-q", "--bare", origin);
    git(project, "remote", "add", "origin", origin);
    git(project, "push", "-q", "origin", base);
  } catch (error) {
    fail(`could not give the project a local bare repository as origin at ${origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes the tree of `commit` into the new folder `dest`, the way `git archive | tar -x` does. */
export function checkoutTree(project: string, commit: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const archive = spawnSync("git", ["archive", commit], { cwd: project, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${commit}: ${archive.stderr?.toString() ?? archive.error?.message}`);
  const tar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
  if (tar.status !== 0) throw new Error(`tar -x: ${tar.stderr?.toString() ?? tar.error?.message}`);
}

/** Runs `bun test` in `dir`, its output saved to `log`. True when it passes. */
export function bunTest(dir: string, log: string): boolean {
  return runToFile("bun", ["test"], log, { cwd: dir }) === 0;
}
