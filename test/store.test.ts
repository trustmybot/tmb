import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIdFactory, idTime, isId, newId } from "../src/engine/ids.ts";
import { type Actor, ActorError, SCHEMA_VERSION, SNIPPET_MAX, type Store, openStore } from "../src/engine/store/index.ts";
import { PROJECTION_TABLES, SCHEMA_STEPS } from "../src/engine/store/schema.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-b" };

let dir: string;
let dbPath: string;
let store: Store | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tmb-store-"));
  dbPath = path.join(dir, "tmb.db");
});

afterEach(() => {
  store?.close();
  store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function open(): Store {
  const result = openStore(dbPath, { create: true });
  if (!result.ok) throw result.error;
  store = result.store;
  return store;
}

/** A second connection to the same file, for looking at the tables the store keeps. */
function peek<T>(read: (db: Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function snapshot(db: Database): Record<string, unknown[]> {
  const tables: Record<string, unknown[]> = {};
  for (const table of PROJECTION_TABLES) tables[table] = db.query(`SELECT * FROM ${table} ORDER BY id`).all();
  tables.search = db.query("SELECT * FROM search ORDER BY record_id").all();
  return tables;
}

describe("openStore", () => {
  test("creates a database at the current schema version with WAL and foreign keys", () => {
    open();
    expect(SCHEMA_VERSION).toBe(5);
    peek((db) => {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    });
    const s = store!;
    expect(() => s.appendDiscussion(HUMAN, { issueId: newId(), kind: "note", body: "orphan" })).toThrow(/FOREIGN KEY/);
  });

  /**
   * Leaves a database at schema `version` as an older tmb wrote it: an issue, a decision on it
   * and a task, each as its event and its projection row.
   */
  function oldDatabase(version: number): { issueId: string; discussionId: string; taskId: string } {
    const old = new Database(dbPath, { create: true });
    for (const step of SCHEMA_STEPS.slice(0, version)) old.run(step);
    old.run(`PRAGMA user_version = ${version}`);
    const at = "2026-11-01T00:00:00.000Z";
    const by = JSON.stringify(HUMAN);
    const event = (kind: string, id: string, data: Record<string, unknown>) =>
      old
        .query("INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at) VALUES (?, ?, ?, 'created', ?, 'human', NULL, NULL, ?)")
        .run(newId(), kind, id, JSON.stringify(data), at);
    const [issueId, discussionId, taskId] = [newId(), newId(), newId()];
    event("issue", issueId, { title: "kept goal", body: "from before", milestone: null });
    old.query("INSERT INTO issues (id, title, body, created_by, created_at, updated_at) VALUES (?, 'kept goal', 'from before', ?, ?, ?)").run(issueId, by, at, at);
    old.query("INSERT INTO search (record_kind, record_id, issue_id, title, body) VALUES ('issue', ?, ?, 'kept goal', 'from before')").run(issueId, issueId);
    event("discussion", discussionId, { issue_id: issueId, kind: "decision", body: "kept decision" });
    old.query("INSERT INTO discussions (id, issue_id, kind, body, created_by, created_at) VALUES (?, ?, 'decision', 'kept decision', ?, ?)").run(discussionId, issueId, by, at);
    old.query("INSERT INTO search (record_kind, record_id, issue_id, title, body) VALUES ('discussion', ?, ?, '', 'kept decision')").run(discussionId, issueId);
    event("task", taskId, { issue_id: issueId, title: "kept task", spec: "", state: "closed", branch: "tmb/old", commit_sha: "abc1234" });
    old
      .query("INSERT INTO tasks (id, issue_id, title, spec, state, branch, commit_sha, created_by, created_at, updated_at) VALUES (?, ?, 'kept task', '', 'closed', 'tmb/old', 'abc1234', ?, ?, ?)")
      .run(taskId, issueId, by, at, at);
    old.close();
    return { issueId, discussionId, taskId };
  }

  for (const version of [1, 2, 3]) {
    test(`upgrades a version-${version} database in place, keeping its records`, () => {
      const records = oldDatabase(version);
      const result = openStore(dbPath, { create: false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      store = result.store;
      expect(store.getIssue(records.issueId)).toMatchObject({ title: "kept goal", body: "from before", state: "open" });
      expect(store.newestDecision(records.issueId)).toMatchObject({ id: records.discussionId, body: "kept decision" });
      expect(store.search("decision").map((hit) => hit.id)).toEqual([records.discussionId]);
      expect(store.getTask(records.taskId)).toMatchObject({ title: "kept task", state: "closed", commitSha: "abc1234", featureId: null, kind: null });
      expect(store.history(records.taskId)).toHaveLength(1);

      const before = peek(snapshot);
      store.rebuildProjections();
      expect(peek(snapshot)).toEqual(before);
      const featureId = store.createFeature(PLANNER, { name: "feat/after", baseBranch: "main", baseCommit: "abc1234" });
      expect(store.findFeature("feat/after")).toMatchObject({ id: featureId, state: "open" });
      const db = new Database(dbPath);
      try {
        expect(() => db.run("DELETE FROM events")).toThrow(/append-only/);
        expect(() => db.run("UPDATE events SET type = 'tampered'")).toThrow(/append-only/);
        expect((db.query("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(4);
      } finally {
        db.close();
      }
    });
  }

  test("an upgraded database has the same schema as a new one", () => {
    oldDatabase(1);
    const kept = (() => {
      const result = openStore(path.join(dir, "fresh.db"), { create: true });
      if (!result.ok) throw result.error;
      result.store.close();
      return new Database(path.join(dir, "fresh.db"), { readonly: true });
    })();
    const freshSchema = kept.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    kept.close();

    const result = openStore(dbPath, { create: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    store = result.store;
    const issueId = store.createIssue(HUMAN, { title: "after the upgrade" });
    const taskId = store.appendTask(PLANNER, { issueId, title: "t", worktree: "/w", baseCommit: "abc" });
    expect(store.getTask(taskId)).toMatchObject({ worktree: "/w", baseCommit: "abc" });
    peek((db) => {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(freshSchema);
    });
  });

  test("upgrades a version-1 database once when several processes open it at the same moment", async () => {
    const opener = path.join(dir, "open-once.ts");
    const openModule = path.join(import.meta.dir, "../src/engine/store/open.ts");
    writeFileSync(
      opener,
      `import { openStore } from ${JSON.stringify(openModule)};
const result = openStore(process.argv[2]!, { create: false });
if (!result.ok) { console.error(result.error.message); process.exit(1); }
result.store.close();
`,
    );
    for (let round = 0; round < 3; round++) {
      const roundPath = path.join(dir, `concurrent-${round}.db`);
      const old = new Database(roundPath, { create: true });
      old.run("PRAGMA journal_mode = WAL");
      old.run(SCHEMA_STEPS[0]!);
      old.run("PRAGMA user_version = 1");
      old.close();

      const openers = Array.from({ length: 8 }, () =>
        Bun.spawn([process.execPath, "run", opener, roundPath], { stdout: "pipe", stderr: "pipe" }),
      );
      const outcomes = await Promise.all(
        openers.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })),
      );
      expect(outcomes.filter((outcome) => outcome.code !== 0)).toEqual([]);

      const db = new Database(roundPath, { readonly: true });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
      db.close();
    }
  }, 60_000);

  test("creates a new database once when several processes open it at the same moment", async () => {
    const opener = path.join(dir, "create-once.ts");
    const openModule = path.join(import.meta.dir, "../src/engine/store/open.ts");
    writeFileSync(
      opener,
      `import { openStore } from ${JSON.stringify(openModule)};
const result = openStore(process.argv[2]!, { create: true });
if (!result.ok) { console.error(result.error.message); process.exit(1); }
result.store.close();
`,
    );
    for (let round = 0; round < 5; round++) {
      const roundPath = path.join(dir, `create-${round}.db`);
      const openers = Array.from({ length: 8 }, () =>
        Bun.spawn([process.execPath, "run", opener, roundPath], { stdout: "pipe", stderr: "pipe" }),
      );
      const outcomes = await Promise.all(
        openers.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })),
      );
      expect(outcomes.filter((outcome) => outcome.code !== 0)).toEqual([]);

      const db = new Database(roundPath, { readonly: true });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      db.close();
    }
  }, 60_000);

  test("reopens an existing database without create", () => {
    const id = open().createIssue(HUMAN, { title: "kept" });
    store!.close();
    store = undefined;
    const result = openStore(dbPath, { create: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      store = result.store;
      expect(store.getIssue(id)?.title).toBe("kept");
    }
  });

  test("refuses a missing file without create", () => {
    const result = openStore(dbPath, { create: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failure).toBe("missing");
      expect(result.error.message).toContain(dbPath);
    }
  });

  test("refuses a file that is not SQLite as unreadable", () => {
    writeFileSync(dbPath, "this is plain text, not a database ".repeat(200));
    const result = openStore(dbPath, { create: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failure).toBe("unreadable");
      expect(result.error.message).toMatch(/not a readable SQLite database/);
    }
  });

  test("refuses a corrupt database as unreadable", () => {
    open().createIssue(HUMAN, { title: "about to be damaged" });
    store!.close();
    store = undefined;
    const bytes = readFileSync(dbPath);
    bytes.fill(0xff, 0, 100); // overwrite the SQLite header
    writeFileSync(dbPath, bytes);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    const result = openStore(dbPath, { create: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failure).toBe("unreadable");
  });

  test("refuses a SQLite file that is not a tmb database", () => {
    const db = new Database(dbPath);
    db.run("CREATE TABLE other (x)");
    db.close();
    const result = openStore(dbPath, { create: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failure).toBe("unreadable");
  });

  test("refuses a database made by a newer tmb, naming both versions", () => {
    open();
    store!.close();
    store = undefined;
    const db = new Database(dbPath);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const result = openStore(dbPath, { create: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failure).toBe("newer");
      expect(result.error.message).toContain(`version ${SCHEMA_VERSION + 1}`);
      expect(result.error.message).toContain(`up to version ${SCHEMA_VERSION}`);
    }
  });
});

describe("ids", () => {
  test("10,000 ids are unique, well formed and sorted in the order they were made", () => {
    const ids = Array.from({ length: 10_000 }, () => newId());
    expect(new Set(ids).size).toBe(10_000);
    expect(ids.every(isId)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  test("ids sort by time across factories, and stay monotonic when the clock stands still or steps back", () => {
    let now = 1_700_000_000_000;
    const a = createIdFactory(() => now);
    const b = createIdFactory(() => now);
    const first = a();
    now += 1;
    const later = b();
    expect(later > first).toBe(true);
    expect(idTime(later)).toBe(now);

    const sameMs = [a(), a(), a()];
    expect([...sameMs].sort()).toEqual(sameMs);
    now -= 1000;
    const afterStepBack = a();
    expect(afterStepBack > sameMs[2]!).toBe(true);
  });

  test("a floor id makes the next id sort after it", () => {
    const behind = createIdFactory(() => 1_000);
    const ahead = createIdFactory(() => 9_000)();
    expect(behind(ahead) > ahead).toBe(true);
  });
});

describe("actors", () => {
  test("every write records its actor on the event and on the record", () => {
    const s = open();
    const issueId = s.createIssue(HUMAN, { title: "by the Human" });
    s.updateIssue(PLANNER, issueId, { state: "closed" });
    const noteId = s.appendDiscussion(WORKER, { issueId, kind: "note", body: "by a worker" });

    expect(s.history(issueId).map((event) => event.actor)).toEqual([HUMAN, PLANNER]);
    expect(s.getIssue(issueId)?.createdBy).toEqual(HUMAN);
    expect(s.listDiscussions(issueId)[0]?.createdBy).toEqual(WORKER);
    peek((db) => {
      const rows = db.query("SELECT record_id, actor_kind, actor_role, actor_host FROM events ORDER BY id").all();
      expect(rows).toEqual([
        { record_id: issueId, actor_kind: "human", actor_role: null, actor_host: null },
        { record_id: issueId, actor_kind: "agent", actor_role: "planner", actor_host: "host-a" },
        { record_id: noteId, actor_kind: "agent", actor_role: "worker", actor_host: "host-b" },
      ]);
    });
  });

  test("a write with no actor, or a malformed one, is refused and stores nothing", () => {
    const s = open();
    const missing = undefined as unknown as Actor;
    expect(() => s.createIssue(missing, { title: "nobody" })).toThrow(ActorError);
    expect(() => s.recordAudit(null as unknown as Actor, { what: "nobody" })).toThrow(ActorError);
    expect(() => s.createIssue({ kind: "agent", role: "worker", host: "" } as Actor, { title: "no host" })).toThrow(ActorError);
    expect(() => s.createIssue({ kind: "agent", role: "boss", host: "h" } as unknown as Actor, { title: "bad role" })).toThrow(
      ActorError,
    );
    expect(peek((db) => db.query("SELECT count(*) AS n FROM events").get())).toEqual({ n: 0 });
  });
});

describe("events", () => {
  test("the events table refuses UPDATE and DELETE", () => {
    const s = open();
    s.createIssue(HUMAN, { title: "immutable" });
    const db = new Database(dbPath);
    try {
      expect(() => db.run("UPDATE events SET type = 'tampered'")).toThrow(/append-only/);
      expect(() => db.run("DELETE FROM events")).toThrow(/append-only/);
      expect(db.query("SELECT type FROM events").all()).toEqual([{ type: "created" }]);
    } finally {
      db.close();
    }
  });

  test("history returns a record's events oldest first", () => {
    const s = open();
    const id = s.createIssue(HUMAN, { title: "first", body: "b" });
    s.updateIssue(PLANNER, id, { title: "second" });
    s.updateIssue(PLANNER, id, { milestone: "Level 1" });
    const events = s.history(id);
    expect(events.map((event) => event.type)).toEqual(["created", "updated", "updated"]);
    expect(events.map((event) => event.data)).toEqual([{ title: "first", body: "b", milestone: null }, { title: "second" }, { milestone: "Level 1" }]);
    expect(events.every((event) => event.recordKind === "issue" && event.recordId === id)).toBe(true);
  });

  test("rebuildProjections reproduces every projection and the search index exactly", () => {
    const s = open();
    const issueId = s.createIssue(HUMAN, { title: "Store", body: "event sourced records", milestone: "Level 1" });
    const other = s.createIssue(PLANNER, { title: "Other" });
    s.updateIssue(PLANNER, issueId, { body: "events and projections" });
    s.updateIssue(HUMAN, other, { state: "closed", milestone: null });
    s.appendDiscussion(HUMAN, { issueId, kind: "decision", body: "keep history as events" });
    s.appendDiscussion(PLANNER, { issueId, kind: "note", body: "a note" });
    const featureId = s.createFeature(PLANNER, { name: "feat/x", baseBranch: "main", baseCommit: "abc1234" });
    const taskId = s.appendTask(PLANNER, { issueId, title: "Build the store", spec: "## Goal", branch: "tmb/x", featureId, kind: "code" });
    s.updateTask(WORKER, taskId, { state: "closed", commitSha: "def5678", reviewMode: "agile", pushResult: "skipped", pushDetail: "no origin" });
    s.appendRun(WORKER, { taskId, role: "worker", outcome: "completed", cost: { tokens: 1200 } });
    s.appendCheckRun(WORKER, { taskId, commitSha: "abc1234", result: "pass", endedAt: "2026-11-18T00:00:00.000Z" });
    s.appendReview({ kind: "agent", role: "reviewer", host: "host-c" }, {
      target: { kind: "branch", ref: "feat/x" },
      verdict: "pass",
      findings: [{ id: "F1", severity: "nit" }],
    });
    s.appendGuardDecision(PLANNER, { event: "push", decision: "deny", reason: "no review" });
    s.recordAudit(HUMAN, { what: "waiver", detail: "skip a check once" });

    const before = peek(snapshot);
    for (const table of PROJECTION_TABLES) expect(before[table]!.length).toBeGreaterThan(0);

    // Damage the projections behind the store's back: the rebuild must restore them from the events alone.
    const db = new Database(dbPath);
    db.run("UPDATE issues SET title = 'tampered'");
    db.run("DELETE FROM audit");
    db.run("DELETE FROM search");
    db.close();

    s.rebuildProjections();
    expect(peek(snapshot)).toEqual(before);
  });
});

describe("issues and discussions", () => {
  test("updateIssue changes state, title, body and milestone; an unknown issue is refused", () => {
    const s = open();
    const id = s.createIssue(HUMAN, { title: "t", body: "b" });
    s.updateIssue(PLANNER, id, { state: "closed", title: "t2", body: "b2", milestone: "M1" });
    expect(s.getIssue(id)).toMatchObject({ state: "closed", title: "t2", body: "b2", milestone: "M1" });
    expect(s.listIssues({ state: "open" })).toEqual([]);
    expect(s.listIssues({ state: "closed" }).map((issue) => issue.id)).toEqual([id]);
    expect(() => s.updateIssue(PLANNER, newId(), { state: "closed" })).toThrow(/no issue/);
    expect(() => s.updateIssue(PLANNER, id, {})).toThrow(/must change/);
    expect(s.history(id)).toHaveLength(2);
  });

  test("newestDecision returns the latest decision, not a later note", () => {
    const s = open();
    const issueId = s.createIssue(HUMAN, { title: "decide" });
    expect(s.newestDecision(issueId)).toBeNull();
    s.appendDiscussion(HUMAN, { issueId, kind: "decision", body: "use events" });
    const latest = s.appendDiscussion(PLANNER, { issueId, kind: "decision", body: "use ULIDs too" });
    s.appendDiscussion(WORKER, { issueId, kind: "note", body: "a later note" });
    expect(s.newestDecision(issueId)).toMatchObject({ id: latest, body: "use ULIDs too", createdBy: PLANNER });
    expect(s.listDiscussions(issueId).map((d) => d.kind)).toEqual(["decision", "decision", "note"]);
  });
});

describe("small reads", () => {
  test("search finds an issue by a word in its body and returns a short snippet", () => {
    const s = open();
    const id = s.createIssue(HUMAN, { title: "Record store", body: `${"filler words here ".repeat(100)} the zeppelin lands ${"more ".repeat(100)}` });
    s.createIssue(HUMAN, { title: "Unrelated", body: "nothing to see" });
    const hits = s.search("zeppelin", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "issue", id, issueId: id, title: "Record store", state: "open" });
    expect(hits[0]!.snippet).toContain("zeppelin");
    expect(Array.from(hits[0]!.snippet).length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(Object.keys(hits[0]!)).not.toContain("body");
  });

  test("search covers discussion bodies, follows issue edits and treats query syntax as words", () => {
    const s = open();
    const issueId = s.createIssue(HUMAN, { title: "Plan" });
    const noteId = s.appendDiscussion(PLANNER, { issueId, kind: "note", body: "the gateway refuses pushes" });
    expect(s.search("gateway")).toMatchObject([{ kind: "discussion", id: noteId, issueId, title: "Plan" }]);
    s.updateIssue(HUMAN, issueId, { body: "now about kumquats" });
    expect(s.search("kumquats").map((hit) => hit.id)).toEqual([issueId]);
    expect(s.search('kumquats" OR NOT (')).toEqual([]);
    expect(s.search("   ")).toEqual([]);
    expect(() => s.search("x", 0)).toThrow(RangeError);
  });

  test("listIssues truncates the body to a snippet; getIssue returns it whole", () => {
    const s = open();
    const body = "word ".repeat(500).trim();
    const id = s.createIssue(HUMAN, { title: "Long", body });
    const [summary] = s.listIssues();
    expect(summary).toEqual({ id, title: "Long", state: "open", milestone: null, snippet: expect.any(String) });
    expect(Array.from(summary!.snippet).length).toBe(SNIPPET_MAX);
    expect(summary!.snippet.endsWith("…")).toBe(true);
    expect(s.getIssue(id)?.body).toBe(body);
  });
});

describe("task, run and check run updates", () => {
  test("close a task, end a run and end a check run as events, and survive a rebuild", () => {
    const s = open();
    const issueId = s.createIssue(HUMAN, { title: "parent" });
    const presetId = newId();
    const taskId = s.appendTask(PLANNER, { id: presetId, issueId, title: "a task", state: "open", branch: "tmb/x", worktree: "/w", baseCommit: "b0" });
    expect(taskId).toBe(presetId);
    expect(() => s.appendTask(PLANNER, { id: "not-an-id", issueId, title: "x" })).toThrow(/record id/);
    expect(s.listTasks("open").map((task) => task.id)).toEqual([taskId]);

    const first = s.appendRun(WORKER, { taskId, role: "worker" });
    const other = s.appendRun(WORKER, { role: "worker" });
    expect(s.openRuns("worker").map((run) => run.id)).toEqual([first, other]);
    expect(s.openRuns("worker", taskId).map((run) => run.id)).toEqual([first]);
    s.endRun(WORKER, first, { outcome: "stopped" });
    expect(s.openRuns("worker").map((run) => run.id)).toEqual([other]);

    const checkId = s.appendCheckRun(WORKER, { taskId, commitSha: "c1" });
    expect(s.listCheckRuns(taskId)[0]).toMatchObject({ endedAt: null, result: null, commands: [] });
    s.endCheckRun(WORKER, checkId, { result: "passed", commands: [{ command: "true", status: "passed", exitCode: 0 }] });
    s.updateTask(WORKER, taskId, { state: "closed", commitSha: "c1" });

    expect(s.getTask(taskId)).toMatchObject({ state: "closed", commitSha: "c1", worktree: "/w", baseCommit: "b0" });
    expect(s.listTasks("open")).toEqual([]);
    expect(s.listCheckRuns(taskId)[0]).toMatchObject({ result: "passed", commands: [{ command: "true", status: "passed", exitCode: 0 }] });
    expect(s.history(taskId).map((event) => event.type)).toEqual(["created", "updated"]);
    expect(s.history(checkId).map((event) => event.type)).toEqual(["created", "updated"]);

    const before = peek(snapshot);
    s.rebuildProjections();
    expect(peek(snapshot)).toEqual(before);
  });

  test("a transaction's writes stand or fall together", () => {
    const s = open();
    expect(() =>
      s.transaction(() => {
        s.createIssue(HUMAN, { title: "rolled back" });
        throw new Error("refused");
      }),
    ).toThrow("refused");
    expect(s.listIssues()).toEqual([]);
  });
});

describe("the other records", () => {
  test("tasks, runs, check runs, reviews and guard decisions each append an event and a row", () => {
    const s = open();
    const issueId = s.createIssue(HUMAN, { title: "parent" });
    const taskId = s.appendTask(PLANNER, { issueId, title: "a task" });
    const runId = s.appendRun(WORKER, { taskId, role: "worker", cost: { usd: 0.5 } });
    const plannerRun = s.appendRun(PLANNER, { role: "planner" });
    const checkId = s.appendCheckRun(WORKER, { taskId, commitSha: "deadbeef" });
    const reviewId = s.appendReview(PLANNER, { target: { kind: "commit", ref: "deadbeef" }, verdict: "fail", findings: [] });
    const guardId = s.appendGuardDecision(PLANNER, { event: "edit", decision: "allow", reason: "in scope" });
    const auditId = s.recordAudit(HUMAN, { what: "config", detail: "mode=agile" });

    for (const id of [taskId, runId, plannerRun, checkId, reviewId, guardId, auditId]) {
      expect(isId(id)).toBe(true);
      expect(s.history(id).map((event) => event.type)).toEqual(["created"]);
    }
    peek((db) => {
      expect(db.query("SELECT issue_id, state, created_by FROM tasks").get()).toEqual({
        issue_id: issueId,
        state: "pending",
        created_by: JSON.stringify(PLANNER),
      });
      expect(db.query("SELECT task_id, cost FROM runs WHERE id = ?").get(runId)).toEqual({ task_id: taskId, cost: '{"usd":0.5}' });
      expect(db.query("SELECT task_id FROM runs WHERE id = ?").get(plannerRun)).toEqual({ task_id: null });
      expect(db.query("SELECT commit_sha, ended_at FROM check_runs").get()).toEqual({ commit_sha: "deadbeef", ended_at: null });
      expect(db.query("SELECT target_kind, target, verdict, findings FROM reviews").get()).toEqual({
        target_kind: "commit",
        target: "deadbeef",
        verdict: "fail",
        findings: "[]",
      });
      expect(db.query("SELECT decision, reason FROM guard_decisions").get()).toEqual({ decision: "allow", reason: "in scope" });
      expect(db.query("SELECT what, detail FROM audit").get()).toEqual({ what: "config", detail: "mode=agile" });
    });
  });
});
