// The trajectory schema, version 1: one append-only events table, the projections of
// current state derived from it, and a full-text index over issues and discussions.
// Version 1 is a single baseline; a later version adds its own step from here.

export const SCHEMA_VERSION = 1;

/** Projection tables, children before parents so they can be emptied in this order. */
export const PROJECTION_TABLES = [
  "discussions",
  "check_runs",
  "runs",
  "reviews",
  "guard_decisions",
  "audit",
  "tasks",
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
