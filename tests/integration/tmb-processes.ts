// tmb driven as separate processes in temporary git projects, the way the Human, an agent and
// the host use it: the command line, git, and the tool server over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  /** A git project whose first commit on the base branch holds `files` (a README when none), set up with the given check. */
  function setUpProject(check: string, files: Record<string, string> = { "README.md": "hello\n" }): string {
    const project = mkdtempSync(path.join(scratch, "project-"));
    git(project, "init", "-q", "-b", BASE_BRANCH);
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(project, file), text);
    git(project, "add", ".");
    git(project, "commit", "-q", "-m", "first");
    tmb(["setup", "--base", BASE_BRANCH, "--check", check, "--yes"], project);
    return project;
  }

  /** A connected client on the project's tool server, acting for the host `test`. */
  async function connect(project: string): Promise<Client> {
    const client = new Client({ name: "tmb-processes-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--host", "test", "--project", project], env, stderr: "pipe" }));
    return client;
  }

  function cleanup(): void {
    rmSync(scratch, { recursive: true, force: true });
  }

  return { scratch, env, git, run, tmb, tmbJson, setUpProject, connect, cleanup };
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
