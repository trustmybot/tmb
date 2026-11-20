// Workflow simulation, ported from the plugin's flow 13 (issue update): the planner moves an
// issue to another milestone and rewrites its title and body through issue_update; issue_get
// shows the new values and history shows each change with who made it. An update naming no field
// is refused, and one that changes nothing records nothing. Scripted as tool calls through the
// tool server, with no model.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { callJson, callRefused, tmbProcesses } from "../integration/tmb-processes.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const PLANNER = { kind: "agent", role: "planner", host: "test" };

const { setUpProject, connect, cleanup } = tmbProcesses("tmb-flow-13-");
afterAll(cleanup);

describe("flow 13: an issue update", () => {
  test("a milestone move and a new title and body show in issue_get and in history", async () => {
    const project = setUpProject("true");
    const client = await connect(project);
    try {
      const created = await callJson(client, "issue_create", { title: "Original title", body: "Original body.", milestone: "4. Agile mode" });
      const id = created.id;

      const moved = await callJson(client, "issue_update", { id, milestone: "5. Code graph" });
      expect(moved.changed).toEqual(["milestone"]);
      const rewritten = await callJson(client, "issue_update", { id, title: "Rewritten title", body: "Rewritten body.", milestone: "5. Code graph" });
      expect(rewritten.changed).toEqual(["title", "body"]);

      const read = await callJson(client, "issue_get", { id });
      expect(read.issue).toMatchObject({ id, title: "Rewritten title", body: "Rewritten body.", milestone: "5. Code graph", state: "open" });
      expect(await callJson(client, "issue_list", {})).toMatchObject([{ id, title: "Rewritten title", milestone: "5. Code graph" }]);

      // Refused: an update naming no field. Recorded as nothing: one that changes nothing.
      expect(await callRefused(client, "issue_update", { id })).toContain("issue_update needs at least one of state, title, body, milestone");
      expect((await callJson(client, "issue_update", { id, title: "Rewritten title" })).changed).toEqual([]);

      const events = await callJson<any[]>(client, "history", { id });
      expect(events.map((event) => [event.type, event.data, event.actor])).toEqual([
        ["created", { title: "Original title", body: "Original body.", milestone: "4. Agile mode" }, PLANNER],
        ["updated", { milestone: "5. Code graph" }, PLANNER],
        ["updated", { title: "Rewritten title", body: "Rewritten body." }, PLANNER],
      ]);
    } finally {
      await client.close();
    }
  });
});
