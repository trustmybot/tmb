// Workflow simulation of a difficult task: before any task, the planner records its open
// questions as notes, then each answer the Human gives in the chat, and the decision they reach;
// the issue reads back in that order, with the decision in force, and only then does the task
// start. Scripted as tool calls through the tool server, with no model.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { callJson, tmbProcesses } from "../lib/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const PLANNER = { kind: "agent", role: "planner", host: "test" };

const { setUpProject, connect, cleanup } = tmbProcesses("tmb-difficult-task-");
afterAll(cleanup);

describe("a difficult task: its questions, answers and decision are on the record before it starts", () => {
  test("questions and answers recorded as notes, then a decision, read back in order from the issue before the task starts", async () => {
    const project = setUpProject("true");
    const client = await connect(project);
    try {
      const issue = await callJson(client, "issue_create", { title: "Switch us to JWT auth", body: "Touches the auth module across handlers." });
      const ask = (body: string) => callJson(client, "discussion_append", { issue_id: issue.id, kind: "note", body });
      // The Human answers in the chat; the planner records each answer as the Human gave it.
      const answer = (body: string) => callJson(client, "discussion_append", { issue_id: issue.id, kind: "note", body: `The Human answered: ${body}` });

      await ask("Question: sign with HS256 and a shared secret, or RS256 with key rotation?");
      await answer("RS256 with rotation; compliance needs it.");
      await ask("Question: migrate existing sessions, or force a new login at cutover?");
      await answer("Force a new login.");
      const decision = await callJson(client, "discussion_append", {
        issue_id: issue.id,
        kind: "decision",
        body: "RS256 with key rotation, and a forced new login at cutover.",
      });

      const read = await callJson(client, "issue_get", { id: issue.id });
      expect(read.discussions.map((entry: any) => [entry.kind, entry.createdBy, entry.body])).toEqual([
        ["note", PLANNER, "Question: sign with HS256 and a shared secret, or RS256 with key rotation?"],
        ["note", PLANNER, "The Human answered: RS256 with rotation; compliance needs it."],
        ["note", PLANNER, "Question: migrate existing sessions, or force a new login at cutover?"],
        ["note", PLANNER, "The Human answered: Force a new login."],
        ["decision", PLANNER, "RS256 with key rotation, and a forced new login at cutover."],
      ]);
      expect(read.newestDecision).toEqual(decision);
      expect(await callJson(client, "search", { query: "rotation" })).toHaveLength(3);

      // Only now does the task start, on the issue that carries the decision.
      await callJson(client, "feature_start", { name: "feat/jwt-auth" });
      const started = await callJson(client, "task_start", {
        issue_id: issue.id,
        kind: "code",
        intent: "Replace the session middleware with JWT signed RS256, per the decision on the issue",
        files: ["auth"],
        criteria: ["SC1: tokens verify with RS256", "SC2: the session code is gone"],
      });
      expect(started.brief).toMatchObject({ issueId: issue.id, state: "open", feature: "feat/jwt-auth" });
      expect((await callJson(client, "issue_get", { id: issue.id })).newestDecision).toEqual(decision);
    } finally {
      await client.close();
    }
  });
});
