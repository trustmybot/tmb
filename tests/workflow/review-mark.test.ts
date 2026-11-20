// Workflow simulation: the mark on GitHub belongs to one commit. A commit the reviewer passed is
// marked; a new commit after it, from a task folded onto the feature branch or from rework after
// a fail, has no mark until it is reviewed and on GitHub, and its review leaves the old commit's
// mark as it was.
// A stand-in for GitHub keeps the marks; the project's origin has a GitHub address.
import { afterAll, describe, expect, test } from "bun:test";
import { githubStandIn } from "../integration/github-stand-in.ts";
import { callJson, tmbProcesses } from "../integration/tmb-processes.ts";

const { scratch, env, git, tmb, human, tmbJson, setUpProject, commitFile, startSubagent, stopSubagent, connect, cleanup } = tmbProcesses("tmb-workflow-mark-");
afterAll(cleanup);
const github = githubStandIn(scratch, env, git);

const PASSED = { state: "success", context: "tmb/review", description: "Passed tmb's review" };
const FAILED = { state: "failure", context: "tmb/review", description: "Failed tmb's review: 1 blocking finding" };

describe("a new commit has no mark until it is reviewed", () => {
  test("agile: a task folded onto a passed feature branch moves its tip to an unmarked commit", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    github.point(project);
    const issue = tmbJson(["issue", "create", "Greet"], project).id as string;
    const client = await connect(project, "claude-code");
    const landTask = async (intent: string, file: string) => {
      const task = await callJson(client, "task_start", { issue_id: issue, kind: "code", intent, files: ["src"], criteria: ["SC1: it works"] });
      const sha = commitFile(task.worktree, file, `${intent}\n`, intent);
      await callJson(client, "task_close", { id: task.id, role: "worker" });
      return sha;
    };
    const pass = async (commit: string) => {
      expect(startSubagent(project, "reviewer", "feature=feat/greet")).toBeNull();
      await callJson(client, "review_record", { feature: "feat/greet", commit, verdict: "pass", role: "reviewer" });
      stopSubagent(project, "reviewer");
    };
    try {
      await callJson(client, "feature_start", { name: "feat/greet" });
      const a = await landTask("Add the greeting", "src/greet.txt");
      await pass(a);
      expect(github.statuses(a)).toEqual([PASSED]);

      const b = await landTask("Add a farewell", "src/bye.txt");
      expect((await callJson(client, "feature_brief", { feature: "feat/greet" })).tip).toBe(b);
      expect(github.statuses(b)).toEqual([]);

      await pass(b);
      expect(github.statuses(b)).toEqual([PASSED]);
      expect(github.statuses(a)).toEqual([PASSED]);
    } finally {
      await client.close();
    }
  }, 60_000);

  test("truest: rework after a fail is a new commit with no mark until the reviewer passes it and task_pr pushes it", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    human(["onboard", "--base", "main", "--review-mode", "truest", "--check", "true", "--yes"], project);
    const bare = git(project, "config", "--get", "remote.origin.url");
    github.point(project);
    const issue = tmbJson(["issue", "create", "Lines"], project).id as string;
    const client = await connect(project);
    const reviewAt = async (id: string, commit: string, verdict: "pass" | "fail") => {
      expect(startSubagent(project, "reviewer", `review_task=${id}`)).toBeNull();
      await callJson(client, "task_review", { id, commit, verdict, role: "reviewer", ...(verdict === "fail" ? { blocking: ["a.txt:1 shouts"] } : {}) });
      stopSubagent(project, "reviewer");
    };
    try {
      const task = await callJson(client, "task_start", { issue_id: issue, kind: "code", intent: "Add a", files: ["a.txt"], criteria: ["SC1: it works"] });
      const a = commitFile(task.worktree, "a.txt", "A\n", "add a");
      await callJson(client, "task_close", { id: task.id, role: "worker" });
      await reviewAt(task.id, a, "fail");
      // GitHub has no A yet, so its mark waits. Someone pushes the failed branch by hand, past git's hooks.
      expect(github.statuses(a)).toEqual([]);
      git(bare, "fetch", "-q", project, `+refs/heads/${task.branch}:refs/heads/${task.branch}`);

      const b = commitFile(task.worktree, "a.txt", "a\n", "quiet a");
      await callJson(client, "task_close", { id: task.id, role: "worker" });
      expect(github.statuses(b)).toEqual([]);

      // B's review is the next occasion: A's failure goes out; B's pass waits until GitHub has B.
      await reviewAt(task.id, b, "pass");
      expect(github.statuses(a)).toEqual([FAILED]);
      expect(github.statuses(b)).toEqual([]);
      await callJson(client, "task_pr", { id: task.id, title: "Quiet a" });
      expect(github.statuses(b)).toEqual([PASSED]);
      expect(github.statuses(a)).toEqual([FAILED]);
    } finally {
      await client.close();
    }
  }, 60_000);
});
