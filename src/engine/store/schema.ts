// The trajectory schema: one append-only events table, the projections of current state
// derived from it, and a full-text index over issues and discussions. Version 1 is the
// baseline; each later version is one step on top of the one before, so a new database
// and an upgraded one end up with the same tables.

/** Projection tables, children before parents so they can be emptied in this order. */
export const PROJECTION_TABLES = [
  "discussions",
  "check_runs",
  "runs",
  "reviews",
  "guard_decisions",
  "audit",
  "tasks",
  "features",
  "issues",
] as const;

export type ProjectionTable = (typeof PROJECTION_TABLES)[number];

// Every projection row carries its record id, `created_by` (the JSON actor of its first
// event) and `created_at` (that event's time). Ids are ULIDs, never autoincrement.
export const SCHEMA_SQL = `
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('issue','discussion','task','run','check_run','review','guard_decision','audit')),
  record_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
  actor_role  TEXT CHECK (actor_role IN ('planner','worker','reviewer')),
  actor_host  TEXT,
  at          TEXT NOT NULL,
  CHECK (
    (actor_kind = 'human' AND actor_role IS NULL AND actor_host IS NULL)
    OR (actor_kind = 'agent' AND actor_role IS NOT NULL AND length(trim(actor_host)) > 0)
  )
);
CREATE INDEX idx_events_record ON events(record_id, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only: UPDATE is refused'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only: DELETE is refused'); END;

CREATE TABLE issues (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  milestone  TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_issues_state ON issues(state, id);

CREATE TABLE discussions (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id),
  kind       TEXT NOT NULL CHECK (kind IN ('note','decision')),
  body       TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_discussions_issue ON discussions(issue_id, kind, id);

CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id),
  title      TEXT NOT NULL CHECK (length(trim(title)) > 0),
  spec       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL,
  branch     TEXT,
  commit_sha TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_issue ON tasks(issue_id, id);

CREATE TABLE runs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT REFERENCES tasks(id),
  role       TEXT NOT NULL CHECK (role IN ('planner','worker','reviewer')),
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  outcome    TEXT,
  cost       TEXT CHECK (cost IS NULL OR json_valid(cost)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runs_task ON runs(task_id, id);

CREATE TABLE check_runs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  commit_sha TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  result     TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_check_runs_task ON check_runs(task_id, id);

CREATE TABLE reviews (
  id          TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('commit','branch')),
  target      TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  findings    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings)),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE guard_decisions (
  id         TEXT PRIMARY KEY,
  event      TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason     TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit (
  id         TEXT PRIMARY KEY,
  what       TEXT NOT NULL CHECK (length(trim(what)) > 0),
  detail     TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE search USING fts5(
  record_kind UNINDEXED,
  record_id UNINDEXED,
  issue_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`;

// Version 2: a task records its worktree and the commit it was cut from, and a check run
// records each command it ran.
const VERSION_2_SQL = `
ALTER TABLE tasks ADD COLUMN worktree TEXT;
ALTER TABLE tasks ADD COLUMN base_commit TEXT;
CREATE INDEX idx_tasks_state ON tasks(state, id);
ALTER TABLE check_runs ADD COLUMN commands TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(commands));
CREATE INDEX idx_runs_open ON runs(role, ended_at, id);
`;

// Version 3: feature branches. A feature is a new record kind, and SQLite cannot change a
// CHECK in place, so the events are copied into a table that allows it, rows and ids kept.
// A task records its feature branch, its kind, and at close its review mode and its push.
const VERSION_3_SQL = `
CREATE TABLE events_v3 (
  id          TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('issue','discussion','task','run','check_run','review','guard_decision','audit','feature')),
  record_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
  actor_role  TEXT CHECK (actor_role IN ('planner','worker','reviewer')),
  actor_host  TEXT,
  at          TEXT NOT NULL,
  CHECK (
    (actor_kind = 'human' AND actor_role IS NULL AND actor_host IS NULL)
    OR (actor_kind = 'agent' AND actor_role IS NOT NULL AND length(trim(actor_host)) > 0)
  )
);
INSERT INTO events_v3 (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at)
  SELECT id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at FROM events ORDER BY id;
DROP TABLE events;
ALTER TABLE events_v3 RENAME TO events;
CREATE INDEX idx_events_record ON events(record_id, id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only: UPDATE is refused'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only: DELETE is refused'); END;

CREATE TABLE features (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open',
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_features_state ON features(state, id);

ALTER TABLE tasks ADD COLUMN feature_id TEXT REFERENCES features(id);
ALTER TABLE tasks ADD COLUMN kind TEXT;
ALTER TABLE tasks ADD COLUMN review_mode TEXT;
ALTER TABLE tasks ADD COLUMN push_result TEXT;
ALTER TABLE tasks ADD COLUMN push_detail TEXT;
CREATE INDEX idx_tasks_feature ON tasks(feature_id, id);
`;

// Version 4: the review of a feature branch. A review names the feature branch it judged and
// the commit it judged it at, so a later commit is never taken as reviewed; a feature branch
// records the pull request the engine opened for it.
const VERSION_4_SQL = `
ALTER TABLE reviews ADD COLUMN feature_id TEXT REFERENCES features(id);
ALTER TABLE reviews ADD COLUMN commit_sha TEXT;
CREATE INDEX idx_reviews_feature ON reviews(feature_id, id);
ALTER TABLE features ADD COLUMN pr_url TEXT;
`;

// Version 5: truest mode. A task reviewed on its own reaches the base branch through its own
// pull request, which the task records.
const VERSION_5_SQL = `
ALTER TABLE tasks ADD COLUMN pr_url TEXT;
`;

// Version 6: the record's own facts, apart from its history: which tmb wrote its shape, so an
// older tmb that meets it can name that version, and which tmb program the project is tied to,
// so its hooks and tool server call it (trustmybot/tmb#89).
const VERSION_6_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
`;

/** The step to each version, in order: the step at index i takes a database from version i to version i + 1. */
export const SCHEMA_STEPS: readonly string[] = [SCHEMA_SQL, VERSION_2_SQL, VERSION_3_SQL, VERSION_4_SQL, VERSION_5_SQL, VERSION_6_SQL];

export const SCHEMA_VERSION = SCHEMA_STEPS.length;
