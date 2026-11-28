// Workflow simulation: a feature branch after its pull request (trustmybot/tmb#131,
// trustmybot/tmb#152, trustmybot/tmb#168). While the pull request is open the branch takes fix
// tasks, and only the reviewed new tip is pushed to it. A pull request closed without a merge
// leaves the branch closed: it takes a new pull request, or a rework task that reopens it. A
// merged branch is final. A fake `gh` on PATH
// stands in for GitHub, answering from files the test writes.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../lib/tmb-processes.ts";
import { fakeGh } from "../lib/fake-gh.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { scratch, env, git, tmb, human, tmbJson, setUpProject, commitFile, connect, cleanup } = tmbProcesses("tmb-workflow-after-pr-");
afterAll(cleanup);

const ghDir = path.join(scratch, "gh-state");
mkdirSync(ghDir, { recursive: true });
// `gh pr view` prints the state in gh-state/view; `gh pr create` prints gh-state/create, or fails
// when that file is missing; `gh pr list` prints gh-state/existing when there is one.
const { bin: fakeBin, log: ghLog } = fakeGh(scratch, {
  answer: `case "$1 $2" in
  "pr view") cat '${ghDir}/view' ;;
  "pr create") [ -f '${ghDir}/create' ] || { echo "a pull request for this branch already exists" >&2; exit 1; }; cat '${ghDir}/create' ;;
  "pr list") [ -f '${ghDir}/existing' ] && cat '${ghDir}/existing' ;;
  *) exit 0 ;;
esac`,
});
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
      human(["feature", "waive", "feat/greet", "--reason", "The Human read it"], project);

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
      human(["feature", "waive", "feat/greet", "--reason", "The Human read the rework"], project);

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

  test("a branch whose pull request is open takes a fix task; the reviewed new tip updates the same pull request", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    const issue = tmbJson(["issue", "create", "Wave"], project);
    const client = await connect(project, "claude-code");
    const brief = () => callJson(client, "feature_brief", { feature: "feat/wave" });
    const onOrigin = () => git(project, "ls-remote", "origin", "refs/heads/feat/wave").split(/\s/)[0];
    try {
      await callJson(client, "feature_start", { name: "feat/wave" });
      const first = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Add wave", files: ["src"], criteria: ["SC1: it waves"] });
      commitFile(first.worktree, "src/wave.ts", "export const wave = () => 'o/';\n", "add wave");
      await callJson(client, "task_close", { id: first.id, role: "worker" });
      human(["feature", "waive", "feat/wave", "--reason", "The Human read it"], project);
      github({ create: PR_1, existing: null, view: "OPEN" });
      await callJson(client, "feature_pr", { feature: "feat/wave", title: "Wave" });
      const opened = onOrigin();
      const creates = () => readFileSync(ghLog, "utf8").split("\n").filter((line) => line.startsWith("pr create")).length;
      const createdBefore = creates();

      // 1. A fix task starts on the branch, which stays pr_open; the unnamed default still picks only open branches.
      expect(await callRefused(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Fix", files: ["src"], criteria: ["SC1: x"] })).toContain("no feature branch is open");
      const fix = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", feature: "feat/wave", intent: "Fix the wave", files: ["src"], criteria: ["SC1: it waves both hands"] });
      expect(await brief()).toMatchObject({ state: "pr_open", prUrl: PR_1 });

      // 2. It folds as any task does, but the unreviewed tip is not pushed to the pull request.
      const fixed = commitFile(fix.worktree, "src/wave.ts", "export const wave = () => '\\o/';\n", "wave both hands");
      const closed = await callJson(client, "task_close", { id: fix.id, role: "worker" });
      expect(closed.push).toMatchObject({ result: "skipped" });
      expect(closed.push.detail).toContain("pull request of feat/wave is open");
      expect(await brief()).toMatchObject({ state: "pr_open", tip: fixed, covered: false });
      expect(onOrigin()).toBe(opened);

      // 3. The new tip needs a review or a waiver; then feature_pr pushes it to the same pull request and opens none.
      expect(await callRefused(client, "feature_pr", { feature: "feat/wave", title: "Wave" })).toContain(`at its tip ${fixed}`);
      human(["feature", "waive", "feat/wave", "--reason", "The Human read the fix"], project);
      expect(await callJson(client, "feature_pr", { feature: "feat/wave", title: "Wave" })).toMatchObject({ url: PR_1, tip: fixed, coveredBy: "waiver" });
      expect(onOrigin()).toBe(fixed);
      expect(creates()).toBe(createdBefore);
      expect(await brief()).toMatchObject({ state: "pr_open", prUrl: PR_1 });
    } finally {
      await client.close();
    }
  }, 60_000);

  test("a task open when the pull request opened folds without a push; its tip waits for a review (trustmybot/tmb#181)", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    const issue = tmbJson(["issue", "create", "Nod"], project);
    const client = await connect(project, "claude-code");
    const onOrigin = () => git(project, "ls-remote", "origin", "refs/heads/feat/nod").split(/\s/)[0];
    try {
      await callJson(client, "feature_start", { name: "feat/nod" });
      const first = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Add nod", files: ["src/nod.ts"], criteria: ["SC1: it nods"] });
      commitFile(first.worktree, "src/nod.ts", "export const nod = () => 'yes';\n", "add nod");
      await callJson(client, "task_close", { id: first.id, role: "worker" });
      const late = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Add shake", files: ["src/shake.ts"], criteria: ["SC1: it shakes"] });
      human(["feature", "waive", "feat/nod", "--reason", "The Human read it"], project);
      github({ create: PR_1, existing: null, view: "OPEN" });
      await callJson(client, "feature_pr", { feature: "feat/nod", title: "Nod" });
      const opened = onOrigin();

      commitFile(late.worktree, "src/shake.ts", "export const shake = () => 'no';\n", "add shake");
      const closed = await callJson(client, "task_close", { id: late.id, role: "worker" });
      expect(closed.push).toMatchObject({ result: "skipped" });
      expect(onOrigin()).toBe(opened);
      expect(await callJson(client, "feature_brief", { feature: "feat/nod" })).toMatchObject({ state: "pr_open", covered: false });
      expect(await callRefused(client, "feature_pr", { feature: "feat/nod", title: "Nod" })).toContain("opens only after the reviewer passes");
    } finally {
      await client.close();
    }
  }, 60_000);
});
