// Workflow simulation: a docs task is checked by file type at its close, scripted as the tool
// calls a planner makes through the tool server, with no model. A docs task whose commits touch a
// file whose type is not on the docs list cannot close, and the refusal names the file; one whose
// change touches only listed types closes.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { git, tmbJson, setUpProject, connect, cleanup, tool } = tmbProcesses("tmb-workflow-docs-check-");
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
    const issue = tool(project, "issue_create", { title: "Document the greeting" });
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
      expect(refused).toContain(`task ${docs.id} is a docs task, but its change touches files that are not prose, data or images`);
      expect(refused).toContain("src/greet.ts (TypeScript)");
      expect(refused).not.toContain("docs/greeting.md");
      expect(await callJson(client, "task_brief", { id: docs.id })).toMatchObject({ state: "open", commitSha: null });

      // 2. Markup and query files that Linguist does not call programming are refused too: they are not on the list (trustmybot/tmb#185).
      git(docs.worktree, "rm", "-q", "src/greet.ts");
      commitFiles(docs.worktree, { "docs/site.html": "<p>hi</p>\n", "web/App.vue": "<template/>\n", "web/Card.svelte": "<p/>\n", "db/q.sql": "select 1;\n" }, "markup");
      const markup = await callRefused(client, "task_close", { id: docs.id });
      for (const file of ["docs/site.html", "web/App.vue", "web/Card.svelte", "db/q.sql"]) expect(markup).toContain(file);
      expect(markup).not.toContain("docs/greeting.md");
      expect(await callJson(client, "task_brief", { id: docs.id })).toMatchObject({ state: "open", commitSha: null });

      // 3. Those are taken out again, and prose, data, an image and a license added: the change is on the list, so it closes.
      git(docs.worktree, "rm", "-q", "docs/site.html", "web/App.vue", "web/Card.svelte", "db/q.sql");
      const clean = commitFiles(
        docs.worktree,
        { "docs/greeting.json": "{}\n", "docs/greeting.yaml": "a: 1\n", "docs/flow.svg": "<svg/>\n", LICENSE: "MIT\n" },
        "docs only",
      );
      const closed = await callJson(client, "task_close", { id: docs.id });
      expect(closed.brief).toMatchObject({ state: "closed", kind: "docs", commitSha: clean });

      // 4. A code task touching the same kind of file is never checked this way.
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
