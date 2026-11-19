// Workflow simulation, ported from the plugin's flow 03 (difficult task): before any task, the
// planner records its open questions as notes, the Human answers each on the record, and the
// planner records the decision they reach; the issue reads back in that order, with the decision
// in force, and only then does the task start. Scripted as tool calls through the tool server and
// the Human's command line, with no model.
import { afterAll, describe, expect, test } from "bun:test";
import { callJson, tmbProcesses } from "../integration/tmb-processes.ts";

const PLANNER = { kind: "agent", role: "planner", host: "test" };
const HUMAN = { kind: "human" };

const { tmb, setUpProject, connect, cleanup } = tmbProcesses("tmb-flow-03-");
afterAll(cleanup);

describe("flow 03: a difficult task", () => {
  test("questions and answers recorded as notes, then a decision, read back in order from the issue before the task starts", async () => {
    const project = setUpProject("true");
    const client = await connect(project);
    try {
      const issue = await callJson(client, "issue_create", { title: "Switch us to JWT auth", body: "Touches the auth module across handlers." });
      const ask = (body: string) => callJson(client, "discussion_append", { issue_id: issue.id, kind: "note", body });
      // The Human answers from the command line, so the record names the Human, not an agent.
      const answer = (body: string) => tmb(["note", issue.id, body], project);

      await ask("Question: sign with HS256 and a shared secret, or RS256 with key rotation?");
      answer("RS256 with rotation; compliance needs it.");
      await ask("Question: migrate existing sessions, or force a new login at cutover?");
      answer("Force a new login.");
      const decision = await callJson(client, "discussion_append", {
        issue_id: issue.id,
        kind: "decision",
        body: "RS256 with key rotation, and a forced new login at cutover.",
      });

      const read = await callJson(client, "issue_get", { id: issue.id });
      expect(read.discussions.map((entry: any) => [entry.kind, entry.createdBy, entry.body])).toEqual([
        ["note", PLANNER, "Question: sign with HS256 and a shared secret, or RS256 with key rotation?"],
        ["note", HUMAN, "RS256 with rotation; compliance needs it."],
        ["note", PLANNER, "Question: migrate existing sessions, or force a new login at cutover?"],
        ["note", HUMAN, "Force a new login."],
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
