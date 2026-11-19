// Workflow simulation: a task's close, scripted as the tool calls a planner and a worker make
// through the tool server, with no model. The project's check fails until the fix lands, so the
// close must wait for it, and a closed task never closes twice.
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../integration/tmb-processes.ts";

const VALUE_FILE = "value.txt";
const CHECK = `grep -qx right ${VALUE_FILE}`;

const { git, tmbJson, setUpProject, connect, cleanup } = tmbProcesses("tmb-workflow-");
afterAll(cleanup);

/** Writes the value file in the worktree and commits it, as a worker would; returns the commit. */
function commitValue(worktree: string, value: string): string {
  writeFileSync(path.join(worktree, VALUE_FILE), `${value}\n`);
  git(worktree, "add", VALUE_FILE);
  git(worktree, "commit", "-q", "-m", `value ${value}`);
  return git(worktree, "rev-parse", "HEAD");
}

describe("closing a task", () => {
  test("is refused while the check fails, succeeds once the fix is committed, and is refused a second time", async () => {
    const project = setUpProject(CHECK, { [VALUE_FILE]: "wrong\n" });
    const issue = tmbJson(["issue", "create", "The value is wrong"], project);
    const client = await connect(project);
    try {
      const started = await callJson(client, "task_start", {
        issue_id: issue.id,
        intent: "Make the value right",
        files: [VALUE_FILE],
        criteria: ["SC1: the value is right"],
      });
      const worker = { id: started.id, role: "worker" };

      // 1. The worker commits a change that keeps the check failing: the close is refused and the task stays open.
      const stillWrong = commitValue(started.worktree, "still wrong");
      const refused = await callRefused(client, "task_close", worker);
      expect(refused).toContain(`\`${CHECK}\` exited 1`);
      expect(refused).toContain(`task ${started.id} stays open`);
      expect(await callJson(client, "task_brief", worker)).toMatchObject({ state: "open", commitSha: null });
      expect((await callJson<any[]>(client, "task_list", {})).map((task) => task.id)).toEqual([started.id]);

      // 2. The fix is committed: the close succeeds and records the commit it checked.
      const fix = commitValue(started.worktree, "right");
      expect(fix).not.toBe(stillWrong);
      const closed = await callJson(client, "task_close", worker);
      expect(closed.brief).toMatchObject({ state: "closed", commitSha: fix });
      expect(closed.checks).toMatchObject([{ command: CHECK, status: "passed", exitCode: 0 }]);
      expect(await callJson(client, "task_list", { state: "closed" })).toMatchObject([{ id: started.id, state: "closed", commitSha: fix }]);

      // 3. A second close of the same task is refused, and the record keeps the first.
      const again = await callRefused(client, "task_close", worker);
      expect(again).toContain(`task ${started.id} is closed; only an open task closes`);
      expect(await callJson(client, "task_brief", worker)).toMatchObject({ state: "closed", commitSha: fix });
    } finally {
      await client.close();
    }
  });
});
