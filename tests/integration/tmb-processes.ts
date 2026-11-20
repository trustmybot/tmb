// tmb driven as separate processes in temporary git projects, the way the Human, an agent and
// the host use it: the command line, git, and the tool server over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathWithFakeClaude } from "./fake-host.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
export const CLI = path.join(ROOT, "src", "cli.ts");
export const BASE_BRANCH = "main";

export type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

/**
 * Makes a scratch folder now, and returns the helpers that work in it; call cleanup() after
 * the tests. `prefix` names the scratch folder.
 */
export function tmbProcesses(prefix: string) {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  // Keep the machine's global git settings, its host's project folder and any unattended mode out of the project under test.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    PATH: pathWithFakeClaude(scratch),
  };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.TMB_UNATTENDED;
  // Piped output stays plain, as the tests read it, even when the machine forces colour.
  delete env.FORCE_COLOR;

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env, encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  function run(args: string[], cwd: string) {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** Runs a tmb command that must succeed and returns its stdout. */
  function tmb(args: string[], cwd: string): string {
    const result = run(args, cwd);
    if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
    return result.stdout;
  }

  function tmbJson<T = any>(args: string[], cwd: string): T {
    return JSON.parse(tmb([...args, "--json"], cwd)) as T;
  }

  /**
   * A git project whose first commit on the base branch holds `files` (a README when none), set
   * up with the given check. With `origin`, a bare repository is its origin and holds the base
   * branch before init, as a project that is already on a remote does.
   */
  function setUpProject(check: string, files: Record<string, string> = { "README.md": "hello\n" }, options: { origin?: boolean } = {}): string {
    const project = mkdtempSync(path.join(scratch, "project-"));
    git(project, "init", "-q", "-b", BASE_BRANCH);
    // tmb's own git calls (the rebase in a close) commit too, and a CI runner has no global identity for them.
    git(project, "config", "user.name", "t");
    git(project, "config", "user.email", "t@example.com");
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      writeFileSync(path.join(project, file), text);
    }
    git(project, "add", ".");
    git(project, "commit", "-q", "-m", "first");
    if (options.origin) {
      const origin = `${project}-origin.git`;
      git(scratch, "init", "-q", "--bare", origin);
      git(project, "remote", "add", "origin", origin);
      git(project, "push", "-q", "-u", "origin", BASE_BRANCH);
    }
    tmb(["init"], project);
    tmb(["onboard", "--base", BASE_BRANCH, "--review-mode", "agile", "--check", check, "--yes"], project);
    return project;
  }

  /** Writes and commits one file in a worktree, as the one doing a task would; returns the commit. */
  function commitFile(worktree: string, file: string, text: string, message: string): string {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    writeFileSync(path.join(worktree, file), text);
    git(worktree, "add", file);
    git(worktree, "commit", "-q", "-m", message);
    return git(worktree, "rev-parse", "HEAD");
  }

  /** What a new host session in the project is told: its session start event, answered by `tmb hook session-start`. */
  function sessionStart(project: string): string {
    const event = JSON.stringify({ session_id: "workflow", hook_event_name: "SessionStart", source: "startup", cwd: project });
    const result = spawnSync(process.execPath, [CLI, "hook", "session-start"], { cwd: project, env, input: event, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0 || result.stderr !== "") throw new Error(`tmb hook session-start exited ${result.status}: ${result.stderr}`);
    return (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  }

  /** Runs a host hook as the host would, with `input` as its JSON event; the hook's stdout, empty for an allow. */
  function hook(project: string, event: string, input: Record<string, unknown>): string {
    const json = JSON.stringify({ session_id: "workflow", cwd: project, ...input });
    const result = spawnSync(process.execPath, [CLI, "hook", event], { cwd: project, env, input: json, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0 || result.stderr !== "") throw new Error(`tmb hook ${event} exited ${result.status}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** Starts a subagent of the role through the host's hook, as the planner's Agent call would; returns the deny reason, or null when allowed. */
  function startSubagent(project: string, role: string, prompt: string): string | null {
    const out = hook(project, "pre-tool-use", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: role, prompt } });
    return out === "" ? null : (JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string);
  }

  /** Ends a subagent of the role through the host's hook. */
  function stopSubagent(project: string, role: string): void {
    hook(project, "subagent-stop", { hook_event_name: "SubagentStop", agent_type: role });
  }

  /**
   * A connected client on the project's tool server, acting for the host `test` unless named. A
   * verdict needs the host whose hook started the reviewer, Claude Code here.
   */
  /** Starts the tool server; `unattended` runs it as in a run no one can answer. */
  async function connect(project: string, host = "test", options: { unattended?: boolean } = {}): Promise<Client> {
    const client = new Client({ name: "tmb-processes-test", version: "0.0.0" });
    const serverEnv = options.unattended ? { ...env, TMB_UNATTENDED: "1" } : env;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--host", host, "--project", project], env: serverEnv, stderr: "pipe" }));
    return client;
  }

  function cleanup(): void {
    rmSync(scratch, { recursive: true, force: true });
  }

  return { scratch, env, git, run, tmb, tmbJson, setUpProject, commitFile, sessionStart, hook, startSubagent, stopSubagent, connect, cleanup };
}

/** Calls a tool that must succeed and parses its JSON answer. */
export async function callJson<T = any>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text) as T;
}

/** Calls a tool that must refuse and returns its message. */
export async function callRefused(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (!result.isError) throw new Error(`${name} was expected to refuse, but answered ${result.content[0]?.text}`);
  return result.content[0]!.text;
}
