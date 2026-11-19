// The task flow driven as separate processes, the way the Human, an agent and the host use
// it: the task commands, the task tools over stdio, and the hooks setup wired, which let a
// worker start only on an open task and record its run.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openProjectStore } from "../../src/engine/index.ts";
import type { Run, Store } from "../../src/engine/store/index.ts";
import { callJson, type ToolResult, tmbProcesses } from "./tmb-processes.ts";

const WORK_FILE = "src/a/work.ts";
const FEATURE = "feat/thing";

const { env, git, run, tmb, tmbJson, setUpProject, connect, cleanup } = tmbProcesses("tmb-task-flow-");
afterAll(cleanup);

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

describe("feature branches", () => {
  test("the Human starts and lists feature branches from the command line, and a bad name is refused", () => {
    const project = setUpProject("true");
    const main = git(project, "rev-parse", "main");
    expect(tmb(["feature", "list"], project)).toContain("No feature branches.");

    expect(tmb(["feature", "start", FEATURE], project)).toContain(`Started feature branch ${FEATURE} from main at ${main}.`);
    expect(git(project, "rev-parse", FEATURE)).toBe(main);
    expect(git(project, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    const listed = tmbJson<any[]>(["feature", "list"], project);
    expect(listed).toMatchObject([{ name: FEATURE, baseBranch: "main", baseCommit: main, state: "open", tasks: [] }]);
    expect(tmb(["feature", "list"], project)).toContain(`${FEATURE}  open    from main at ${main}`);

    const again = run(["feature", "start", FEATURE], project);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(`already holds a feature branch ${FEATURE}`);
    const bad = run(["feature", "start", "bad..name"], project);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("is not a feature branch name");
    expect(run(["feature"], project).status).toBe(2);
    expect(run(["feature", "start"], project).stderr).toContain("expected one feature branch name");
  });

  test("the planner starts and lists feature branches through the tool server; a worker may not start one", async () => {
    const project = setUpProject("true");
    const client = await connect(project);
    try {
      const started = await callJson(client, "feature_start", { name: FEATURE });
      expect(started).toMatchObject({ name: FEATURE, baseBranch: "main", baseCommit: git(project, "rev-parse", "main"), state: "open" });
      expect(git(project, "rev-parse", FEATURE)).toBe(started.baseCommit);
      expect(await callJson(client, "feature_list", {})).toEqual([started]);
      const refused = (await client.callTool({ name: "feature_start", arguments: { name: "feat/mine", role: "worker" } })) as ToolResult;
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain("feature_start is for the planner");
    } finally {
      await client.close();
    }
    withStore(project, (store) => expect(store.findFeature(FEATURE)!.createdBy).toEqual({ kind: "agent", role: "planner", host: "test" }));
  });
});

describe("task commands", () => {
  test("start, list, brief and close a task as the Human, refusing a close whose check fails", () => {
    const project = setUpProject(`test -f ${WORK_FILE}`);
    const issue = tmbJson(["issue", "create", "Build the thing"], project);
    tmb(["feature", "start", FEATURE], project);

    const started = tmbJson(
      ["task", "start", issue.id, "--kind", "code", "--intent", "Add the work file", "--file", "src/a", "--criterion", "SC1: the file exists", "--check", "true"],
      project,
    );
    expect(started.branch).toMatch(/^tmb\/[0-9a-z]{8}$/);
    expect(started.worktree).toBe(path.join(project, ".tmb", "worktrees", started.branch.slice(4)));
    expect(git(started.worktree, "rev-parse", "HEAD")).toBe(git(project, "rev-parse", FEATURE));

    expect(tmb(["task", "list"], project)).toContain(`${started.id}  ${started.branch}  Add the work file`);
    expect(tmbJson<any[]>(["task", "list"], project).map((task) => task.id)).toEqual([started.id]);
    const brief = tmb(["task", "brief", started.id], project);
    expect(brief).toContain(`Worktree: ${started.worktree}`);
    expect(brief).toContain(`Feature branch: ${FEATURE}`);
    expect(brief).toContain("Kind: code");
    expect(brief).toContain(`- test -f ${WORK_FILE}`);
    expect(brief).toContain(`task_id=${started.id}`);
    expect(tmbJson(["task", "brief", started.id], project).checks).toEqual([`test -f ${WORK_FILE}`, "true"]);

    const overlapping = run(["task", "start", issue.id, "--kind", "code", "--intent", "Other", "--file", "src", "--criterion", "SC1"], project);
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
    expect(closed).toContain(`Folded into ${FEATURE}.`);
    expect(closed).toContain("Push: skipped, the repository has no remote named origin");
    expect(git(project, "rev-parse", FEATURE)).toBe(head);
    expect(tmb(["task", "list"], project)).toContain("No open tasks.");
    expect(tmbJson(["task", "brief", started.id], project)).toMatchObject({ state: "closed", commitSha: head });
    expect(tmbJson<any[]>(["task", "list", "--state", "closed"], project)).toMatchObject([{ id: started.id, state: "closed", commitSha: head }]);
    expect(tmb(["task", "list", "--state", "all"], project)).toContain(`${started.id}  closed  ${started.branch}  Add the work file`);
    expect(tmb(["task", "list", "--state", "all"], project)).toContain(`closed at: ${head}`);
    const badState = run(["task", "list", "--state", "done"], project);
    expect(badState.status).toBe(1);
    expect(badState.stderr).toContain("state");
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
    const noFeature = run(["task", "start", issue.id, "--kind", "code", "--intent", "x", "--file", "src", "--criterion", "SC1"], project);
    expect(noFeature.status).toBe(1);
    expect(noFeature.stderr).toContain("no feature branch is open");
    tmb(["feature", "start", FEATURE], project);
    const noKind = run(["task", "start", issue.id, "--intent", "x", "--file", "src", "--criterion", "SC1"], project);
    expect(noKind.status).toBe(1);
    expect(noKind.stderr).toContain("task_start needs kind");
    const noFiles = run(["task", "start", issue.id, "--kind", "code", "--intent", "x", "--criterion", "SC1"], project);
    expect(noFiles.status).toBe(1);
    expect(noFiles.stderr).toContain("files must be a list of at least 1");
  });
});

describe("task tools", () => {
  test("the planner starts a task and the worker reads its brief and closes it, through the tool server", async () => {
    const project = setUpProject(`test -f ${WORK_FILE}`);
    const issue = tmbJson(["issue", "create", "Build the thing"], project);
    const client = await connect(project);
    try {
      await callJson(client, "feature_start", { name: FEATURE });
      const started = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Add the work file", files: ["src/a"], criteria: ["SC1"] });
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

  /** The name setup wrote into the worker's agent file: the host starts the agent, and names it to the hooks, by it. */
  function workerAgentName(project: string): string {
    const text = readFileSync(path.join(project, ".claude", "agents", "worker.md"), "utf8");
    const line = /^name: (.*)$/m.exec(text);
    if (!line) throw new Error("setup wrote no name into the worker's agent file");
    return JSON.parse(line[1]!) as string;
  }

  function startWorker(project: string, prompt: string): string {
    const subagentType = workerAgentName(project);
    return runHook(project, "PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: subagentType, prompt } });
  }

  function openWorkerRuns(project: string): Run[] {
    return withStore(project, (store) => store.openRuns("worker"));
  }

  test("denies a worker start with no open task, allows one naming its task and records the run from start to stop", () => {
    const project = setUpProject("true");
    const issue = tmbJson(["issue", "create", "Build the thing"], project);
    tmb(["feature", "start", FEATURE], project);
    const started = tmbJson(["task", "start", issue.id, "--kind", "code", "--intent", "Do it", "--file", "src", "--criterion", "SC1"], project);

    const denied = JSON.parse(startWorker(project, "Do the work, no task named."));
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("task_id=<id>");
    expect(openWorkerRuns(project)).toEqual([]);

    expect(startWorker(project, `Carry out the task.\n${started.brief.startLine}`)).toBe("");
    const [run] = openWorkerRuns(project);
    expect(run).toMatchObject({ taskId: started.id, role: "worker", endedAt: null, createdBy: { kind: "agent", role: "worker", host: "claude-code" } });

    expect(runHook(project, "SubagentStop", { hook_event_name: "SubagentStop", agent_id: "a1", agent_type: workerAgentName(project) })).toBe("");
    expect(openWorkerRuns(project)).toEqual([]);
    withStore(project, (store) => {
      const [start, end] = store.history(run!.id);
      expect(start).toMatchObject({ type: "created", data: { task_id: started.id, ended_at: null } });
      expect(end).toMatchObject({ type: "updated", data: { ended_at: expect.any(String) } });
    });
  });
});
