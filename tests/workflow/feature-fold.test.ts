// Workflow simulation: agile mode's feature branch, scripted as the tool calls a planner and a
// worker make through the tool server, with no model. The planner starts a feature branch, then
// a code task a worker closes and a docs task the planner writes and closes itself; each close
// folds the task into the feature branch, which ends up holding both commits in order.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, tmbProcesses } from "../integration/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const FEATURE = "feat/greeting";
const CODE_FILE = "src/greet.ts";
const DOCS_FILE = "docs/greeting.md";

const { git, tmbJson, setUpProject, connect, cleanup } = tmbProcesses("tmb-workflow-feature-");
afterAll(cleanup);

/** Writes and commits one file in the worktree, as the one doing the task would; returns the commit. */
function commitFile(worktree: string, file: string, text: string, message: string): string {
  mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  writeFileSync(path.join(worktree, file), text);
  git(worktree, "add", file);
  git(worktree, "commit", "-q", "-m", message);
  return git(worktree, "rev-parse", "HEAD");
}

describe("a feature branch collects its tasks", () => {
  test("a code task and then a docs task, each started and closed in turn, fold into the feature branch in order", async () => {
    const project = setUpProject("true");
    const base = git(project, "rev-parse", "main");
    const issue = tmbJson(["issue", "create", "Greet the user"], project);
    const client = await connect(project);
    try {
      const feature = await callJson(client, "feature_start", { name: FEATURE });
      expect(feature).toMatchObject({ name: FEATURE, baseCommit: base, state: "open", tasks: [] });

      // 1. A code task: the planner starts it, a worker commits and closes it.
      const code = await callJson(client, "task_start", {
        issue_id: issue.id,
        kind: "code",
        intent: "Add the greeting",
        files: ["src"],
        criteria: ["SC1: greet() exists"],
        checks: [`test -f ${CODE_FILE}`],
      });
      expect(code.brief).toMatchObject({ feature: FEATURE, kind: "code", baseCommit: base });
      const codeCommit = commitFile(code.worktree, CODE_FILE, "export const greet = () => 'hi';\n", "add greet");
      const codeClosed = await callJson(client, "task_close", { id: code.id, role: "worker" });
      expect(codeClosed.fold).toEqual({ feature: FEATURE, from: base, to: codeCommit, rebased: false });
      expect(codeClosed.push).toMatchObject({ result: "skipped" });
      expect(git(project, "rev-parse", FEATURE)).toBe(codeCommit);
      expect(existsSync(code.worktree)).toBe(false);

      // 2. A docs task, cut from the feature branch's new tip: the planner writes it and closes it itself.
      const docs = await callJson(client, "task_start", {
        issue_id: issue.id,
        kind: "docs",
        intent: "Document the greeting",
        files: ["docs"],
        criteria: ["SC1: the greeting is documented"],
        checks: [`test -f ${DOCS_FILE}`, `test -f ${CODE_FILE}`],
      });
      expect(docs.brief).toMatchObject({ feature: FEATURE, kind: "docs", baseCommit: codeCommit });
      const docsCommit = commitFile(docs.worktree, DOCS_FILE, "# Greeting\n\nCall greet().\n", "document greet");
      const docsClosed = await callJson(client, "task_close", { id: docs.id });
      expect(docsClosed.brief).toMatchObject({ state: "closed", kind: "docs", reviewMode: "agile", commitSha: docsCommit });

      // The feature branch holds both commits, the code first, on top of the base it was cut from.
      expect(git(project, "rev-list", `${base}..${FEATURE}`).split("\n")).toEqual([docsCommit, codeCommit]);
      expect(git(project, "rev-parse", "main")).toBe(base);
      expect(await callJson(client, "feature_list", {})).toEqual([{ ...feature, tasks: [code.id, docs.id] }]);
      expect(await callJson(client, "task_list", { state: "closed" })).toMatchObject([
        { id: code.id, kind: "code", feature: FEATURE, commitSha: codeCommit },
        { id: docs.id, kind: "docs", feature: FEATURE, commitSha: docsCommit },
      ]);
    } finally {
      await client.close();
    }
  });
});
