import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discussionAppend,
  HandlerError,
  history,
  issueCreate,
  issueGet,
  issueList,
  issueUpdate,
  OPERATIONS,
  search,
} from "../../src/engine/handlers/index.ts";
import { openProjectStore, projectDbPath } from "../../src/engine/index.ts";
import { type Actor, SEARCH_LIMIT_MAX, type Store } from "../../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "test-host" };

let project: string;
let store: Store;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-handlers-"));
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

/** The refusal a call throws, so a test can check both its kind and that it names what is allowed. */
function refusal(call: () => unknown): HandlerError {
  try {
    call();
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a HandlerError, but the call succeeded");
}

describe("project store", () => {
  test("lives at .tmb/trajectory.db in the project", () => {
    expect(projectDbPath(project)).toBe(path.join(project, ".tmb", "trajectory.db"));
    expect(existsSync(projectDbPath(project))).toBe(true);
  });

  test("is refused as missing without create", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "tmb-empty-"));
    try {
      const opened = openProjectStore(empty, { create: false });
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error.failure).toBe("missing");
      expect(existsSync(path.join(empty, ".tmb"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("input validation", () => {
  test("refuses a field the operation does not take, naming the allowed ones", () => {
    const error = refusal(() => issueCreate(store, HUMAN, { title: "x", colour: "red" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("does not take colour");
    expect(error.message).toContain("allowed: title, body, milestone");
  });

  test("refuses input that is not an object", () => {
    expect(refusal(() => issueList(store, HUMAN, "open")).message).toContain("takes an object");
    expect(refusal(() => issueList(store, HUMAN, null)).code).toBe("invalid_input");
  });

  test("names a missing required field", () => {
    expect(refusal(() => discussionAppend(store, HUMAN, { body: "b", kind: "note" })).message).toContain("needs issue_id");
  });

  test("refuses a blank title", () => {
    expect(refusal(() => issueCreate(store, HUMAN, { title: "   " })).message).toContain("title must be text that is not blank");
  });

  test("refuses a value of the wrong type", () => {
    expect(refusal(() => issueCreate(store, HUMAN, { title: 7 })).message).toContain("title must be");
  });

  test("names the allowed values of an enum", () => {
    expect(refusal(() => issueList(store, HUMAN, { state: "done" })).message).toContain("state must be one of open, closed");
    const id = issueCreate(store, HUMAN, { title: "x" }).id;
    expect(refusal(() => discussionAppend(store, HUMAN, { issue_id: id, body: "b", kind: "idea" })).message).toContain(
      "kind must be one of note, decision",
    );
  });

  test("refuses a malformed id and accepts one in lower case", () => {
    expect(refusal(() => issueGet(store, HUMAN, { id: "42" })).message).toContain("26-character record id");
    const id = issueCreate(store, HUMAN, { title: "x" }).id;
    expect(issueGet(store, HUMAN, { id: id.toLowerCase() }).issue.id).toBe(id);
  });

  test("bounds the search limit", () => {
    expect(refusal(() => search(store, HUMAN, { query: "x", limit: 0 })).message).toContain(`from 1 to ${SEARCH_LIMIT_MAX}`);
    expect(refusal(() => search(store, HUMAN, { query: "x", limit: 2.5 })).code).toBe("invalid_input");
    expect(refusal(() => search(store, HUMAN, { query: " " })).code).toBe("invalid_input");
  });

  test("every operation's schema forbids unknown fields and lists its required ones as properties", () => {
    for (const [name, operation] of Object.entries(OPERATIONS)) {
      expect(operation.inputSchema.additionalProperties, name).toBe(false);
      for (const field of operation.inputSchema.required) expect(Object.keys(operation.inputSchema.properties), name).toContain(field);
      expect(operation.description.length, name).toBeGreaterThan(40);
    }
  });
});

describe("issue_create", () => {
  test("records the issue with its actor and returns it", () => {
    const issue = issueCreate(store, WORKER, { title: "Add search", body: "Find things", milestone: "Level 1" });
    expect(issue).toMatchObject({ title: "Add search", body: "Find things", milestone: "Level 1", state: "open", createdBy: WORKER });
    expect(history(store, HUMAN, { id: issue.id })[0]?.actor).toEqual(WORKER);
  });

  test("a blank milestone means none", () => {
    expect(issueCreate(store, HUMAN, { title: "x", milestone: " " }).milestone).toBeNull();
  });
});

describe("issue_list", () => {
  test("returns summaries, filtered by state", () => {
    const open = issueCreate(store, HUMAN, { title: "Open one", body: "a long body" });
    const closed = issueCreate(store, HUMAN, { title: "Closed one" });
    issueUpdate(store, HUMAN, { id: closed.id, state: "closed" });

    expect(issueList(store, HUMAN, {}).map((issue) => issue.id)).toEqual([open.id, closed.id]);
    expect(issueList(store, HUMAN, { state: "open" })).toEqual([
      { id: open.id, title: "Open one", state: "open", milestone: null, snippet: "a long body" },
    ]);
    expect(issueList(store, HUMAN, { state: "closed" }).map((issue) => issue.id)).toEqual([closed.id]);
  });
});

describe("issue_get", () => {
  test("carries the discussions and the newest decision", () => {
    const issue = issueCreate(store, HUMAN, { title: "Pick a store" });
    discussionAppend(store, HUMAN, { issue_id: issue.id, kind: "decision", body: "Use SQLite" });
    discussionAppend(store, WORKER, { issue_id: issue.id, kind: "note", body: "Checked FTS5" });
    const newest = discussionAppend(store, HUMAN, { issue_id: issue.id, kind: "decision", body: "Use SQLite with WAL" });

    const detail = issueGet(store, HUMAN, { id: issue.id });
    expect(detail.issue.id).toBe(issue.id);
    expect(detail.discussions.map((discussion) => discussion.body)).toEqual(["Use SQLite", "Checked FTS5", "Use SQLite with WAL"]);
    expect(detail.newestDecision).toEqual(newest);
  });

  test("has no decision until one is recorded", () => {
    const issue = issueCreate(store, HUMAN, { title: "x" });
    discussionAppend(store, HUMAN, { issue_id: issue.id, kind: "note", body: "just a note" });
    expect(issueGet(store, HUMAN, { id: issue.id }).newestDecision).toBeNull();
  });

  test("says when the issue does not exist", () => {
    const error = refusal(() => issueGet(store, HUMAN, { id: "01KA0000000000000000000000" }));
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("no issue 01KA0000000000000000000000");
  });
});

describe("issue_update", () => {
  test("changes only the fields given and records the actor", () => {
    const issue = issueCreate(store, HUMAN, { title: "Old", body: "Body", milestone: "M1" });
    const result = issueUpdate(store, WORKER, { id: issue.id, title: "New", milestone: "" });
    expect(result.changed.sort()).toEqual(["milestone", "title"]);
    expect(result.issue).toMatchObject({ title: "New", body: "Body", milestone: null, state: "open" });
    expect(history(store, HUMAN, { id: issue.id })[1]?.actor).toEqual(WORKER);
  });

  test("records nothing when nothing changes", () => {
    const issue = issueCreate(store, HUMAN, { title: "x" });
    issueUpdate(store, HUMAN, { id: issue.id, state: "closed" });
    expect(issueUpdate(store, HUMAN, { id: issue.id, state: "closed" }).changed).toEqual([]);
    expect(history(store, HUMAN, { id: issue.id })).toHaveLength(2);
  });

  test("needs a change, and an issue that exists", () => {
    const issue = issueCreate(store, HUMAN, { title: "x" });
    expect(refusal(() => issueUpdate(store, HUMAN, { id: issue.id })).message).toContain("at least one of state, title, body, milestone");
    expect(refusal(() => issueUpdate(store, HUMAN, { id: "01KA0000000000000000000000", state: "closed" })).code).toBe("not_found");
    expect(refusal(() => issueUpdate(store, HUMAN, { id: issue.id, title: "" })).code).toBe("invalid_input");
  });
});

describe("discussion_append", () => {
  test("records a note or a decision with its actor", () => {
    const issue = issueCreate(store, HUMAN, { title: "x" });
    const note = discussionAppend(store, WORKER, { issue_id: issue.id, kind: "note", body: "seen" });
    expect(note).toMatchObject({ issueId: issue.id, kind: "note", body: "seen", createdBy: WORKER });
  });

  test("refuses a missing issue and a blank body", () => {
    expect(refusal(() => discussionAppend(store, HUMAN, { issue_id: "01KA0000000000000000000000", kind: "note", body: "b" })).code).toBe(
      "not_found",
    );
    const issue = issueCreate(store, HUMAN, { title: "x" });
    expect(refusal(() => discussionAppend(store, HUMAN, { issue_id: issue.id, kind: "note", body: "\n" })).code).toBe("invalid_input");
  });
});

describe("search", () => {
  test("finds issues and discussions by their words", () => {
    const issue = issueCreate(store, HUMAN, { title: "Ranking snippets" });
    const decision = discussionAppend(store, HUMAN, { issue_id: issue.id, kind: "decision", body: "Rank with bm25 weights" });
    const hits = search(store, HUMAN, { query: "bm25" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "discussion", id: decision.id, issueId: issue.id, title: "Ranking snippets" });
    expect(search(store, HUMAN, { query: "snippets", limit: 1 })[0]?.id).toBe(issue.id);
  });
});

describe("history", () => {
  test("lists every event of the record, oldest first, and refuses an unknown id", () => {
    const issue = issueCreate(store, HUMAN, { title: "x" });
    issueUpdate(store, WORKER, { id: issue.id, state: "closed" });
    expect(history(store, HUMAN, { id: issue.id }).map((event) => [event.type, event.actor.kind])).toEqual([
      ["created", "human"],
      ["updated", "agent"],
    ]);
    expect(refusal(() => history(store, HUMAN, { id: "01KA0000000000000000000000" })).code).toBe("not_found");
  });
});
