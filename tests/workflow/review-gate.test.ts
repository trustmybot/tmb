// Workflow simulation: the review of a whole feature branch, scripted as the calls a planner, a
// reviewer and the Human make, with no model. The reviewer fails the branch, the planner reworks
// it in a task, the reviewer passes the new tip, and the pull request opens; on a second branch
// the Human waives the review instead. A fake `gh` on PATH stands in for GitHub.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callJson, callRefused, tmbProcesses } from "../integration/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { scratch, env, git, tmb, tmbJson, setUpProject, commitFile, startSubagent, stopSubagent, connect, cleanup } = tmbProcesses("tmb-workflow-review-");
afterAll(cleanup);

// A fake gh: it logs its arguments and prints a pull request address, as `gh pr create` does.
const ghLog = path.join(scratch, "gh.log");
const fakeBin = path.join(scratch, "fake-gh");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\necho "https://github.com/example/project/pull/7"\n`, { mode: 0o755 });
env.PATH = `${fakeBin}${path.delimiter}${env.PATH}`;

describe("the review of a feature branch", () => {
  test("review, fail, rework, pass, then the pull request; and a waiver on a second branch", async () => {
    const project = setUpProject("true", undefined, { origin: true });
    const issue = tmbJson(["issue", "create", "Greet the user"], project);
    const client = await connect(project, "claude-code");
    const startTask = async (intent: string) =>
      callJson(client, "task_start", { issue_id: issue.id, kind: "code", intent, files: ["src"], criteria: ["SC1: it works"] });
    try {
      // 1. A feature branch with one landed task.
      await callJson(client, "feature_start", { name: "feat/greet" });
      const first = await startTask("Add the greeting");
      const firstTip = commitFile(first.worktree, "src/greet.ts", "export const greet = (name) => 'hi ' + name;\n", "add greet");
      await callJson(client, "task_close", { id: first.id, role: "worker" });

      let brief = await callJson(client, "feature_brief", { feature: "feat/greet" });
      expect(brief).toMatchObject({ tip: firstTip, covered: false, coveredBy: null, reviewLine: "feature=feat/greet", reviews: [] });
      expect(brief.groups).toMatchObject([{ task: first.id, to: firstTip }]);
      expect(await callRefused(client, "feature_pr", { feature: "feat/greet", title: "Greet" })).toContain("no reviewer has reviewed it");

      // Only a reviewer the host started records a verdict.
      const verdict = { feature: "feat/greet", commit: firstTip, verdict: "fail", blocking: ["src/greet.ts:1 greet(undefined) says 'hi undefined'"] };
      expect(await callRefused(client, "review_record", { ...verdict, role: "reviewer" })).toContain("no reviewer run is open");
      expect(await callRefused(client, "review_record", { ...verdict, role: "planner" })).toContain("for the reviewer");
      const human = tmb(["feature", "brief", "feat/greet"], project);
      expect(human).toContain("Covered at the tip: not yet");

      // 2. The reviewer fails the tip.
      expect(startSubagent(project, "reviewer", `${brief.reviewLine}\nReview the branch.`)).toBeNull();
      expect(await callRefused(client, "review_record", { feature: "feat/greet", commit: firstTip, verdict: "fail", role: "reviewer" })).toContain(
        "at least one blocking finding",
      );
      expect(
        await callRefused(client, "review_record", { feature: "feat/greet", commit: firstTip, verdict: "pass", blocking: ["x"], role: "reviewer" }),
      ).toContain("names no blocking finding");
      const failed = await callJson(client, "review_record", { ...verdict, notes: ["consider a default name"], role: "reviewer" });
      expect(failed).toMatchObject({ covered: false, review: { verdict: "fail", commit: firstTip } });
      expect(failed.review.findings).toEqual([
        { text: verdict.blocking[0], blocking: true },
        { text: "consider a default name", blocking: false },
      ]);
      stopSubagent(project, "reviewer");
      expect(await callRefused(client, "feature_pr", { feature: "feat/greet", title: "Greet" })).toContain("its newest review at the tip is a fail");

      // 3. Rework lands as a task; the old verdict no longer names the tip.
      const rework = await startTask("Fix greet(undefined)");
      const reworkTip = commitFile(rework.worktree, "src/greet.ts", "export const greet = (name = 'there') => 'hi ' + name;\n", "default the name");
      await callJson(client, "task_close", { id: rework.id, role: "worker" });
      brief = await callJson(client, "feature_brief", { feature: "feat/greet" });
      expect(brief).toMatchObject({ tip: reworkTip, covered: false });
      expect(brief.groups.map((group: { task: string }) => group.task)).toEqual([first.id, rework.id]);
      expect(await callRefused(client, "feature_pr", { feature: "feat/greet", title: "Greet" })).toContain("the branch has moved since");

      // 4. A new reviewer passes the new tip; a verdict on the old one is refused.
      expect(startSubagent(project, "reviewer", brief.reviewLine)).toBeNull();
      expect(await callRefused(client, "review_record", { feature: "feat/greet", commit: firstTip, verdict: "pass", role: "reviewer" })).toContain(
        `is at ${reworkTip}`,
      );
      const passed = await callJson(client, "review_record", { feature: "feat/greet", commit: reworkTip.slice(0, 10), verdict: "pass", role: "reviewer" });
      expect(passed).toMatchObject({ covered: true, review: { verdict: "pass", commit: reworkTip } });
      stopSubagent(project, "reviewer");
      expect(await callJson(client, "feature_brief", { feature: "feat/greet" })).toMatchObject({ covered: true, coveredBy: "review" });

      // 5. The pull request opens: tmb pushes the branch and runs gh.
      expect(await callRefused(client, "feature_pr", { feature: "feat/greet", title: "Greet", role: "worker" })).toContain("for the planner");
      const pr = await callJson(client, "feature_pr", { feature: "feat/greet", title: "Greet the user", body: "Adds greet()." });
      expect(pr).toMatchObject({ url: "https://github.com/example/project/pull/7", base: "main", tip: reworkTip, coveredBy: "review" });
      const ghCall = readFileSync(ghLog, "utf8");
      expect(ghCall).toContain("pr create --base main --head feat/greet --title Greet the user --body Adds greet().");
      expect(ghCall).toContain(`Reviewed by the tmb reviewer: pass at ${reworkTip}.`);
      expect(git(project, "ls-remote", "origin", "refs/heads/feat/greet")).toStartWith(reworkTip);
      expect(await callJson(client, "feature_brief", { feature: "feat/greet" })).toMatchObject({ state: "pr_open", prUrl: pr.url });
      // Again while it is open: the same pull request, and no second one (trustmybot/tmb#168).
      expect(await callJson(client, "feature_pr", { feature: "feat/greet", title: "Again" })).toMatchObject({ url: pr.url, tip: reworkTip });
      expect(readFileSync(ghLog, "utf8").split("\n").filter((line) => line.startsWith("pr create"))).toHaveLength(1);

      // 6. A second branch: the Human waives its review, and only the Human can.
      await callJson(client, "feature_start", { name: "feat/wave" });
      const wave = await startTask("Add a wave");
      const waveTip = commitFile(wave.worktree, "src/wave.ts", "export const wave = () => 'o/';\n", "add wave");
      await callJson(client, "task_close", { id: wave.id, role: "worker" });
      expect(await callRefused(client, "feature_waive", { feature: "feat/wave", reason: "tiny", role: "planner" })).toContain("only the Human waives");
      expect(tmb(["feature", "waive", "feat/wave", "--reason", "A one-line change the Human read"], project)).toContain(`at ${waveTip}`);
      expect(await callJson(client, "feature_brief", { feature: "feat/wave" })).toMatchObject({
        covered: true,
        coveredBy: "waiver",
        waivers: [{ commit: waveTip, reason: "A one-line change the Human read" }],
      });
      expect(tmb(["feature", "pr", "feat/wave", "--title", "Wave"], project)).toContain("https://github.com/example/project/pull/7");
      expect(readFileSync(ghLog, "utf8")).toContain(`Review waived by the Human at ${waveTip}: A one-line change the Human read`);
    } finally {
      await client.close();
    }
  }, 30_000);
});
