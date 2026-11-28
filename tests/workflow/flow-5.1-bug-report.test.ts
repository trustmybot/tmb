// Flow 5.1, Bug report (docs/flows/FLOWS.md), its ideal case: tmb breaks, the planner drafts a
// cleaned report, the Human reads it whole, and only on their yes is it filed from their GitHub
// account and recorded. Scripted as tool calls through the tool server, with no model; a fake
// `gh` stands in for GitHub.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fakeGh } from "../lib/fake-gh.ts";
import { callJson, callRefused, tmbProcesses } from "../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ISSUE_URL = "https://github.com/trustmybot/tmb/issues/901";
const SUMMARY = "task_close failed on a clean worktree.";

const { scratch, env, tmb, setUpProject, connect, cleanup } = tmbProcesses("tmb-flow-bug-report-");
afterAll(cleanup);

// A signed-in `gh`: `auth status` succeeds and the issue it files answers with its link.
const gh = fakeGh(scratch, { answer: `case "$1" in api) echo '{"html_url":"${ISSUE_URL}"}' ;; esac` });
env.PATH = `${gh.bin}${path.delimiter}${env.PATH}`;
// The test run turns feedback off for every test (tests/lib/isolate-state.ts); this flow needs it on.
delete env.TMB_NO_FEEDBACK;
delete env.DO_NOT_TRACK;
// The setting lives in the program's state folder: this file's own, so turning it on reaches no other test.
env.TMB_STATE_DIR = path.join(scratch, "state");

describe("flow 5.1: a bug report", () => {
  test("the planner drafts a cleaned report, nothing is sent without the Human's yes, and on a yes it is filed and recorded", async () => {
    const project = setUpProject("true");
    tmb(["feedback", "on"], project);
    const client = await connect(project);
    try {
      const draft = await callJson(client, "feedback_draft", {
        summary: SUMMARY,
        what_happened: "I closed a task after its worker committed.",
        command: "task_close",
        error: `Error: boom at ${project}/src/a.ts`,
      });
      // The Human reads the whole draft, cleaned of the project's path.
      expect(draft.sendable).toBe(true);
      expect(draft.report).toContain("<project>/src/a.ts");
      expect(draft.report).not.toContain(project);
      expect(readFileSync(draft.file, "utf8")).toContain(SUMMARY);

      // No yes, nothing sent: gh is asked nothing.
      await callRefused(client, "feedback_send", { draft_id: draft.draft_id, human_answer: "no" });
      expect(readLog(gh.log).filter((line) => line.startsWith("api"))).toEqual([]);

      // The Human's yes: filed through gh and recorded with its link.
      const sent = await callJson(client, "feedback_send", { draft_id: draft.draft_id, human_answer: "yes" });
      expect(sent).toMatchObject({ route: "issue", url: ISSUE_URL });
      const filed = readLog(gh.log).filter((line) => line.startsWith("api"));
      expect(filed).toHaveLength(1);
      expect(filed[0]).toContain(`title=${SUMMARY}`);
      expect(await callRefused(client, "feedback_send", { draft_id: draft.draft_id, human_answer: "yes" })).toContain("already filed");
    } finally {
      await client.close();
    }
  });
});

function readLog(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}
