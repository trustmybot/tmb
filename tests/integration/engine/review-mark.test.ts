// The mark on GitHub, against a stand-in for GitHub: a pass, a fail and a waiver each set the
// commit status tmb/review on the reviewed commit; a mark that could not be sent is recorded and
// sent at the next occasion; a pull request and `tmb onboard` say whether the base branch
// requires the mark. The project's origin has a GitHub address that git rewrites to a bare repository.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { githubStandIn, PR_URL } from "../../lib/github-stand-in.ts";
import { callJson, tmbProcesses } from "../../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { scratch, env, git, run, tmb, human, tmbJson, setUpProject, commitFile, startSubagent, stopSubagent, connect, cleanup } = tmbProcesses("tmb-review-mark-");
afterAll(cleanup);
const github = githubStandIn(scratch, env, git);

const PASSED = { state: "success", context: "tmb/review", description: "Passed tmb's review" };

/** A truest project whose origin is the stand-in's repository; returns it and the bare repository behind it. */
function truestProject(): { project: string; bare: string } {
  const project = setUpProject("true", undefined, { origin: true });
  human(["onboard", "--base", "main", "--review-mode", "truest", "--check", "true", "--yes"], project);
  const bare = git(project, "config", "--get", "remote.origin.url");
  github.point(project);
  return { project, bare };
}

type Closed = { id: string; sha: string; branch: string };

/** Starts a truest task on its own file, commits it and closes it, so it waits in review. */
async function closedTask(client: Client, issue: string, file: string): Promise<Closed> {
  const task = await callJson(client, "task_start", { issue_id: issue, kind: "code", intent: `Add ${file}`, files: [file], criteria: ["SC1: it is there"] });
  const sha = commitFile(task.worktree, file, `${file}\n`, `add ${file}`);
  await callJson(client, "task_close", { id: task.id, role: "worker" });
  return { id: task.id, sha, branch: task.branch };
}

async function review(client: Client, project: string, task: Closed, verdict: "pass" | "fail") {
  expect(startSubagent(project, "reviewer", `review_task=${task.id}`)).toBeNull();
  const blocking = verdict === "fail" ? { blocking: ["x.txt:1 wrong"] } : {};
  const result = await callJson(client, "task_review", { id: task.id, commit: task.sha, verdict, role: "reviewer", ...blocking });
  stopSubagent(project, "reviewer");
  return result;
}

/** Puts a task's branch on origin by hand, past git's hooks, as if someone pushed it: GitHub then has its commit. */
function onOrigin(bare: string, project: string, branch: string): void {
  git(bare, "fetch", "-q", project, `+refs/heads/${branch}:refs/heads/${branch}`);
}

describe("the mark on GitHub, in truest mode", () => {
  test("a pass, a fail and a waiver each end up as the mark on the reviewed commit, once GitHub has the commit", async () => {
    const { project, bare } = truestProject();
    const issue = tmbJson(["issue", "create", "Marks"], project).id as string;
    const client = await connect(project);
    try {
      // The reviewed commit is not on GitHub until task_pr pushes it: GitHub refuses the mark, which is recorded unsent.
      const passed = await closedTask(client, issue, "pass.txt");
      const verdict = await review(client, project, passed, "pass");
      expect(verdict).toMatchObject({ covered: true, mark: { commit: passed.sha, state: "success", sent: false } });
      expect(verdict.mark.why).toContain("HTTP 422: No commit found for SHA");
      expect(github.statuses(passed.sha)).toEqual([]);
      expect(await callJson(client, "task_pr", { id: passed.id, title: "Pass" })).toMatchObject({ commit: passed.sha });
      expect(github.statuses(passed.sha)).toEqual([PASSED]);
      expect(github.log()).toContain(`api --hostname github.com --method POST repos/example/project/statuses/${passed.sha}`);

      // A failed commit reaches GitHub only if someone pushes it; the next occasion then marks it.
      const failed = await closedTask(client, issue, "fail.txt");
      expect((await review(client, project, failed, "fail")).mark).toMatchObject({ state: "failure", sent: false });
      onOrigin(bare, project, failed.branch);

      // The waiver is that occasion; its own commit is not on GitHub yet, so the command line says when it goes.
      const waived = await closedTask(client, issue, "waive.txt");
      expect(human(["task", "waive", waived.id, "--reason", "A file the Human read"], project)).toContain(
        `GitHub does not have ${waived.sha.slice(0, 12)} yet; tmb sends its mark tmb/review success once it pushes the commit.`,
      );
      expect(github.statuses(failed.sha)).toEqual([{ state: "failure", context: "tmb/review", description: "Failed tmb's review: 1 blocking finding" }]);
      tmb(["task", "pr", waived.id, "--title", "Waived"], project);
      expect(github.statuses(waived.sha)).toEqual([
        { state: "success", context: "tmb/review", description: "Passed: review waived by the Human: A file the Human read" },
      ]);

      // A commit already on GitHub is marked at once.
      const early = await closedTask(client, issue, "early.txt");
      onOrigin(bare, project, early.branch);
      expect(human(["task", "waive", early.id, "--reason", "pushed"], project)).toContain(`Marked tmb/review success on ${early.sha.slice(0, 12)} on GitHub.`);
    } finally {
      await client.close();
    }
  }, 60_000);

  test("with GitHub down a mark is recorded unsent; the next waiver or pull request sends it; the pull request says whether main requires the mark", async () => {
    const { project, bare } = truestProject();
    const issue = tmbJson(["issue", "create", "Down"], project).id as string;
    const client = await connect(project);
    try {
      // A mark that could not be sent never fails the review.
      github.down(true);
      const first = await closedTask(client, issue, "first.txt");
      onOrigin(bare, project, first.branch);
      const passed = await review(client, project, first, "pass");
      expect(passed).toMatchObject({ covered: true, state: "in_review", mark: { commit: first.sha, sent: false } });
      expect(passed.mark.why).toContain("HTTP 502");
      expect(github.statuses(first.sha)).toEqual([]);

      // GitHub is back: the waiver of another task sends the first task's mark.
      github.down(false);
      const second = await closedTask(client, issue, "second.txt");
      human(["task", "waive", second.id, "--reason", "small"], project);
      expect(github.statuses(first.sha)).toEqual([PASSED]);
      expect(github.statuses(second.sha)).toEqual([]);

      // A waiver while GitHub is down says so; the pull request, after its push, sends it.
      github.down(true);
      const third = await closedTask(client, issue, "third.txt");
      const said = human(["task", "waive", third.id, "--reason", "small too"], project);
      expect(said).toContain("The mark on GitHub was not sent (");
      expect(said).toContain("tmb sends it on the next review, waiver or pull request.");
      github.down(false);
      const pr = await callJson(client, "task_pr", { id: third.id, title: "Third" });
      expect(pr).toMatchObject({ url: PR_URL, commit: third.sha, markRequired: false });
      expect(github.statuses(third.sha)).toEqual([{ state: "success", context: "tmb/review", description: "Passed: review waived by the Human: small too" }]);
      expect(github.statuses(second.sha)).toEqual([]);
      // Each mark is sent once: a later occasion does not send it again.
      tmb(["task", "pr", second.id, "--title", "Second"], project);
      expect(github.statuses(second.sha)).toEqual([{ state: "success", context: "tmb/review", description: "Passed: review waived by the Human: small" }]);
      expect(github.statuses(first.sha)).toHaveLength(1);
      expect(github.statuses(third.sha)).toHaveLength(1);

      // main's protection requires the mark: the pull request says so; without it, how to turn it on.
      const fourth = await closedTask(client, issue, "fourth.txt");
      await review(client, project, fourth, "pass");
      github.protect("main", ["ci", "tmb/review"]);
      expect(tmb(["task", "pr", fourth.id, "--title", "Fourth"], project)).toContain("Branch protection on main requires tmb/review.");
      expect(github.statuses(fourth.sha)).toEqual([PASSED]);
      github.protect("main", null);
      const fifth = await closedTask(client, issue, "fifth.txt");
      await review(client, project, fifth, "pass");
      expect(tmb(["task", "pr", fifth.id, "--title", "Fifth"], project)).toContain(
        "Branch protection on main does not require tmb/review; to require it, turn on 'Require status checks to pass' for main on GitHub and add tmb/review. tmb never changes this setting.",
      );

      // A rebase that keeps the patch carries the pass to a new commit, which is pushed and marked; the old one never reaches GitHub.
      const sixth = await closedTask(client, issue, "sixth.txt");
      await review(client, project, sixth, "pass");
      const other = mkdtempSync(path.join(scratch, "other-"));
      git(other, "clone", "-q", "-b", "main", bare, ".");
      writeFileSync(path.join(other, "README.md"), "moved\n");
      git(other, "commit", "-q", "-am", "move main");
      git(other, "push", "-q", "origin", "main");
      const carried = await callJson(client, "task_pr", { id: sixth.id, title: "Sixth" });
      expect(carried.rebasedOnto).not.toBeNull();
      expect(carried.commit).not.toBe(sixth.sha);
      expect(github.statuses(carried.commit)).toEqual([PASSED]);
      expect(github.statuses(sixth.sha)).toEqual([]);
    } finally {
      await client.close();
    }
  }, 90_000);
});

describe("the mark on GitHub, in agile mode", () => {
  test("a pass of the feature branch marks its tip; feature_pr says whether main requires the mark", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    github.point(project);
    const issue = tmbJson(["issue", "create", "Agile"], project).id as string;
    const client = await connect(project, "claude-code");
    try {
      await callJson(client, "feature_start", { name: "feat/mark" });
      const task = await callJson(client, "task_start", { issue_id: issue, kind: "code", intent: "Add a file", files: ["src"], criteria: ["SC1: it is there"] });
      const tip = commitFile(task.worktree, "src/a.txt", "a\n", "add a");
      await callJson(client, "task_close", { id: task.id, role: "worker" });
      expect(startSubagent(project, "reviewer", "feature=feat/mark")).toBeNull();
      const passed = await callJson(client, "review_record", { feature: "feat/mark", commit: tip, verdict: "pass", role: "reviewer" });
      stopSubagent(project, "reviewer");
      expect(passed.mark).toMatchObject({ commit: tip, state: "success", sent: true });
      expect(github.statuses(tip)).toEqual([PASSED]);
      github.protect("main", ["tmb/review"]);
      expect(await callJson(client, "feature_pr", { feature: "feat/mark", title: "Mark" })).toMatchObject({ url: PR_URL, tip, markRequired: true });
      github.protect("main", null);

      // With GitHub down, a fail and then the Human's waiver on the same tip are both unsent: only the newest is ever sent.
      await callJson(client, "feature_start", { name: "feat/late" });
      const late = await callJson(client, "task_start", { issue_id: issue, kind: "code", intent: "Add b", files: ["lib"], criteria: ["SC1: it is there"] });
      const lateTip = commitFile(late.worktree, "lib/b.txt", "b\n", "add b");
      await callJson(client, "task_close", { id: late.id, role: "worker" });
      github.down(true);
      expect(startSubagent(project, "reviewer", "feature=feat/late")).toBeNull();
      const failed = await callJson(client, "review_record", { feature: "feat/late", commit: lateTip, verdict: "fail", blocking: ["lib/b.txt:1 b"], role: "reviewer" });
      stopSubagent(project, "reviewer");
      expect(failed.mark).toMatchObject({ state: "failure", sent: false });
      expect(human(["feature", "waive", "feat/late", "--reason", "The Human read it"], project)).toContain("The mark on GitHub was not sent");
      github.down(false);
      expect(await callJson(client, "feature_pr", { feature: "feat/late", title: "Late" })).toMatchObject({ coveredBy: "waiver", markRequired: false });
      expect(github.statuses(lateTip)).toEqual([{ state: "success", context: "tmb/review", description: "Passed: review waived by the Human: The Human read it" }]);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("tmb onboard and the mark", () => {
  test("says whether main requires tmb/review, how to turn it on, or why it could not tell; nothing for a local origin", () => {
    const local = setUpProject("true", undefined, { origin: true });
    expect(tmb(["onboard", "--base", "main", "--yes"], local)).not.toContain("tmb/review");

    const project = setUpProject("true", undefined, { origin: true });
    github.point(project);
    const off = tmb(["onboard", "--base", "main", "--yes"], project);
    expect(off).toContain("Branch protection on main does not require tmb/review; to require it, turn on 'Require status checks to pass'");
    expect(off).toContain("tmb never changes this setting.");
    expect(off).toContain("only on its paid plans");
    github.protect("main", ["tmb/review"]);
    expect(tmb(["onboard", "--base", "main", "--yes"], project)).toContain("Branch protection on main requires tmb/review");
    github.protect("main", null);
    github.down(true);
    const unknown = run(["onboard", "--base", "main", "--yes"], project);
    github.down(false);
    expect(unknown.status).toBe(0);
    expect(unknown.stdout).toContain("tmb could not tell whether branch protection on main requires tmb/review: ");
    expect(unknown.stdout).toContain("HTTP 502");
  }, 60_000);
});
