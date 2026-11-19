// Workflow simulation: a docs task is checked by file type at its close, scripted as the tool
// calls a planner makes through the tool server, with no model. A docs task whose commits touch a
// source file cannot close, and the refusal names the file; one whose change touches only docs closes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../integration/tmb-processes.ts";

const { git, tmbJson, setUpProject, connect, cleanup } = tmbProcesses("tmb-workflow-docs-check-");
afterAll(cleanup);

function commitFiles(worktree: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    writeFileSync(path.join(worktree, file), text);
    git(worktree, "add", file);
  }
  git(worktree, "commit", "-q", "-m", message);
  return git(worktree, "rev-parse", "HEAD");
}

describe("a docs task is checked by file type at its close", () => {
  test("touching a source file is refused and named; touching only docs closes", async () => {
    const project = setUpProject("true");
    const issue = tmbJson(["issue", "create", "Document the greeting"], project);
    const client = await connect(project);
    try {
      await callJson(client, "feature_start", { name: "feat/greeting-docs" });
      const docs = await callJson(client, "task_start", {
        issue_id: issue.id,
        kind: "docs",
        intent: "Document the greeting",
        files: ["."],
        criteria: ["SC1: the greeting is documented"],
      });

      // 1. The commit slips in a source file next to the docs: the close is refused, naming it, and the task stays open.
      commitFiles(docs.worktree, { "docs/greeting.md": "# Greeting\n", "src/greet.ts": "export const greet = () => 'hi';\n" }, "docs and code");
      const refused = await callRefused(client, "task_close", { id: docs.id });
      expect(refused).toContain(`task ${docs.id} is a docs task, but its change touches files written in a programming language`);
      expect(refused).toContain("src/greet.ts (TypeScript)");
      expect(refused).not.toContain("docs/greeting.md");
      expect(await callJson(client, "task_brief", { id: docs.id })).toMatchObject({ state: "open", commitSha: null });

      // 2. The source file is taken out again, and HTML and JSON added: the task's change is docs, markup and data, so it closes.
      git(docs.worktree, "rm", "-q", "src/greet.ts");
      const clean = commitFiles(docs.worktree, { "docs/site.html": "<p>hi</p>\n", "docs/greeting.json": "{}\n" }, "docs only");
      const closed = await callJson(client, "task_close", { id: docs.id });
      expect(closed.brief).toMatchObject({ state: "closed", kind: "docs", commitSha: clean });

      // 3. A code task touching the same kind of file is never checked this way.
      const code = await callJson(client, "task_start", {
        issue_id: issue.id,
        kind: "code",
        intent: "Add the greeting",
        files: ["src"],
        criteria: ["SC1: greet() exists"],
      });
      const codeCommit = commitFiles(code.worktree, { "src/greet.ts": "export const greet = () => 'hi';\n" }, "add greet");
      const codeClosed = await callJson(client, "task_close", { id: code.id, role: "worker" });
      expect(codeClosed.brief).toMatchObject({ state: "closed", kind: "code", commitSha: codeCommit });
    } finally {
      await client.close();
    }
  });
});
