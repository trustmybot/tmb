// The planner is told what changed outside its chat: the Human's issue changes, such as the
// dashboard's, and the syncer's, each once, at its session start or before its next turn.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleEvent, openProjectStore, OUTSIDE_CHANGES_HEADING, takeOutsideChanges, writeSetting } from "../../../src/engine/index.ts";
import type { Actor, Store } from "../../../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "claude-code" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "claude-code" };
const SYNCER: Actor = { kind: "tmb", source: "syncer" };

let project: string;
let store: Store;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-outside-"));
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const turn = () => handleEvent({ type: "planner-turn", projectDir: project }).context;

describe("what the planner is told", () => {
  test("the first time nothing is listed: the planner starts from the record as it is", () => {
    store.createIssue(HUMAN, { title: "Old issue" });
    expect(takeOutsideChanges(store)).toBe("");
    expect(takeOutsideChanges(store)).toBe("");
  });

  test("lists the Human's note, decision, edit, close and reopen once, with the issue, the change and when", () => {
    const id = store.createIssue(PLANNER, { title: "Add a dark mode toggle" });
    const other = store.createIssue(PLANNER, { title: "Fix the login typo" });
    takeOutsideChanges(store);

    store.appendDiscussion(HUMAN, { issueId: id, kind: "note", body: "Check the\ncontrast." });
    store.appendDiscussion(HUMAN, { issueId: id, kind: "decision", body: "Ship it behind a flag." });
    store.updateIssue(HUMAN, id, { title: "Add a dark mode switch" });
    store.updateIssue(HUMAN, other, { state: "closed" });
    store.updateIssue(HUMAN, other, { state: "open" });

    const told = takeOutsideChanges(store);
    const lines = told.split("\n").filter((line) => line.startsWith("- "));
    expect(told).toStartWith(`${OUTSIDE_CHANGES_HEADING}\n\n`);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(new RegExp(`^- ${id} "Add a dark mode switch": note added: "Check the contrast.", by the Human at \\d{4}-`));
    expect(lines[1]).toContain(`decision added: "Ship it behind a flag."`);
    expect(lines[2]).toContain(`retitled "Add a dark mode switch"`);
    expect(lines[3]).toContain(`${other} "Fix the login typo": closed`);
    expect(lines[4]).toContain(": reopened, by the Human");
    expect(takeOutsideChanges(store)).toBe("");
  });

  test("leaves out what the planner and the other agents did in their own chats", () => {
    const id = store.createIssue(PLANNER, { title: "Planned" });
    takeOutsideChanges(store);
    store.appendDiscussion(PLANNER, { issueId: id, kind: "note", body: "my own note" });
    store.appendDiscussion(WORKER, { issueId: id, kind: "note", body: "a worker's note" });
    writeSetting(store, HUMAN, "review_mode", "agile");
    expect(takeOutsideChanges(store)).toBe("");
  });

  test("a change the syncer writes joins the same list", () => {
    const id = store.createIssue(PLANNER, { title: "Synced" });
    takeOutsideChanges(store);
    store.updateIssue(SYNCER, id, { state: "closed" });
    expect(takeOutsideChanges(store)).toContain(`${id} "Synced": closed, by the remote, through tmb's syncer at`);
  });

  test("a long list is cut, and the rest is counted as told", () => {
    const id = store.createIssue(PLANNER, { title: "Busy" });
    takeOutsideChanges(store);
    for (let i = 0; i < 5; i++) store.appendDiscussion(HUMAN, { issueId: id, kind: "note", body: `note ${i}` });
    const told = takeOutsideChanges(store, 3);
    expect(told.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(4);
    expect(told).toContain("- …and 2 more changes; issue_get shows each issue in full.");
    expect(takeOutsideChanges(store, 3)).toBe("");
  });
});

describe("when the planner is told", () => {
  test("before its next turn only when something is new, and at a session start, each change once", () => {
    const id = store.createIssue(PLANNER, { title: "Add a dark mode toggle" });
    expect(turn()).toBe("");
    expect(turn()).toBe("");

    store.updateIssue(HUMAN, id, { state: "closed" });
    expect(turn()).toContain(`${id} "Add a dark mode toggle": closed`);
    expect(turn()).toBe("");

    store.appendDiscussion(HUMAN, { issueId: id, kind: "decision", body: "Not needed." });
    const started = handleEvent({ type: "session-start", projectDir: project, unattended: false }).context;
    expect(started).toContain(OUTSIDE_CHANGES_HEADING);
    expect(started).toContain(`decision added: "Not needed."`);
    expect(turn()).toBe("");
  });

  test("the list comes last in the session start's text, after the stable parts", () => {
    const id = store.createIssue(PLANNER, { title: "Tail" });
    turn();
    store.updateIssue(HUMAN, id, { state: "closed" });
    const started = handleEvent({ type: "session-start", projectDir: project, unattended: false }).context;
    expect(started.trimEnd().split("\n").at(-1)).toContain(`${id} "Tail": closed`);
  });

  test("a host set up as the reviewer is not told, and the planner still is later", () => {
    const id = store.createIssue(PLANNER, { title: "Review" });
    turn();
    writeSetting(store, HUMAN, "host_roles", { "claude-code": "reviewer" });
    store.updateIssue(HUMAN, id, { state: "closed" });
    expect(handleEvent({ type: "planner-turn", projectDir: project, host: "claude-code" }).context).toBe("");
    expect(turn()).toContain(`${id} "Review": closed`);
  });

  test("a project with no record says nothing", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "tmb-outside-none-"));
    try {
      expect(handleEvent({ type: "planner-turn", projectDir: empty }).context).toBe("");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
