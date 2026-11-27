import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIdFactory, idTime, isId, newId } from "../../src/engine/ids.ts";
import { type Actor, ActorError, SCHEMA_VERSION, SNIPPET_MAX, type Store, ValueError, openStore } from "../../src/engine/store/index.ts";
import { assertActor } from "../../src/engine/store/actor.ts";
import { PROJECTION_TABLES, SCHEMA_STEPS, runStep } from "../../src/engine/store/schema.ts";
import { tiedProgram } from "../../src/engine/program-tie.ts";
import { reviewModeChosenVia } from "../../src/engine/settings.ts";
import { upgradeAdvice } from "../../src/program.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

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
    expect(SCHEMA_VERSION).toBe(13);
    peek((db) => {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 13 });
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
    for (const step of SCHEMA_STEPS.slice(0, version)) runStep(old, step);
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

  // 8 and 9 take the multi-repo and dropped-task steps on to the run links of version 10 (trustmybot/tmb#163, trustmybot/tmb#170, trustmybot/tmb#135).
  for (const version of [1, 2, 3, 8, 9]) {
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
    const openModule = path.join(import.meta.dir, "../../src/engine/store/open.ts");
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
      runStep(old, SCHEMA_STEPS[0]!);
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
    const openModule = path.join(import.meta.dir, "../../src/engine/store/open.ts");
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

describe("the shape's writer (trustmybot/tmb#89)", () => {
  test("a new or upgraded database names the tmb that wrote its shape", () => {
    const made = openStore(dbPath, { create: true, writer: { version: "1.0.0-dev.3", program: "tmb-dev" } });
    if (!made.ok) throw made.error;
    expect(made.store.shapeWriter()).toEqual({ version: "1.0.0-dev.3", program: "tmb-dev" });
    made.store.close();
    // Opening at the same shape signs nothing again.
    const again = openStore(dbPath, { create: false, writer: { version: "1.0.0", program: "tmb" } });
    if (!again.ok) throw again.error;
    expect(again.store.shapeWriter()).toEqual({ version: "1.0.0-dev.3", program: "tmb-dev" });
    again.store.close();
  });

  test("an older tmb refuses a newer database and names the version that wrote it", () => {
    const made = openStore(dbPath, { create: true });
    if (!made.ok) throw made.error;
    made.store.close();
    const db = new Database(dbPath);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.query("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ version: "9.9.0-dev.4", program: "tmb-dev", shape: SCHEMA_VERSION + 1 }), "shape_writer");
    db.close();
    const result = openStore(dbPath, { create: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failure).toBe("newer");
      expect(result.error.writer).toEqual({ version: "9.9.0-dev.4", program: "tmb-dev" });
      expect(result.error.message).toContain("made by a newer tmb (tmb-dev 9.9.0-dev.4 wrote it)");
      expect(result.error.message).toContain(`reads up to version ${SCHEMA_VERSION}`);
      expect(result.error.message).toContain("run tmb-dev in this project");
      // A command to run, never a version to find: the writer may be a build no channel offers (trustmybot/tmb#173).
      expect(result.error.message).toContain("update this program with `tmb update`");
      expect(result.error.message).not.toContain("9.9.0-dev.4;");
      expect(result.error.message).not.toContain("at least as new");
    }
  });

  test("the way to a newer build is a command: the program's own update, or the installer when it is pinned (trustmybot/tmb#173)", () => {
    expect(upgradeAdvice({ name: "tmb-dev", channel: "dev" }, "0.1.0-dev.75.gh144")).toBe("update this program with `tmb-dev update`");
    expect(upgradeAdvice({ name: "tmb-1.0.0", channel: null }, "1.0.0", "darwin")).toBe(
      "install a newer tmb with `curl -fsSL https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh | TMB_CHANNEL=stable sh`",
    );
    expect(upgradeAdvice({ name: "tmb-1.0.0-rc.2", channel: null }, "1.0.0-rc.2", "win32")).toContain("install.ps1 | iex");
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
    expect(() => s.recordSettingChange(null as unknown as Actor, { key: "host", oldValue: null, newValue: '"nobody"' })).toThrow(ActorError);
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
    const waiverId = s.recordWaiver(HUMAN, { taskId, commitSha: "def5678", reason: "skip a check once" });
    s.recordWaiver(PLANNER, { taskId, commitSha: "fed8765", reason: "skip a check once", carriedFrom: waiverId, detail: { from: "def5678", to: "fed8765" } });
    const reviewed = s.appendReview(PLANNER, { target: { kind: "commit", ref: taskId }, verdict: "pass", commitSha: "def5678" });
    s.appendReview(PLANNER, { target: { kind: "commit", ref: taskId }, verdict: "pass", commitSha: "fed8765", carriedFrom: reviewed, detail: { from: "def5678" } });
    const mark = s.recordReviewMark(PLANNER, { taskId, commitSha: "def5678", kind: "waiver", state: "success", description: "Passed: review waived" });
    s.markSent(PLANNER, mark, "2026-11-18T00:00:01.000Z");
    s.recordSettingChange(HUMAN, { key: "review_mode", oldValue: null, newValue: '"agile"', how: "onboard" });
    s.recordSettingChange(PLANNER, { key: "review_mode", repo: "web", oldValue: null, newValue: '"truest"', how: "planner" });
    const freeze = s.recordFreeze(HUMAN, { reason: "stop the agents" });
    s.liftFreeze(HUMAN, freeze, "2026-11-18T00:00:02.000Z");
    s.recordFeedbackReport(PLANNER, { route: "issue", url: "https://github.com/trustmybot/tmb/issues/1", detail: { title: "t" } });
    s.recordImport(HUMAN, { source: "plugin", repo: "web", detail: { repo: "web", ids: {} } });

    const before = peek(snapshot);
    for (const table of PROJECTION_TABLES) expect(before[table]!.length).toBeGreaterThan(0);

    // Damage the projections behind the store's back: the rebuild must restore them from the events alone.
    const db = new Database(dbPath);
    db.run("UPDATE issues SET title = 'tampered'");
    db.run("DELETE FROM review_marks");
    db.run("UPDATE setting_changes SET new_value = NULL");
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
    const waiverId = s.recordWaiver(HUMAN, { taskId, commitSha: "deadbeef", reason: "a typo" });

    for (const id of [taskId, runId, plannerRun, checkId, reviewId, guardId, waiverId]) {
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
      expect(db.query("SELECT task_id, feature_id, commit_sha, reason FROM waivers").get()).toEqual({ task_id: taskId, feature_id: null, commit_sha: "deadbeef", reason: "a typo" });
    });
  });
});

describe("value lists in the engine, and tmb as an actor (trustmybot/tmb#404)", () => {
  const TMB: Actor = { kind: "tmb", source: "upgrade" };
  const at = "2026-11-01T00:00:00.000Z";

  /**
   * Leaves a version-11 database with one record of every kind whose table had a CHECK on a list,
   * each as its event and its row, as tmb at version 11 wrote them.
   */
  function version11Database(): void {
    const old = new Database(dbPath, { create: true });
    for (const step of SCHEMA_STEPS.slice(0, 11)) runStep(old, step);
    old.run("PRAGMA user_version = 11");
    const human = JSON.stringify(HUMAN);
    const planner = JSON.stringify(PLANNER);
    const event = (kind: string, id: string, actor: Actor, data: Record<string, unknown>) => {
      const agent = actor.kind === "agent" ? actor : null;
      old
        .query("INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at) VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)")
        .run(newId(), kind, id, JSON.stringify(data), actor.kind, agent?.role ?? null, agent?.host ?? null, at);
    };
    const [issue, note, feature, task, run, review, guard, audit] = [newId(), newId(), newId(), newId(), newId(), newId(), newId(), newId()];
    event("issue", issue, HUMAN, { title: "goal", body: "", milestone: "M1" });
    old.query("INSERT INTO issues (id, title, body, milestone, created_by, created_at, updated_at) VALUES (?, 'goal', '', 'M1', ?, ?, ?)").run(issue, human, at, at);
    old.query("INSERT INTO search (record_kind, record_id, issue_id, title, body) VALUES ('issue', ?, ?, 'goal', '')").run(issue, issue);
    event("discussion", note, PLANNER, { issue_id: issue, kind: "note", body: "a note" });
    old.query("INSERT INTO discussions (id, issue_id, kind, body, created_by, created_at) VALUES (?, ?, 'note', 'a note', ?, ?)").run(note, issue, planner, at);
    old.query("INSERT INTO search (record_kind, record_id, issue_id, title, body) VALUES ('discussion', ?, ?, '', 'a note')").run(note, issue);
    event("feature", feature, PLANNER, { name: "feat/old", base_branch: "main", base_commit: "abc1234", repo: null });
    old
      .query("INSERT INTO features (id, name, base_branch, base_commit, state, created_by, created_at, updated_at) VALUES (?, 'feat/old', 'main', 'abc1234', 'open', ?, ?, ?)")
      .run(feature, planner, at, at);
    event("task", task, PLANNER, { issue_id: issue, title: "t", spec: "", state: "open", feature_id: feature });
    old.query("INSERT INTO tasks (id, issue_id, title, spec, state, feature_id, created_by, created_at, updated_at) VALUES (?, ?, 't', '', 'open', ?, ?, ?, ?)").run(task, issue, feature, planner, at, at);
    event("run", run, PLANNER, { task_id: task, role: "reviewer", started_at: at, cost: [{ model: "m" }], feature_id: feature });
    old.query("INSERT INTO runs (id, task_id, role, started_at, cost, feature_id, created_by, created_at) VALUES (?, ?, 'reviewer', ?, ?, ?, ?, ?)").run(run, task, at, '[{"model":"m"}]', feature, planner, at);
    event("review", review, PLANNER, { target_kind: "branch", target: "feat/old", verdict: "pass", findings: [], feature_id: feature, commit_sha: "abc1234", run_id: run });
    old
      .query("INSERT INTO reviews (id, target_kind, target, verdict, findings, feature_id, commit_sha, run_id, created_by, created_at) VALUES (?, 'branch', 'feat/old', 'pass', '[]', ?, 'abc1234', ?, ?, ?)")
      .run(review, feature, run, planner, at);
    event("guard_decision", guard, PLANNER, { event: "{}", decision: "deny", reason: "no" });
    old.query("INSERT INTO guard_decisions (id, event, decision, reason, created_by, created_at) VALUES (?, '{}', 'deny', 'no', ?, ?)").run(guard, planner, at);
    const waived = JSON.stringify({ feature_id: feature, feature: "feat/old", commit: "abc1234", reason: "a typo" });
    event("audit", audit, HUMAN, { what: "waiver", detail: waived });
    old.query("INSERT INTO audit (id, what, detail, created_by, created_at) VALUES (?, 'waiver', ?, ?, ?)").run(audit, waived, human, at);
    old.close();
  }

  /** Every row of every projection table the database has, and every event. */
  function everything(db: Database): Record<string, unknown[]> {
    const tables: Record<string, unknown[]> = {};
    for (const table of PROJECTION_TABLES) {
      if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === null) continue;
      tables[table] = db.query(`SELECT * FROM ${table} ORDER BY id`).all();
    }
    tables.search = db.query("SELECT * FROM search ORDER BY record_id").all();
    return { ...tables, events: db.query("SELECT id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at FROM events ORDER BY id").all() };
  }

  /** What an upgrade from `before` kept: each table it had, in the columns it had, and its events, which come first. */
  function kept(before: Record<string, unknown[]>, after: Record<string, unknown[]>): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const key of Object.keys(before)) {
      const rows = key === "events" ? after.events!.slice(0, before.events!.length) : after[key]!;
      out[key] = rows.map((row, i) => {
        const columns = Object.keys((before[key]![i] ?? {}) as object);
        return Object.fromEntries(Object.entries(row as object).filter(([column]) => columns.includes(column)));
      });
    }
    return out;
  }

  test("an upgrade from version 11 keeps every event and every row, links included, and ends with a new database's shape", () => {
    version11Database();
    const before = peek(everything);
    const result = openStore(dbPath, { create: false });
    if (!result.ok) throw result.error;
    store = result.store;
    const upgraded = peek(everything);
    expect(kept(before, upgraded)).toEqual(before);
    // The old waiver is a waivers row now, written as a new event by tmb's upgrade.
    expect(upgraded.events!.slice(before.events!.length)).toMatchObject([{ record_kind: "waiver", actor_kind: "tmb" }]);
    expect(store.listWaivers()).toMatchObject([{ featureId: before.features![0] && (before.features![0] as { id: string }).id, commitSha: "abc1234", reason: "a typo", createdBy: TMB }]);
    peek((db) => {
      expect(db.query("SELECT DISTINCT actor_source FROM events ORDER BY actor_source").all()).toEqual([{ actor_source: null }, { actor_source: "upgrade" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    store.rebuildProjections();
    expect(peek(everything)).toEqual(upgraded);

    const fresh = openStore(path.join(dir, "fresh.db"), { create: true });
    if (!fresh.ok) throw fresh.error;
    fresh.store.close();
    const shape = (file: string) => {
      const db = new Database(file, { readonly: true });
      try {
        return db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      } finally {
        db.close();
      }
    };
    expect(shape(dbPath)).toEqual(shape(path.join(dir, "fresh.db")));
  });

  test("the links still hold after the upgrade: a row that points at nothing is refused", () => {
    version11Database();
    const result = openStore(dbPath, { create: false });
    if (!result.ok) throw result.error;
    store = result.store;
    expect(() => store!.appendDiscussion(HUMAN, { issueId: newId(), kind: "note", body: "orphan" })).toThrow(/FOREIGN KEY/);
  });

  test("the schema checks shape only: a value off today's lists is a row, not a reshaped table", () => {
    open();
    const db = new Database(dbPath);
    try {
      db.run("PRAGMA foreign_keys = ON");
      const by = JSON.stringify(HUMAN);
      db.query("INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at) VALUES (?, 'milestone', ?, 'created', '{}', 'agent', 'architect', 'h', ?)").run(newId(), newId(), at);
      const issue = newId();
      db.query("INSERT INTO issues (id, title, state, created_by, created_at, updated_at) VALUES (?, 't', 'triaged', ?, ?, ?)").run(issue, by, at, at);
      db.query("INSERT INTO discussions (id, issue_id, kind, body, created_by, created_at) VALUES (?, ?, 'comment', 'b', ?, ?)").run(newId(), issue, by, at);
      db.query("INSERT INTO runs (id, role, started_at, created_by, created_at) VALUES (?, 'architect', ?, ?, ?)").run(newId(), at, by, at);
      db.query("INSERT INTO guard_decisions (id, event, decision, reason, created_by, created_at) VALUES (?, '{}', 'ask', 'r', ?, ?)").run(newId(), by, at);
      // Shape still holds: which actor columns go together, JSON, and text that is not blank.
      const actorRow = (kind: string, role: string | null, host: string | null, source: string | null) =>
        db.query("INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, actor_source, at) VALUES (?, 'issue', ?, 'created', '{}', ?, ?, ?, ?, ?)").run(newId(), newId(), kind, role, host, source, at);
      expect(() => actorRow("tmb", null, null, null)).toThrow(/CHECK/);
      expect(() => actorRow("tmb", null, "h", "syncer")).toThrow(/CHECK/);
      expect(() => actorRow("human", null, null, "syncer")).toThrow(/CHECK/);
      expect(() => actorRow("agent", "worker", "h", "syncer")).toThrow(/CHECK/);
      expect(() => actorRow("agent", "worker", null, null)).toThrow(/CHECK/);
      expect(() => actorRow("robot", null, null, null)).toThrow(/CHECK/);
      expect(() => db.query("INSERT INTO issues (id, title, created_by, created_at, updated_at) VALUES (?, ' ', ?, ?, ?)").run(newId(), by, at, at)).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  test("the engine refuses a value that is not on its list, and stores nothing", () => {
    const s = open();
    const issueId = s.createIssue(HUMAN, { title: "goal" });
    const events = () => peek((db) => db.query("SELECT count(*) AS n FROM events").get());
    const before = events();
    expect(() => s.updateIssue(HUMAN, issueId, { state: "triaged" as never })).toThrow(ValueError);
    expect(() => s.appendDiscussion(HUMAN, { issueId, kind: "comment" as never, body: "b" })).toThrow(ValueError);
    expect(() => s.appendRun(PLANNER, { role: "architect" as never })).toThrow(ValueError);
    expect(() => s.appendReview(PLANNER, { target: { kind: "tag" as never, ref: "v1" }, verdict: "pass" })).toThrow(ValueError);
    expect(() => s.appendGuardDecision(PLANNER, { event: "{}", decision: "ask" as never, reason: "r" })).toThrow(ValueError);
    expect(() => s.createIssue({ kind: "agent", role: "architect", host: "h" } as unknown as Actor, { title: "t" })).toThrow(ActorError);
    expect(events()).toEqual(before);
  });

  test("tmb writes as itself, named by its source, and its actor survives a rebuild", () => {
    const s = open();
    const issueId = s.createIssue(TMB, { title: "made by an upgrade" });
    s.updateIssue({ kind: "tmb", source: "syncer" }, issueId, { state: "closed" });
    expect(s.history(issueId).map((event) => event.actor)).toEqual([TMB, { kind: "tmb", source: "syncer" }]);
    expect(s.getIssue(issueId)?.createdBy).toEqual(TMB);
    peek((db) => {
      expect(db.query("SELECT actor_kind, actor_role, actor_host, actor_source FROM events ORDER BY id").all()).toEqual([
        { actor_kind: "tmb", actor_role: null, actor_host: null, actor_source: "upgrade" },
        { actor_kind: "tmb", actor_role: null, actor_host: null, actor_source: "syncer" },
      ]);
    });
    const before = peek(snapshot);
    s.rebuildProjections();
    expect(peek(snapshot)).toEqual(before);
  });

  test("a tmb actor with no source, an unknown one, or a role is refused; one from outside the engine always is", () => {
    const s = open();
    expect(() => s.createIssue({ kind: "tmb" } as unknown as Actor, { title: "t" })).toThrow(ActorError);
    expect(() => s.createIssue({ kind: "tmb", source: "cron" } as unknown as Actor, { title: "t" })).toThrow(ActorError);
    expect(() => s.createIssue({ kind: "tmb", source: "syncer", role: "worker" } as unknown as Actor, { title: "t" })).toThrow(ActorError);
    expect(() => s.createIssue({ kind: "human", source: "syncer" } as unknown as Actor, { title: "t" })).toThrow(ActorError);
    expect(() => assertActor({ kind: "tmb", source: "syncer" })).toThrow(/only tmb's own code/);
    expect(peek((db) => db.query("SELECT count(*) AS n FROM events").get())).toEqual({ n: 0 });
  });
});

describe("the audit trail goes; each entry moves to its own table (trustmybot/tmb#408)", () => {
  const at = (n: number) => `2026-11-0${1 + Math.floor(n / 10)}T00:00:${String(n % 60).padStart(2, "0")}.000Z`;

  /**
   * Leaves a version-12 database as tmb at version 12 wrote it: a task, a feature branch, a review
   * of each, and one audit entry of every kind tmb wrote, each as its event and its row.
   */
  function version12Database() {
    const old = new Database(dbPath, { create: true });
    for (const step of SCHEMA_STEPS.slice(0, 12)) runStep(old, step);
    old.run("PRAGMA user_version = 12");
    const human = JSON.stringify(HUMAN);
    const planner = JSON.stringify(PLANNER);
    const event = (kind: string, id: string, actor: Actor, data: Record<string, unknown>, when: string) => {
      const agent = actor.kind === "agent" ? actor : null;
      old
        .query("INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at) VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)")
        .run(newId(), kind, id, JSON.stringify(data), actor.kind, agent?.role ?? null, agent?.host ?? null, when);
    };
    const [issue, feature, task, taskReview, featureReview] = [newId(), newId(), newId(), newId(), newId()];
    event("issue", issue, HUMAN, { title: "goal", body: "", milestone: null }, at(0));
    old.query("INSERT INTO issues (id, title, body, created_by, created_at, updated_at) VALUES (?, 'goal', '', ?, ?, ?)").run(issue, human, at(0), at(0));
    old.query("INSERT INTO search (record_kind, record_id, issue_id, title, body) VALUES ('issue', ?, ?, 'goal', '')").run(issue, issue);
    event("feature", feature, PLANNER, { name: "feat/x", base_branch: "main", base_commit: "b0", repo: null }, at(0));
    old.query("INSERT INTO features (id, name, base_branch, base_commit, state, created_by, created_at, updated_at) VALUES (?, 'feat/x', 'main', 'b0', 'open', ?, ?, ?)").run(feature, planner, at(0), at(0));
    event("task", task, PLANNER, { issue_id: issue, title: "t", spec: "", state: "closed", commit_sha: "c1" }, at(0));
    old.query("INSERT INTO tasks (id, issue_id, title, spec, state, commit_sha, created_by, created_at, updated_at) VALUES (?, ?, 't', '', 'closed', 'c1', ?, ?, ?)").run(task, issue, planner, at(0), at(0));
    const review = (id: string, kind: string, target: string, commit: string, featureId: string | null) => {
      event("review", id, PLANNER, { target_kind: kind, target, verdict: "pass", findings: [{ id: "F1" }], feature_id: featureId, commit_sha: commit, run_id: null }, at(0));
      old
        .query("INSERT INTO reviews (id, target_kind, target, verdict, findings, feature_id, commit_sha, created_by, created_at) VALUES (?, ?, ?, 'pass', '[{\"id\":\"F1\"}]', ?, ?, ?, ?)")
        .run(id, kind, target, featureId, commit, planner, at(0));
    };
    review(taskReview, "commit", task, "c1", null);
    review(featureReview, "branch", "feat/x", "f1", feature);

    const entries: { id: string; what: string; detail: unknown; by: Actor }[] = [];
    const audit = (what: string, detail: unknown, by: Actor = HUMAN): string => {
      const id = newId();
      const text = typeof detail === "string" ? detail : JSON.stringify(detail);
      const when = at(entries.length + 1);
      event("audit", id, by, { what, detail: text }, when);
      old.query("INSERT INTO audit (id, what, detail, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, what, text, JSON.stringify(by), when);
      entries.push({ id, what, detail, by });
      return id;
    };
    const tie = { program: "tmb", version: "1.0.0", command: ["/bin/tmb"] };
    audit("setting:base_branch", '"main"');
    audit("setting:review_mode", '"agile"');
    audit("review_mode_chosen", "onboard");
    audit("review_mode_chosen", "planner", PLANNER);
    audit("setting:repos", { web: { base_branch: "main" } });
    audit("repo_review_mode_chosen", { repo: "web", review_mode: "truest", via: "planner" }, PLANNER);
    audit("program", tie);
    audit("tmb-moved", { program: "tmb", from: "/old/tmb", to: "/new/tmb" });
    audit("host-refresh", { program: "tmb", from: "1.0.0", to: "1.1.0", hosts: ["claude-code"], changed: [".claude/agents/worker.md"] });
    audit("task_waiver", { task_id: task, commit: "c2", reason: "a typo" });
    audit("waiver", { feature_id: feature, feature: "feat/x", commit: "f2", reason: "docs only" });
    audit("review_carry", { task_id: task, from: "c1", to: "c3", onto: "main" }, PLANNER);
    audit("review_carry", { task_id: task, from: "c2", to: "c4", onto: "main" }, PLANNER);
    const uncovered = audit("review_carry", { task_id: task, from: "c9", to: "c5", onto: "main" }, PLANNER);
    const mark = audit("review_mark", { commit: "c1", state: "success", description: "Passed: reviewed", sent: false }, PLANNER);
    audit("review_mark_sent", { mark_id: mark }, PLANNER);
    audit("review_mark", { commit: "f2", state: "success", description: "Passed: review waived", sent: true });
    const unmatched = audit("review_mark", { commit: "nowhere", state: "failure", description: "Failed: changes needed", sent: true }, PLANNER);
    audit("feature_update", { feature_id: feature, feature: "feat/x", base: "b1", from: "f1", to: "f3", how: "merged" }, PLANNER);
    audit("feedback", { route: "issue", url: "https://github.com/trustmybot/tmb/issues/9", title: "a bug" }, PLANNER);
    audit("feedback", { route: "form", opened: true, title: "an idea" }, PLANNER);
    audit("migration.plugin", { repo: "web", into: null, ids: { tasks: {} }, schemaVersion: 3 });
    const unknown = audit("setup", "host claude-code installed");
    old.close();
    return { issue, feature, task, taskReview, featureReview, entries, tie, leftBehind: [uncovered, unmatched, unknown] };
  }

  function shape(file: string): unknown[] {
    const db = new Database(file, { readonly: true });
    try {
      return db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    } finally {
      db.close();
    }
  }

  test("an upgraded database has a new one's shape, no audit table, and every old event as it was", () => {
    version12Database();
    const oldEvents = peek((db) => db.query("SELECT * FROM events ORDER BY id").all());
    const result = openStore(dbPath, { create: false });
    if (!result.ok) throw result.error;
    store = result.store;
    const fresh = openStore(path.join(dir, "fresh.db"), { create: true });
    if (!fresh.ok) throw fresh.error;
    fresh.store.close();
    expect(shape(dbPath)).toEqual(shape(path.join(dir, "fresh.db")));
    peek((db) => {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 13 });
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'audit'").all()).toEqual([]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const all = db.query("SELECT * FROM events ORDER BY id").all();
      expect(all.slice(0, oldEvents.length)).toEqual(oldEvents);
    });
  });

  test("no fact is lost: each entry is a new event by tmb's upgrade naming it, but the three that match nothing", () => {
    const seeded = version12Database();
    const result = openStore(dbPath, { create: false });
    if (!result.ok) throw result.error;
    store = result.store;
    const moved = peek(
      (db) =>
        db.query("SELECT record_kind, data, actor_kind, actor_source, at FROM events WHERE actor_source = 'upgrade' ORDER BY id").all() as {
          record_kind: string;
          data: string;
          actor_kind: string;
          at: string;
        }[],
    );
    expect(moved.every((event) => event.actor_kind === "tmb")).toBe(true);
    const named = new Set(moved.flatMap((event) => {
      const data = JSON.parse(event.data) as { audit_id?: string; chosen_audit_id?: string };
      return [data.audit_id, data.chosen_audit_id].filter((id): id is string => id !== undefined);
    }));
    expect(seeded.entries.map((entry) => entry.id).filter((id) => !named.has(id))).toEqual(seeded.leftBehind);
    // Each new event keeps the time of the entry it moves.
    const times = new Map(seeded.entries.map((entry, n) => [entry.id, at(n + 1)]));
    for (const event of moved) {
      const id = (JSON.parse(event.data) as { audit_id: string }).audit_id;
      if (event.record_kind !== "feature") expect(event.at).toBe(times.get(id)!);
    }
  });

  test("the rows say what the entries said, and the gates read them", () => {
    const seeded = version12Database();
    const result = openStore(dbPath, { create: false });
    if (!result.ok) throw result.error;
    store = result.store;
    const s = store;
    const TMB: Actor = { kind: "tmb", source: "upgrade" };

    // Settings: the value in force is the newest that set one; the mode's change names how it was chosen.
    expect(s.newestSettingChange("base_branch", null, true)).toMatchObject({ oldValue: null, newValue: '"main"', createdBy: TMB });
    expect(s.listSettingChanges("review_mode").map((c) => [c.repo, c.oldValue, c.newValue, c.how])).toEqual([
      [null, null, '"agile"', "onboard"],
      [null, null, null, "planner"],
      ["web", null, '"truest"', "planner"],
    ]);
    expect(s.newestSettingChange("review_mode", null, true)!.newValue).toBe('"agile"');
    expect(reviewModeChosenVia(s)).toBe("planner");

    // The program tie: wired, moved with the tie unchanged, then refreshed to the new version.
    const program = s.listSettingChanges("program");
    expect(program.map((c) => c.newValue && JSON.parse(c.newValue))).toEqual([seeded.tie, seeded.tie, { ...seeded.tie, version: "1.1.0" }]);
    expect(tiedProgram(s)).toEqual({ ...seeded.tie, version: "1.1.0" });
    expect(s.history(program[2]!.id)[0]!.data).toMatchObject({ refresh: { from: "1.0.0", to: "1.1.0", hosts: ["claude-code"] } });

    // Waivers and carries: a carried review copies its verdict; a carry only a waiver covered is a carried waiver.
    const waivers = s.listWaivers();
    expect(waivers.map((w) => [w.taskId, w.featureId, w.commitSha, w.reason, w.carriedFrom])).toEqual([
      [seeded.task, null, "c2", "a typo", null],
      [null, seeded.feature, "f2", "docs only", null],
      [seeded.task, null, "c4", "a typo", waivers[0]!.id],
    ]);
    expect(waivers[2]!.createdBy).toEqual(TMB);
    const carried = peek((db) => db.query("SELECT target_kind, target, verdict, findings, commit_sha, carried_from FROM reviews WHERE carried_from IS NOT NULL").all());
    expect(carried).toEqual([{ target_kind: "commit", target: seeded.task, verdict: "pass", findings: '[{"id":"F1"}]', commit_sha: "c3", carried_from: seeded.taskReview }]);

    // Marks: each names its task or feature branch; the one sent later is sent.
    expect(s.listReviewMarks().map((m) => [m.taskId, m.featureId, m.commitSha, m.kind, m.state, m.sentAt !== null])).toEqual([
      [seeded.task, null, "c1", "pass", "success", true],
      [null, seeded.feature, "f2", "waiver", "success", true],
    ]);

    // The feature branch knows the base it merged; reports and imports keep their rows.
    expect(s.findFeature("feat/x")).toMatchObject({ baseMergedCommit: "b1" });
    expect(s.listFeedbackReports().map((r) => [r.route, r.url])).toEqual([
      ["issue", "https://github.com/trustmybot/tmb/issues/9"],
      ["form", null],
    ]);
    expect(s.listImports("plugin")).toMatchObject([{ repo: "web", detail: { repo: "web", schemaVersion: 3 } }]);

    // A rebuild from the events alone gives the same rows.
    const before = peek(snapshot);
    s.rebuildProjections();
    expect(peek(snapshot)).toEqual(before);
  });
});
