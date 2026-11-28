// Flow 2.1, First contact (docs/flows/FLOWS.md): this file is its scenario test.
// At the first session the planner is told the settings are empty and applies what tmb
// recommends; the review mode is the Human's answer, and no task starts before it.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { callJson, callRefused, tmbProcesses } from "../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { tmb, human, newProject, config, sessionStart, connect, cleanup } = tmbProcesses("tmb-flow-first-contact-");
afterAll(cleanup);

describe("onboarding at the first session", () => {
  test("the planner is told the settings are empty, and applies its recommendation through settings_set", async () => {
    const project = newProject();
    tmb(["init"], project);
    const context = sessionStart(project);
    expect(context).toContain("## The project's settings are empty");
    expect(context).toContain("- base branch: `trunk`");
    expect(context).toContain("- checks: `bun run test`");
    expect(context).toContain("`tmb onboard` can be run again at any time");

    const client = await connect(project);
    try {
      const set = await callJson(client, "settings_set", { base_branch: "trunk", review_mode: "agile", checks: ["bun run test"] });
      expect(set.empty).toEqual([]);
    } finally {
      await client.close();
    }
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "planner" }, base_branch: "trunk", review_mode: "agile", checks: ["bun run test"], graph_links: null });
    expect(sessionStart(project)).not.toContain("## The project's settings are empty");
  });
});

describe("the review mode is the Human's choice (trustmybot/tmb#114)", () => {
  test("no task starts until it is chosen; in an unattended run the planner cannot choose it, and the Human's tmb onboard --review-mode --yes can", async () => {
    const project = newProject();
    tmb(["init"], project);
    tmb(["onboard", "--base", "trunk", "--check", "true", "--yes"], project);
    expect(config(project).review_mode).toBeNull();

    const client = await connect(project, "test", { unattended: true });
    try {
      const issue = await callJson(client, "issue_create", { title: "A goal" });
      await callJson(client, "feature_start", { name: "feat/goal" });
      const spec = { issue_id: issue.id, kind: "code", intent: "Do it", files: ["a.txt"], criteria: ["SC1: done"] };
      expect(await callRefused(client, "task_start", spec)).toContain("`tmb onboard`");
      expect(await callRefused(client, "settings_set", { review_mode: "agile" })).toContain("no one can answer in this run");
      expect(config(project).review_mode).toBeNull();

      human(["onboard", "--review-mode", "agile", "--yes"], project);
      expect((await callJson(client, "task_start", spec)).brief).toMatchObject({ state: "open", feature: "feat/goal" });
    } finally {
      await client.close();
    }
  });
});
