// Workflow simulation: Truest mode, scripted as the calls a planner, a worker, a reviewer and the
// Human make, with no model. Every task is reviewed on its own commit before its own pull request
// opens: a task cannot be pushed unreviewed, a fail reopens it, a pass lets task_pr push it, and a
// base branch that moved is rebased onto with the review carried over only when the patch is the
// same. A bare repository stands in for origin and a fake `gh` on PATH for GitHub.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../lib/tmb-processes.ts";
import { fakeGh } from "../lib/fake-gh.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { scratch, env, git, tmb, human, tmbJson, setUpProject, commitFile, startSubagent, stopSubagent, connect, sessionStart, cleanup } =
  tmbProcesses("tmb-workflow-truest-");
afterAll(cleanup);

// With the flag file present, the next \`gh pr create\` fails as if the pull request were already open.
const ghFailOnce = path.join(scratch, "gh-fail-once");
const { bin: fakeBin, log: ghLog } = fakeGh(scratch, {
  answer: `if [ "$1 $2" = "pr create" ] && [ -f '${ghFailOnce}' ]; then rm '${ghFailOnce}'; echo "a pull request already exists" >&2; exit 1; fi\necho "https://github.com/example/project/pull/9"`,
});
env.PATH = `${fakeBin}${path.delimiter}${env.PATH}`;

const LINES = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

/** A truest project with an origin, its checks `true`. */
function truestProject(): string {
  const project = setUpProject("true", { "README.md": "hello\n", "src/lines.txt": LINES }, { origin: true });
  tmb(["init"], project);
  human(["onboard", "--base", "main", "--review-mode", "truest", "--check", "true", "--yes"], project);
  return project;
}

/** Someone else's change lands on origin's base branch, through a clone of its own with no hook. */
function landOnOrigin(project: string, file: string, text: string): string {
  const origin = git(project, "remote", "get-url", "origin");
  const other = mkdtempSync(path.join(scratch, "other-"));
  git(other, "clone", "-q", "-b", "main", origin, ".");
  git(other, "config", "user.name", "o");
  git(other, "config", "user.email", "o@example.com");
  return commitAndPush(other, file, text);
}

function commitAndPush(clone: string, file: string, text: string): string {
  writeFileSync(path.join(clone, file), text);
  git(clone, "commit", "-q", "-am", `change ${file}`);
  git(clone, "push", "-q", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
}

/** A push typed by hand, through git's pre-push hook as any push goes. */
function handPush(cwd: string, ref: string): { status: number | null; stderr: string } {
  const result = spawnSync("git", ["push", "origin", ref], { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stderr: result.stderr };
}

describe("Truest mode: every task is reviewed before its push", () => {
  test("a task cannot be pushed unreviewed; fail reopens, pass opens its own pull request with the review carried over a rebase", async () => {
    const project = truestProject();
    const issue = tmbJson(["issue", "create", "Fix the lines"], project);
    const client = await connect(project);
    const startTask = (intent: string, files = ["src"]) =>
      callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent, files, criteria: ["SC1: it works"] });
    try {
      // 1. No feature branches in truest mode: a task is cut from the base branch.
      expect(await callRefused(client, "feature_start", { name: "feat/x" })).toContain("truest");
      const main = git(project, "rev-parse", "main");
      const task = await startTask("Fix line two");
      expect(task.brief.review).toMatchObject({ from: main, to: null, covered: false, reviewLine: `review_task=${task.id}` });
      expect(git(task.worktree, "merge-base", "HEAD", "main")).toBe(main);

      // 2. The checks pass on close and the task waits in review; nothing is pushed.
      const first = commitFile(task.worktree, "src/lines.txt", LINES.replace("two", "TWO"), "fix two");
      const closed = await callJson(client, "task_close", { id: task.id, role: "worker" });
      expect(closed.next).toContain(`review_task=${task.id}`);
      let brief = await callJson(client, "task_brief", { id: task.id });
      expect(brief).toMatchObject({ state: "in_review", review: { from: main, to: first, covered: false } });
      expect(git(project, "ls-remote", "origin", task.branch)).toBe("");
      expect(sessionStart(project)).toContain(`Tasks in review`);

      // 3. Unreviewed, it cannot leave: not by task_pr, not by a push typed by hand.
      expect(await callRefused(client, "task_pr", { id: task.id, title: "Fix" })).toContain("no reviewer has reviewed it");
      const pushed = handPush(task.worktree, `HEAD:refs/heads/${task.branch}`);
      expect(pushed.status).not.toBe(0);
      expect(pushed.stderr).toContain("tmb task waive");
      expect(git(project, "ls-remote", "origin", task.branch)).toBe("");
      // A remote-tracking ref moved by hand does not make the commit count as already on origin.
      git(project, "update-ref", "refs/remotes/origin/sneak", first);
      expect(handPush(task.worktree, `HEAD:refs/heads/${task.branch}`).status).not.toBe(0);
      // A branch of the Human's own, with no task's commit, pushes freely; onto the base branch it is refused.
      git(project, "switch", "-q", "-c", "human/notes");
      commitFile(project, "NOTES.md", "mine\n", "notes");
      expect(handPush(project, "human/notes").status).toBe(0);
      const ontoBase = handPush(project, "human/notes:refs/heads/main");
      expect(ontoBase.status).not.toBe(0);
      expect(ontoBase.stderr).toContain("onto the base branch main");
      git(project, "switch", "-q", "main");

      // 4. Only a reviewer the host started records a verdict; a fail reopens the task.
      const fail = { id: task.id, commit: first, verdict: "fail", blocking: ["src/lines.txt:2 shouts"] };
      expect(await callRefused(client, "task_review", { ...fail, role: "reviewer" })).toContain("no reviewer run is open");
      expect(startSubagent(project, "reviewer", `${brief.review.reviewLine}\nReview the task.`)).toBeNull();
      expect(await callRefused(client, "task_review", { ...fail, role: "planner" })).toContain("for the reviewer");
      expect(await callJson(client, "task_review", { ...fail, role: "reviewer" })).toMatchObject({ state: "open", covered: false });
      stopSubagent(project, "reviewer");
      expect((await callJson(client, "task_brief", { id: task.id })).state).toBe("open");
      expect(await callRefused(client, "task_pr", { id: task.id, title: "Fix" })).toContain("not in review");

      // 5. Rework in the same worktree, close again, and the reviewer passes the new commit only.
      const second = commitFile(task.worktree, "src/lines.txt", LINES.replace("two", "2"), "fix two quietly");
      await callJson(client, "task_close", { id: task.id, role: "worker" });
      expect(startSubagent(project, "reviewer", brief.review.reviewLine)).toBeNull();
      expect(await callRefused(client, "task_review", { id: task.id, commit: first, verdict: "pass", role: "reviewer" })).toContain(`in review at ${second}`);
      expect(await callJson(client, "task_review", { id: task.id, commit: second.slice(0, 10), verdict: "pass", role: "reviewer" })).toMatchObject({
        state: "in_review",
        covered: true,
      });
      stopSubagent(project, "reviewer");
      brief = await callJson(client, "task_brief", { id: task.id });
      expect(brief.review).toMatchObject({ covered: true, coveredBy: "review", to: second });

      // 6. The base moves, apart from the task's lines: task_pr rebases, the patch is the same, the review carries over.
      const moved = landOnOrigin(project, "README.md", "hello again\n");
      expect(await callRefused(client, "task_pr", { id: task.id, title: "Fix", role: "worker" })).toContain("for the planner");
      const pr = await callJson(client, "task_pr", { id: task.id, title: "Fix line two", body: "Quiet fix." });
      expect(pr).toMatchObject({ url: "https://github.com/example/project/pull/9", base: "main", branch: task.branch, coveredBy: "review", rebasedOnto: moved });
      expect(pr.commit).not.toBe(second);
      expect(git(project, "ls-remote", "origin", `refs/heads/${task.branch}`)).toStartWith(pr.commit);
      const ghCall = readFileSync(ghLog, "utf8");
      expect(ghCall).toContain(`pr create --base main --head ${task.branch} --title Fix line two --body Quiet fix.`);
      expect(ghCall).toContain(`Reviewed by the tmb reviewer: pass at ${second}, carried to ${pr.commit} by a rebase onto ${moved}`);
      expect(await callJson(client, "task_brief", { id: task.id })).toMatchObject({ state: "closed", review: { prUrl: pr.url } });
    } finally {
      await client.close();
    }
  }, 60_000);

  test("a changed patch needs a new review, a conflict reopens the task, and the Human's waiver lets a task through", async () => {
    const project = truestProject();
    const issue = tmbJson(["issue", "create", "More lines"], project);
    const client = await connect(project);
    const startTask = (intent: string, files = ["src"]) =>
      callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent, files, criteria: ["SC1: it works"] });
    const passAt = async (id: string, commit: string) => {
      expect(startSubagent(project, "reviewer", `review_task=${id}`)).toBeNull();
      await callJson(client, "task_review", { id, commit, verdict: "pass", role: "reviewer" });
      stopSubagent(project, "reviewer");
    };
    try {
      // A change two lines away rebases cleanly but changes the patch's context: the review does not carry over.
      const near = await startTask("Change line two");
      const nearCommit = commitFile(near.worktree, "src/lines.txt", LINES.replace("two", "TWO"), "two");
      await callJson(client, "task_close", { id: near.id, role: "worker" });
      await passAt(near.id, nearCommit);
      const movedNear = landOnOrigin(project, "src/lines.txt", LINES.replace("four", "FOUR"));
      expect(await callRefused(client, "task_pr", { id: near.id, title: "Two" })).toContain("changed its patch");
      const nearBrief = await callJson(client, "task_brief", { id: near.id });
      expect(nearBrief).toMatchObject({ state: "in_review", review: { from: movedNear, covered: false } });
      expect(nearBrief.review.to).not.toBe(nearCommit);
      await passAt(near.id, nearBrief.review.to);
      expect(await callJson(client, "task_pr", { id: near.id, title: "Two" })).toMatchObject({ commit: nearBrief.review.to, rebasedOnto: null });

      // A conflict with the moved base reopens the task for rework.
      const clash = await startTask("Change line six");
      const clashCommit = commitFile(clash.worktree, "src/lines.txt", LINES.replace("four", "FOUR").replace("six", "SIX"), "six");
      await callJson(client, "task_close", { id: clash.id, role: "worker" });
      await passAt(clash.id, clashCommit);
      landOnOrigin(project, "src/lines.txt", LINES.replace("four", "FOUR").replace("six", "6"));
      expect(await callRefused(client, "task_pr", { id: clash.id, title: "Six" })).toContain("open again");
      expect((await callJson(client, "task_brief", { id: clash.id })).state).toBe("open");
      expect(git(clash.worktree, "rev-parse", "HEAD")).toBe(clashCommit);

      // The Human waives a task's review from the command line; an agent cannot.
      const waived = await startTask("Add a file", ["docs"]);
      const waivedCommit = commitFile(waived.worktree, "docs/new.txt", "new\n", "new");
      await callJson(client, "task_close", { id: waived.id, role: "worker" });
      expect(await callRefused(client, "task_waive", { id: waived.id, reason: "tiny", role: "planner" })).toContain("only the Human waives");
      expect(human(["task", "waive", waived.id, "--reason", "A file the Human read"], project)).toContain(`at ${waivedCommit}`);
      // gh pr create fails because the pull request is already open: task_pr takes that one.
      writeFileSync(ghFailOnce, "");
      expect(tmb(["task", "pr", waived.id, "--title", "New file"], project)).toContain("https://github.com/example/project/pull/9");
      expect(readFileSync(ghLog, "utf8")).toContain(`pr list --head ${waived.branch} --state open`);
      expect(readFileSync(ghLog, "utf8")).toContain(`Review waived by the Human at ${waivedCommit}: A file the Human read`);
      expect(git(project, "ls-remote", "origin", `refs/heads/${waived.branch}`)).toStartWith(waivedCommit);

      // When the base branch already holds the same change, the task closes with no pull request and frees its files.
      const twin = await startTask("Add a guide", ["guide"]);
      const twinCommit = commitFile(twin.worktree, "guide/a.txt", "guide\n", "guide");
      await callJson(client, "task_close", { id: twin.id, role: "worker" });
      await passAt(twin.id, twinCommit);
      const origin = git(project, "remote", "get-url", "origin");
      const other = mkdtempSync(path.join(scratch, "twin-"));
      git(other, "clone", "-q", "-b", "main", origin, ".");
      mkdirSync(path.join(other, "guide"));
      writeFileSync(path.join(other, "guide/a.txt"), "guide\n");
      git(other, "add", ".");
      git(other, "commit", "-q", "-m", "the same guide, landed apart");
      git(other, "push", "-q", "origin", "main");
      expect(await callRefused(client, "task_pr", { id: twin.id, title: "Guide" })).toContain("already holds the change");
      expect((await callJson(client, "task_brief", { id: twin.id })).state).toBe("closed");
      await startTask("Edit the guide again", ["guide"]);
    } finally {
      await client.close();
    }
  }, 60_000);
});
