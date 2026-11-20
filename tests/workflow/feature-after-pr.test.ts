// Workflow simulation: a feature branch after its pull request (trustmybot/tmb#131,
// trustmybot/tmb#152). A pull request closed without a merge leaves the branch closed: it takes a
// new pull request, or a rework task that reopens it. A merged branch is final. A fake `gh` on PATH
// stands in for GitHub, answering from files the test writes.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../integration/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { scratch, env, tmb, tmbJson, setUpProject, commitFile, connect, cleanup } = tmbProcesses("tmb-workflow-after-pr-");
afterAll(cleanup);

const ghDir = path.join(scratch, "gh-state");
const ghLog = path.join(scratch, "gh.log");
const fakeBin = path.join(scratch, "fake-gh");
mkdirSync(ghDir, { recursive: true });
mkdirSync(fakeBin, { recursive: true });
// `gh pr view` prints the state in gh-state/view; `gh pr create` prints gh-state/create, or fails
// when that file is missing; `gh pr list` prints gh-state/existing when there is one.
writeFileSync(
  path.join(fakeBin, "gh"),
  `#!/bin/sh
printf '%s\\n' "$*" >> '${ghLog}'
case "$1 $2" in
  "pr view") cat '${ghDir}/view' ;;
  "pr create") [ -f '${ghDir}/create' ] || { echo "a pull request for this branch already exists" >&2; exit 1; }; cat '${ghDir}/create' ;;
  "pr list") [ -f '${ghDir}/existing' ] && cat '${ghDir}/existing' ;;
  *) exit 0 ;;
esac
`,
  { mode: 0o755 },
);
env.PATH = `${fakeBin}${path.delimiter}${env.PATH}`;

function github(answers: { view?: string; create?: string | null; existing?: string | null }): void {
  for (const [name, value] of Object.entries(answers)) {
    const file = path.join(ghDir, name);
    if (value === null) rmSync(file, { force: true });
    else if (value !== undefined) writeFileSync(file, `${value}\n`);
  }
}

const PR_1 = "https://github.com/example/project/pull/1";
const PR_2 = "https://github.com/example/project/pull/2";
const PR_3 = "https://github.com/example/project/pull/3";

describe("a feature branch after its pull request", () => {
  test("closed takes a new pull request or a rework task; a pull request already open is reused; merged is final", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    const issue = tmbJson(["issue", "create", "Greet the user"], project);
    const client = await connect(project, "claude-code");
    const brief = () => callJson(client, "feature_brief", { feature: "feat/greet" });
    const list = async () => (await callJson(client, "feature_list", {})).find((f: { name: string }) => f.name === "feat/greet");
    try {
      await callJson(client, "feature_start", { name: "feat/greet" });
      const first = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Add greet", files: ["src"], criteria: ["SC1: it greets"] });
      const tip = commitFile(first.worktree, "src/greet.ts", "export const greet = () => 'hi';\n", "add greet");
      await callJson(client, "task_close", { id: first.id, role: "worker" });
      tmb(["feature", "waive", "feat/greet", "--reason", "The Human read it"], project);

      // 1. The first pull request opens, then closes without a merge.
      github({ create: PR_1, view: "OPEN" });
      await callJson(client, "feature_pr", { feature: "feat/greet", title: "Greet" });
      github({ view: "CLOSED" });
      expect(await list()).toMatchObject({ state: "closed" });

      // 2. A new pull request opens on the closed branch; its tip is still covered by the waiver.
      github({ create: PR_2, view: "OPEN" });
      expect(await callJson(client, "feature_pr", { feature: "feat/greet", title: "Greet, again" })).toMatchObject({ url: PR_2, tip });
      expect(await brief()).toMatchObject({ state: "pr_open", prUrl: PR_2 });

      // 3. Closed again: a rework task reopens the branch, as the planner.
      github({ view: "CLOSED" });
      expect(await list()).toMatchObject({ state: "closed" });
      const rework = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", feature: "feat/greet", intent: "Rework", files: ["src"], criteria: ["SC1: it greets by name"] });
      expect(await brief()).toMatchObject({ state: "open" });
      const reworked = commitFile(rework.worktree, "src/greet.ts", "export const greet = (name) => 'hi ' + name;\n", "greet by name");
      await callJson(client, "task_close", { id: rework.id, role: "worker" });
      expect(await callRefused(client, "feature_pr", { feature: "feat/greet", title: "Greet" })).toContain(`at its tip ${reworked}`);
      tmb(["feature", "waive", "feat/greet", "--reason", "The Human read the rework"], project);

      // 4. The Human reopened a pull request on GitHub: gh refuses a second, and tmb records the open one.
      github({ create: null, existing: PR_3, view: "OPEN" });
      expect(await callJson(client, "feature_pr", { feature: "feat/greet", title: "Greet" })).toMatchObject({ url: PR_3, tip: reworked });
      expect(await brief()).toMatchObject({ state: "pr_open", prUrl: PR_3 });
      expect(readFileSync(ghLog, "utf8")).toContain("pr list --head feat/greet --state open");

      // 5. Merged is final: no task and no pull request.
      github({ view: "MERGED" });
      expect(await list()).toMatchObject({ state: "merged" });
      expect(await callRefused(client, "task_start", { issue_id: issue.id, kind: "code", feature: "feat/greet", intent: "More", files: ["src"], criteria: ["SC1: x"] })).toContain(
        "is merged",
      );
      expect(await callRefused(client, "feature_pr", { feature: "feat/greet", title: "Greet" })).toContain("is merged");
    } finally {
      await client.close();
    }
  }, 60_000);
});
