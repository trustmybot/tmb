// Workflow simulation of a simple task: the planner records the
// issue, starts a feature branch and a task, a worker commits the work and closes it, and the
// close folds it into the feature branch. Along the way the worker is refused the planner's
// steps. Scripted as tool calls through the tool server, with no model.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { callJson, callRefused, tmbProcesses } from "../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const FEATURE = "feat/hello";
const FILE = "hello.txt";
const CHECK = `test -f ${FILE}`;

const { git, setUpProject, commitFile, connect, cleanup } = tmbProcesses("tmb-simple-task-");
afterAll(cleanup);

describe("a simple task: recorded, worked, closed and folded into its feature branch", () => {
  test("issue, feature branch, task, committed work and close fold it; a worker cannot start a feature branch or a task", async () => {
    const project = setUpProject(CHECK);
    const base = git(project, "rev-parse", "main");
    const client = await connect(project);
    try {
      // 1. The planner records the goal as an issue.
      const issue = await callJson(client, "issue_create", { title: "Add a hello file", body: "One file, no architecture impact." });
      expect(issue).toMatchObject({ title: "Add a hello file", state: "open", createdBy: { kind: "agent", role: "planner", host: "test" } });

      // 2. A worker cannot start the feature branch; the planner can.
      expect(await callRefused(client, "feature_start", { name: FEATURE, role: "worker" })).toBe("feature_start is for the planner, not the worker");
      expect(git(project, "branch", "--list", FEATURE)).toBe("");
      const feature = await callJson(client, "feature_start", { name: FEATURE });
      expect(feature).toMatchObject({ name: FEATURE, baseCommit: base, state: "open", tasks: [] });

      // 3. A worker cannot start the task; the planner can, and gets its branch and worktree.
      const spec = { issue_id: issue.id, kind: "code", intent: "Add the hello file", files: [FILE], criteria: ["SC1: hello.txt exists"] };
      expect(await callRefused(client, "task_start", { ...spec, role: "worker" })).toBe("task_start is for the planner, not the worker");
      expect(await callJson(client, "task_list", {})).toEqual([]);
      const started = await callJson(client, "task_start", spec);
      expect(started.brief).toMatchObject({ state: "open", feature: FEATURE, kind: "code", baseCommit: base, checks: [CHECK] });
      expect(existsSync(started.worktree)).toBe(true);
      expect(git(project, "worktree", "list", "--porcelain")).toContain(`branch refs/heads/${started.branch}`);

      // 4. The worker reads its brief, commits the work in the worktree and closes the task.
      const worker = { id: started.id, role: "worker" };
      const brief = await callJson(client, "task_brief", worker);
      expect(brief).toMatchObject({ worktree: started.worktree, spec: { criteria: ["SC1: hello.txt exists"] }, startLine: `task_id=${started.id}` });
      const commit = commitFile(started.worktree, FILE, "hello\n", "add hello");
      const closed = await callJson(client, "task_close", worker);
      expect(closed.fold).toEqual({ feature: FEATURE, from: base, to: commit, rebased: false });
      expect(closed.checks).toMatchObject([{ command: CHECK, status: "passed" }]);

      // 5. The task is closed at its commit, the feature branch holds it, the task's checkout is gone and the issue stays open.
      expect(git(project, "rev-parse", FEATURE)).toBe(commit);
      expect(git(project, "rev-parse", "main")).toBe(base);
      expect(existsSync(started.worktree)).toBe(false);
      expect(git(project, "branch", "--list", started.branch)).toBe("");
      expect(await callJson(client, "task_brief", worker)).toMatchObject({ state: "closed", commitSha: commit, reviewMode: "agile" });
      expect(await callJson(client, "feature_list", {})).toEqual([{ ...feature, tasks: [started.id] }]);
      expect((await callJson(client, "issue_get", { id: issue.id })).issue.state).toBe("open");
    } finally {
      await client.close();
    }
  });
});
