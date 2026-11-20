// Workflow simulation: a project with no remote (trustmybot/tmb#183). Nothing is pushed and no
// pull request opens: once the reviewer passes a feature branch, or a truest task, tmb records it
// ready and tells the Human the merge command. The Human merges locally, and tmb records the
// feature branch merged, or the task closed, once the base branch holds its tip. A fake `gh` on PATH
// logs every call, so a pull request step that reached GitHub would show, and opens a pull request
// only once a remote was added.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../integration/tmb-processes.ts";

const { scratch, env, git, tmb, tmbJson, setUpProject, commitFile, startSubagent, stopSubagent, connect, sessionStart, cleanup } = tmbProcesses("tmb-workflow-no-remote-");
afterAll(cleanup);

const ghLog = path.join(scratch, "gh.log");
const PR = "https://github.com/example/project/pull/4";
const fakeBin = path.join(scratch, "fake-gh");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\nif [ "$1 $2" = "pr create" ]; then echo "${PR}"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
env.PATH = `${fakeBin}${path.delimiter}${env.PATH}`;

/** Runs the merge command tmb gave, in its folder, as the Human would. */
function humanMerges(merge: { dir: string; command: string }): void {
  const result = spawnSync("sh", ["-c", merge.command], {
    cwd: merge.dir,
    env: { ...env, GIT_AUTHOR_NAME: "h", GIT_AUTHOR_EMAIL: "h@example.com", GIT_COMMITTER_NAME: "h", GIT_COMMITTER_EMAIL: "h@example.com", GIT_EDITOR: "true" },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${merge.command}: ${result.stderr}`);
}

const ghCalled = (): boolean => existsSync(ghLog) && readFileSync(ghLog, "utf8").trim() !== "";

describe("a project with no remote ends with a local merge by the Human", () => {
  test("agile: the close skips the backup push, a passed branch is ready, and the Human's merge makes it merged", async () => {
    const project = setUpProject("true");
    const issue = tmbJson(["issue", "create", "Greet the user"], project);
    const client = await connect(project, "claude-code");
    try {
      await callJson(client, "feature_start", { name: "feat/greet" });
      const task = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", feature: "feat/greet", intent: "Add greet", files: ["src"], criteria: ["SC1: it greets"] });
      commitFile(task.worktree, "src/greet.ts", "export const greet = () => 'hi';\n", "add greet");

      // 1. The close folds the task and skips the backup push, with no error.
      const closed = await callJson(client, "task_close", { id: task.id, role: "worker" });
      expect(closed.push).toMatchObject({ result: "skipped" });
      const brief = await callJson(client, "feature_brief", { feature: "feat/greet" });

      // 2. The reviewer's pass says no pull request opens.
      expect(startSubagent(project, "reviewer", `${brief.reviewLine}\nReview the branch.`)).toBeNull();
      const passed = await callJson(client, "review_record", { feature: "feat/greet", commit: brief.tip, verdict: "pass", role: "reviewer" });
      stopSubagent(project, "reviewer");
      expect(passed.next).toContain("no remote");
      expect(passed.next).not.toContain("pull request may open");

      // 3. feature_pr records the branch ready and gives the merge command; nothing reached GitHub.
      const ready = await callJson(client, "feature_pr", { feature: "feat/greet", title: "Greet" });
      expect(ready).toMatchObject({ url: null, tip: brief.tip, localMerge: { dir: project, command: "git switch main && git merge --no-ff feat/greet" } });
      expect((await callJson(client, "feature_brief", { feature: "feat/greet" })).state).toBe("ready");
      expect(await callRefused(client, "task_start", { issue_id: issue.id, kind: "code", feature: "feat/greet", intent: "More", files: ["src"], criteria: ["SC1: x"] })).toContain("is ready");
      expect(ghCalled()).toBe(false);

      // 4. Until the Human merges, it stays ready; after, it is merged and the session start says so.
      const list = async () => (await callJson(client, "feature_list", {})).find((f: { name: string }) => f.name === "feat/greet");
      expect(await list()).toMatchObject({ state: "ready" });
      humanMerges(ready.localMerge);
      expect(sessionStart(project)).toContain("feat/greet: the base branch main holds its tip");
      expect(await list()).toMatchObject({ state: "merged" });
      expect(await callRefused(client, "feature_pr", { feature: "feat/greet", title: "Greet" })).toContain("is merged");
    } finally {
      await client.close();
    }
  }, 60_000);

  test("truest: a passed task is rebased onto the local base, ready, and closed once the Human merges it", async () => {
    const project = setUpProject("true", { "README.md": "hello\n", "src/lines.txt": "one\ntwo\n" });
    tmb(["onboard", "--base", "main", "--review-mode", "truest", "--check", "true", "--yes"], project);
    const issue = tmbJson(["issue", "create", "Fix the lines"], project);
    const client = await connect(project, "claude-code");
    try {
      const task = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent: "Fix line two", files: ["src"], criteria: ["SC1: it works"] });
      const commit = commitFile(task.worktree, "src/lines.txt", "one\nTWO\n", "fix two");
      await callJson(client, "task_close", { id: task.id, role: "worker" });

      // 1. The reviewer's pass says no pull request opens.
      expect(startSubagent(project, "reviewer", `review_task=${task.id}`)).toBeNull();
      const passed = await callJson(client, "task_review", { id: task.id, commit, verdict: "pass", role: "reviewer" });
      stopSubagent(project, "reviewer");
      expect(passed.next).toContain("no remote");

      // 2. The local base branch moved: task_pr rebases onto it, keeps the review, and records the task ready.
      commitFile(project, "OTHER.md", "other\n", "someone else's change");
      const ready = await callJson(client, "task_pr", { id: task.id, title: "Fix" });
      expect(ready).toMatchObject({ url: null, coveredBy: "review", rebasedOnto: git(project, "rev-parse", "main"), localMerge: { dir: project, command: `git switch main && git merge --no-ff ${task.branch}` } });
      expect(ready.commit).not.toBe(commit);
      expect(await callJson(client, "task_brief", { id: task.id })).toMatchObject({ state: "ready", commitSha: ready.commit });
      expect(existsSync(task.worktree)).toBe(false);
      expect(git(project, "rev-parse", task.branch)).toBe(ready.commit);
      expect(ghCalled()).toBe(false);

      // 3. The Human merges; the task is closed at the next look.
      expect((await callJson(client, "task_list", { state: "ready" })).map((t: { id: string }) => t.id)).toEqual([task.id]);
      humanMerges(ready.localMerge);
      expect(await callJson(client, "task_list", { state: "ready" })).toEqual([]);
      expect(await callJson(client, "task_brief", { id: task.id })).toMatchObject({ state: "closed" });
      expect(readFileSync(path.join(project, "src/lines.txt"), "utf8")).toBe("one\nTWO\n");

      // 4. A ready task the Human will not merge as it is is dropped; its branch is kept.
      const readyTask = async (intent: string, file: string): Promise<{ id: string; branch: string; localMerge: { dir: string; command: string } }> => {
        const started = await callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent, files: ["src"], criteria: ["SC1: it works"] });
        commitFile(started.worktree, file, `${intent}\n`, intent);
        await callJson(client, "task_close", { id: started.id, role: "worker" });
        tmb(["task", "waive", started.id, "--reason", "The Human read it"], project);
        const answer = await callJson(client, "task_pr", { id: started.id, title: intent });
        expect(answer).toMatchObject({ url: null, coveredBy: "waiver" });
        return { id: started.id, branch: started.branch, localMerge: answer.localMerge };
      };
      const squashed = await readyTask("Add three", "src/three.txt");
      expect((await callJson(client, "task_drop", { id: squashed.id, reason: "The Human squashed it by hand" })).keptBranch).toContain(squashed.branch);
      expect(await callJson(client, "task_brief", { id: squashed.id })).toMatchObject({ state: "dropped" });

      // 5. A ready task asks again: the same merge command while there is no remote, its pull request once there is one.
      const later = await readyTask("Add four", "src/four.txt");
      expect(await callJson(client, "task_pr", { id: later.id, title: "Add four" })).toMatchObject({ url: null, localMerge: later.localMerge, rebasedOnto: null });
      expect(ghCalled()).toBe(false);
      const origin = `${project}-origin.git`;
      git(scratch, "init", "-q", "--bare", origin);
      git(project, "remote", "add", "origin", origin);
      const opened = await callJson(client, "task_pr", { id: later.id, title: "Add four" });
      expect(opened).toMatchObject({ url: PR, localMerge: null });
      expect(git(project, "ls-remote", "origin", later.branch)).toContain(opened.commit);
      expect((await callJson(client, "task_list", { state: "closed" })).find((t: { id: string }) => t.id === later.id)).toMatchObject({ prUrl: PR });
    } finally {
      await client.close();
    }
  }, 60_000);
});
