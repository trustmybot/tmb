// Workflow simulation, ported from the plugin's flow 11 (concurrent sibling tasks): two open
// tasks on one feature branch, each on its own branch and worktree; a third that would share a
// file is refused. Closing the first folds it and leaves the second open with its worktree; closing
// the second then rebases it onto the moved feature branch, runs the checks again on the rebased
// commit and folds it. Scripted as tool calls through the tool server, with no model.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../integration/tmb-processes.ts";

const FEATURE = "feat/siblings";

const { scratch, git, tmbJson, setUpProject, commitFile, connect, cleanup } = tmbProcesses("tmb-flow-11-");
afterAll(cleanup);

describe("flow 11: concurrent sibling tasks", () => {
  test("two tasks on one feature branch; an overlapping third is refused; each close folds, the second rebased and checked again", async () => {
    const project = setUpProject("true");
    const base = git(project, "rev-parse", "main");
    const issue = tmbJson(["issue", "create", "Two independent changes"], project);
    // The second task's own check logs each commit it runs on, so the test sees every check run.
    const checkedLog = path.join(scratch, "sibling-b-checked.log");
    const client = await connect(project);
    try {
      await callJson(client, "feature_start", { name: FEATURE });
      const start = (files: string[], checks: string[] = []) =>
        callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: `Change ${files.join(", ")}`, files, criteria: ["SC1: done"], checks });
      const a = await start(["src/a"]);
      const b = await start(["src/b"], [`git rev-parse HEAD >> '${checkedLog}'`]);

      // Both are open, on distinct branches and worktrees, cut from the same feature tip.
      expect(a.branch).not.toBe(b.branch);
      expect(a.worktree).not.toBe(b.worktree);
      for (const task of [a, b]) {
        expect(existsSync(task.worktree)).toBe(true);
        expect(task.brief).toMatchObject({ state: "open", feature: FEATURE, baseCommit: base });
      }

      // A third task that would share a file with an open one is refused, and nothing is cut for it.
      const overlap = await callRefused(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Touch a again", files: ["src/a/one.ts"], criteria: ["SC1"] });
      expect(overlap).toContain(`src/a/one.ts overlaps src/a of open task ${a.id}`);
      expect((await callJson(client, "task_list", {})).map((task: any) => task.id)).toEqual([a.id, b.id]);
      expect(git(project, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(3);

      const aHead = commitFile(a.worktree, "src/a/one.ts", "export const a = 1;\n", "add a");
      const bHead = commitFile(b.worktree, "src/b/two.ts", "export const b = 2;\n", "add b");

      // Closing the first folds it by a fast-forward and leaves the second open with its worktree intact.
      const aClosed = await callJson(client, "task_close", { id: a.id, role: "worker" });
      expect(aClosed.fold).toEqual({ feature: FEATURE, from: base, to: aHead, rebased: false });
      expect(git(project, "rev-parse", FEATURE)).toBe(aHead);
      expect(existsSync(a.worktree)).toBe(false);
      expect(await callJson(client, "task_brief", { id: b.id })).toMatchObject({ state: "open", commitSha: null });
      expect(existsSync(b.worktree)).toBe(true);
      expect(git(b.worktree, "rev-parse", "HEAD")).toBe(bHead);
      expect(git(project, "worktree", "list", "--porcelain")).toContain(`branch refs/heads/${b.branch}`);

      // Closing the second rebases it onto the moved feature branch, checks the rebased commit again and folds it.
      const bClosed = await callJson(client, "task_close", { id: b.id, role: "worker" });
      const folded = git(project, "rev-parse", FEATURE);
      expect(folded).not.toBe(bHead);
      expect(bClosed.fold).toEqual({ feature: FEATURE, from: aHead, to: folded, rebased: true });
      expect(git(project, "rev-parse", `${folded}^`)).toBe(aHead);
      expect(git(project, "show", "-s", "--format=%s", folded)).toBe("add b");
      expect(bClosed.checkRunIds).toHaveLength(2);
      expect(bClosed.checkRunId).toBe(bClosed.checkRunIds[1]);
      expect(readFileSync(checkedLog, "utf8").trim().split("\n")).toEqual([bHead, folded]);
      expect(bClosed.brief).toMatchObject({ state: "closed", commitSha: folded });

      expect(git(project, "rev-list", `${base}..${FEATURE}`).split("\n")).toEqual([folded, aHead]);
      expect(await callJson(client, "task_list", {})).toEqual([]);
      expect(git(project, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual([FEATURE, "main"]);
      expect((await callJson(client, "feature_list", {}))[0].tasks).toEqual([a.id, b.id]);
    } finally {
      await client.close();
    }
  });
});
