// The task flow driven as separate processes, the way the Human, an agent and the host use
// it: the task commands, the task tools over stdio, and the hooks setup wired, which let a
// worker start only on an open task and record its run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openProjectStore } from "../../src/engine/index.ts";
import type { Run, Store } from "../../src/engine/store/index.ts";
import { pathWithFakeClaude } from "./fake-host.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli.ts");
const WORK_FILE = "src/a/work.ts";

let scratch: string;
let env: Record<string, string>;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-task-flow-")));
  // Keep the machine's global git settings out of the project under test.
  env = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    PATH: pathWithFakeClaude(scratch),
  };
  delete env.CLAUDE_PROJECT_DIR;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function run(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tmb(args: string[], cwd: string): string {
  const result = run(args, cwd);
  if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function tmbJson<T = any>(args: string[], cwd: string): T {
  return JSON.parse(tmb([...args, "--json"], cwd)) as T;
}

/** A git project with one commit on main, set up with the given check. */
function setUpProject(check: string): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  git(project, "init", "-q", "-b", "main");
  writeFileSync(path.join(project, "README.md"), "hello\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "first");
  tmb(["setup", "--base", "main", "--check", check, "--yes"], project);
  return project;
}

function commitWork(worktree: string): string {
  mkdirSync(path.join(worktree, path.dirname(WORK_FILE)), { recursive: true });
  writeFileSync(path.join(worktree, WORK_FILE), "export const work = 1;\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-q", "-m", "work");
  return git(worktree, "rev-parse", "HEAD");
}

function withStore<T>(project: string, use: (store: Store) => T): T {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return use(opened.store);
  } finally {
    opened.store.close();
  }
}

describe("task commands", () => {
  test("start, list, brief and close a task as the Human, refusing a close whose check fails", () => {
    const project = setUpProject(`test -f ${WORK_FILE}`);
    const issue = tmbJson(["issue", "create", "Build the thing"], project);

    const started = tmbJson(
      ["task", "start", issue.id, "--intent", "Add the work file", "--file", "src/a", "--criterion", "SC1: the file exists", "--check", "true"],
      project,
    );
    expect(started.branch).toMatch(/^tmb\/[0-9a-z]{8}$/);
    expect(started.worktree).toBe(path.join(project, ".tmb", "worktrees", started.branch.slice(4)));
    expect(git(started.worktree, "rev-parse", "HEAD")).toBe(git(project, "rev-parse", "main"));

    expect(tmb(["task", "list"], project)).toContain(`${started.id}  ${started.branch}  Add the work file`);
    expect(tmbJson<any[]>(["task", "list"], project).map((task) => task.id)).toEqual([started.id]);
    const brief = tmb(["task", "brief", started.id], project);
    expect(brief).toContain(`Worktree: ${started.worktree}`);
    expect(brief).toContain(`- test -f ${WORK_FILE}`);
    expect(brief).toContain(`task_id=${started.id}`);
    expect(tmbJson(["task", "brief", started.id], project).checks).toEqual([`test -f ${WORK_FILE}`, "true"]);

    const overlapping = run(["task", "start", issue.id, "--intent", "Other", "--file", "src", "--criterion", "SC1"], project);
    expect(overlapping.status).toBe(1);
    expect(overlapping.stderr).toContain(started.id);

    // The work is committed without the file the check looks for, so the close is refused.
    writeFileSync(path.join(started.worktree, "other.txt"), "x\n");
    git(started.worktree, "add", ".");
    git(started.worktree, "commit", "-q", "-m", "not yet");
    const refused = run(["task", "close", started.id], project);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`\`test -f ${WORK_FILE}\` exited 1`);
    expect(refused.stderr).toContain("stays open");

    const head = commitWork(started.worktree);
    const closed = tmb(["task", "close", started.id], project);
    expect(closed).toContain(`Closed task ${started.id} at commit ${head}.`);
    expect(tmb(["task", "list"], project)).toContain("No open tasks.");
    expect(tmbJson(["task", "brief", started.id], project)).toMatchObject({ state: "closed", commitSha: head });
    withStore(project, (store) => {
      const checkRuns = store.listCheckRuns(started.id);
      expect(checkRuns.map((checkRun) => checkRun.result)).toEqual(["failed", "passed"]);
      for (const checkRun of checkRuns) expect(checkRun.endedAt).toBeString();
    });
  });

  test("refuses bad task input with what is allowed", () => {
    const project = setUpProject("true");
    expect(run(["task"], project).status).toBe(2);
    expect(run(["task", "start"], project).stderr).toContain("expected one issue id");
    const issue = tmbJson(["issue", "create", "x"], project);
    const noFiles = run(["task", "start", issue.id, "--intent", "x", "--criterion", "SC1"], project);
    expect(noFiles.status).toBe(1);
    expect(noFiles.stderr).toContain("files must be a list of at least 1");
  });
});

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function connect(project: string): Promise<Client> {
  const client = new Client({ name: "task-flow-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--host", "test", "--project", project], env, stderr: "pipe" }));
  return client;
}

async function callJson<T = any>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]!.text) as T;
}

describe("task tools", () => {
  test("the planner starts a task and the worker reads its brief and closes it, through the tool server", async () => {
    const project = setUpProject(`test -f ${WORK_FILE}`);
    const issue = tmbJson(["issue", "create", "Build the thing"], project);
    const client = await connect(project);
    try {
      const started = await callJson(client, "task_start", { issue_id: issue.id, intent: "Add the work file", files: ["src/a"], criteria: ["SC1"] });
      expect(started.brief.startLine).toBe(`task_id=${started.id}`);
      expect((await callJson<any[]>(client, "task_list", {})).map((task) => task.id)).toEqual([started.id]);
      const brief = await callJson(client, "task_brief", { id: started.id, role: "worker" });
      expect(brief).toMatchObject({ worktree: started.worktree, branch: started.branch, checks: [`test -f ${WORK_FILE}`] });

      const early = (await client.callTool({ name: "task_close", arguments: { id: started.id, role: "worker" } })) as ToolResult;
      expect(early.isError).toBe(true);
      expect(early.content[0]!.text).toContain("no commit past the base commit");

      const head = commitWork(started.worktree);
      const closed = await callJson(client, "task_close", { id: started.id, role: "worker" });
      expect(closed.brief).toMatchObject({ state: "closed", commitSha: head });
      expect(closed.checks[0]).toMatchObject({ command: `test -f ${WORK_FILE}`, status: "passed", exitCode: 0 });
      expect(await callJson<any[]>(client, "task_list", {})).toEqual([]);
    } finally {
      await client.close();
    }
    withStore(project, (store) => expect(store.getTask(store.listTasks("closed")[0]!.id)!.createdBy).toEqual({ kind: "agent", role: "planner", host: "test" }));
  });
});

describe("the worker gate through the hook process", () => {
  /** The command setup wired for a hook, run through a shell the way the host runs it. */
  function runHook(project: string, hook: "PreToolUse" | "SubagentStop", input: Record<string, unknown>): string {
    const settings = JSON.parse(readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"));
    const command: string = settings.hooks[hook][0].hooks[0].command;
    const result = spawnSync(command, { shell: true, cwd: project, env, input: JSON.stringify({ cwd: project, ...input }), encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  function startWorker(project: string, prompt: string): string {
    return runHook(project, "PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "worker", prompt } });
  }

  function openWorkerRuns(project: string): Run[] {
    return withStore(project, (store) => store.openRuns("worker"));
  }

  test("denies a worker start with no open task, allows one naming its task and records the run from start to stop", () => {
    const project = setUpProject("true");
    const issue = tmbJson(["issue", "create", "Build the thing"], project);
    const started = tmbJson(["task", "start", issue.id, "--intent", "Do it", "--file", "src", "--criterion", "SC1"], project);

    const denied = JSON.parse(startWorker(project, "Do the work, no task named."));
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("task_id=<id>");
    expect(openWorkerRuns(project)).toEqual([]);

    expect(startWorker(project, `Carry out the task.\n${started.brief.startLine}`)).toBe("");
    const [run] = openWorkerRuns(project);
    expect(run).toMatchObject({ taskId: started.id, role: "worker", endedAt: null, createdBy: { kind: "agent", role: "worker", host: "claude-code" } });

    expect(runHook(project, "SubagentStop", { hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "worker" })).toBe("");
    expect(openWorkerRuns(project)).toEqual([]);
    withStore(project, (store) => {
      const [start, end] = store.history(run!.id);
      expect(start).toMatchObject({ type: "created", data: { task_id: started.id, ended_at: null } });
      expect(end).toMatchObject({ type: "updated", data: { ended_at: expect.any(String) } });
    });
  });
});
