// Workflow simulation: two open tasks may hold the same file (trustmybot/tmb#98). tmb builds no
// lock of its own and relies on git: a task start names the open tasks that share a file, as
// information; when two tasks change different lines of it, both fold; when they change the same
// lines, git stops the second fold, its close is refused naming the file, and that task stays open
// to settle it. Scripted as tool calls through the tool server, with no model.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const FEATURE = "feat/shared";
const SHARED = "src/shared.ts";
const ORIGINAL = "export const one = 1;\nexport const two = 2;\nexport const three = 3;\nexport const four = 4;\nexport const five = 5;\n";

const { git, tmbJson, setUpProject, commitFile, connect, cleanup, tool } = tmbProcesses("tmb-shared-files-");
afterAll(cleanup);

describe("two open tasks share a file", () => {
  test("both start, the second told of the first; different lines both fold; the same lines stop the later close", async () => {
    const project = setUpProject("true", { "README.md": "hello\n", [SHARED]: ORIGINAL });
    const issue = tool(project, "issue_create", { title: "Two changes to one file" });
    const client = await connect(project);
    try {
      await callJson(client, "feature_start", { name: FEATURE });
      const start = (intent: string, files: string[]) => callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent, files, criteria: ["SC1: done"] });

      const a = await start("Change line one", [SHARED]);
      expect(a.sharedFiles).toEqual([]);
      const b = await start("Change line five", ["src"]);
      expect(b.sharedFiles).toEqual([{ task: a.id, title: "Change line one", file: "src", theirs: SHARED }]);
      expect((await callJson(client, "task_list", {})).map((task: any) => task.id)).toEqual([a.id, b.id]);

      // Different lines of the same file: git merges them, so both fold.
      commitFile(a.worktree, SHARED, ORIGINAL.replace("one = 1", "one = 10"), "change one");
      commitFile(b.worktree, SHARED, ORIGINAL.replace("five = 5", "five = 50"), "change five");
      await callJson(client, "task_close", { id: a.id, role: "worker" });
      const bClosed = await callJson(client, "task_close", { id: b.id, role: "worker" });
      expect(bClosed.fold.rebased).toBe(true);
      const both = git(project, "show", `${FEATURE}:${SHARED}`);
      expect(both).toContain("one = 10");
      expect(both).toContain("five = 50");

      // The same line: the later close is refused, naming the file, and its task stays open to settle it.
      const c = await start("Change line three to 30", [SHARED]);
      const d = await start("Change line three to 300", [SHARED]);
      expect(d.sharedFiles.map((shared: any) => shared.task)).toEqual([c.id]);
      commitFile(c.worktree, SHARED, both.replace("three = 3", "three = 30") + "\n", "three is 30");
      const dHead = commitFile(d.worktree, SHARED, both.replace("three = 3", "three = 300") + "\n", "three is 300");
      await callJson(client, "task_close", { id: c.id, role: "worker" });
      const refused = await callRefused(client, "task_close", { id: d.id, role: "worker" });
      expect(refused).toContain("conflicts in");
      expect(refused).toContain(SHARED);
      expect(await callJson(client, "task_brief", { id: d.id })).toMatchObject({ state: "open", commitSha: null });
      expect(git(d.worktree, "rev-parse", "HEAD")).toBe(dHead);
      expect(readFileSync(path.join(d.worktree, SHARED), "utf8")).toContain("three = 300");
    } finally {
      await client.close();
    }
  });
});
