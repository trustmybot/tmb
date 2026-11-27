// Workflow simulation of a cold restart: once the project is set
// up and work is recorded, a new session's start, answered by the session start hook, lists the
// open issue and the open task from the record, and asks for no init or onboarding; the settings
// onboard stored are still in force. Scripted through the tool server and the hook, with no model.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { EMPTY_SETTINGS_HEADING, OPEN_WORK_HEADING, plannerRole } from "../../src/engine/index.ts";
import { callJson, tmbProcesses } from "../integration/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const { tmbJson, setUpProject, sessionStart, connect, cleanup } = tmbProcesses("tmb-cold-restart-");
afterAll(cleanup);

describe("a cold restart: a new session resumes from the record", () => {
  test("a new session after init, onboard and recorded work is told the open issue and open task, and is not sent to init or onboarding", async () => {
    const project = setUpProject("true");
    const first = await connect(project);
    let issue: any;
    let closedIssue: any;
    let task: any;
    try {
      issue = await callJson(first, "issue_create", { title: "Add dark mode" });
      await callJson(first, "discussion_append", { issue_id: issue.id, kind: "decision", body: "A toggle in the header" });
      closedIssue = await callJson(first, "issue_create", { title: "Old finished work" });
      await callJson(first, "issue_update", { id: closedIssue.id, state: "closed" });
      await callJson(first, "feature_start", { name: "feat/dark-mode" });
      task = await callJson(first, "task_start", { issue_id: issue.id, kind: "code", intent: "Add the dark mode toggle", files: ["src"], criteria: ["SC1: it toggles"] });
    } finally {
      // The first session ends: nothing of it survives but the record.
      await first.close();
    }

    const context = sessionStart(project);
    expect(context).toStartWith(plannerRole.trimEnd());
    const work = context.slice(context.indexOf(OPEN_WORK_HEADING));
    expect(work).toContain(`- ${issue.id} Add dark mode (decision: A toggle in the header)`);
    expect(work).toContain(`- ${task.id} Add the dark mode toggle (issue ${issue.id}, feature branch feat/dark-mode, worktree ${task.worktree})`);
    expect(work).not.toContain(closedIssue.id);
    // The record is found and read and the settings are set, so the session is sent to neither.
    expect(context).not.toContain("run tmb init");
    expect(context).not.toContain(EMPTY_SETTINGS_HEADING);
    expect(context).not.toContain("could not read the record");

    // The new session's tools see the same record, with onboard's settings still in force.
    const second = await connect(project);
    try {
      expect((await callJson(second, "task_list", {})).map((open: any) => open.id)).toEqual([task.id]);
      expect(await callJson(second, "task_brief", { id: task.id })).toMatchObject({ state: "open", checks: ["true"] });
    } finally {
      await second.close();
    }
    expect(tmbJson(["issue", "list", "--state", "open"], project).map((open: any) => open.id)).toEqual([issue.id]);
  });
});
