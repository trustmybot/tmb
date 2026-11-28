// The trajectory schema: one append-only events table, the projections of current state
// derived from it, and a full-text index over issues and discussions. Version 1 is the
// baseline; each later version is one step on top of the one before, so a new database
// and an upgraded one end up with the same tables.

import type { Database } from "bun:sqlite";
import { upgradeAudit } from "./upgrade-audit.ts";

/** Projection tables, children before parents so they can be emptied in this order. */
export const PROJECTION_TABLES = [
  "roles",
  "role_changes",
  "waivers",
  "review_marks",
  "setting_changes",
  "freezes",
  "feedback_reports",
  "imports",
  "discussions",
  "pull_requests",
  "check_runs",
  "reviews",
  "runs",
  "guard_decisions",
  "tasks",
  "features",
  "issues",
  "milestones",
  "repos",
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

// Version 7: a task records the main folder as it was at the task's start, so its close can name
// what changed there (trustmybot/tmb#98).
const VERSION_7_SQL = `
ALTER TABLE tasks ADD COLUMN main_snapshot TEXT;
`;

// Version 8: a workspace of several repos shares one record, so a feature branch and a task
// record the repo they were cut in; NULL is the project folder itself (trustmybot/tmb#163).
const VERSION_8_SQL = `
ALTER TABLE features ADD COLUMN repo TEXT;
ALTER TABLE tasks ADD COLUMN repo TEXT;
`;

// Version 9: a task can be dropped, with the reason, and a new task can name the dropped one it
// replaces (trustmybot/tmb#170).
const VERSION_9_SQL = `
ALTER TABLE tasks ADD COLUMN drop_reason TEXT;
ALTER TABLE tasks ADD COLUMN replaces TEXT REFERENCES tasks(id);
`;

// Version 10: a run links to what it worked on, a task or, for a branch review, a feature branch,
// and a review names the run that wrote it (trustmybot/tmb#135). A run's cost is filled when it
// ends (trustmybot/tmb#133).
const VERSION_10_SQL = `
ALTER TABLE runs ADD COLUMN feature_id TEXT REFERENCES features(id);
CREATE INDEX idx_runs_feature ON runs(feature_id, id);
ALTER TABLE reviews ADD COLUMN run_id TEXT REFERENCES runs(id);
`;

// Version 11: a feature branch can be dropped, with the reason, like a task (trustmybot/tmb#214).
const VERSION_11_SQL = `
ALTER TABLE features ADD COLUMN drop_reason TEXT;
`;

// Version 12: the schema checks shape only, and every list of values is checked by the engine
// (src/engine/store/values.ts), so a new kind, role or state is a code change, never a reshaped
// table (trustmybot/tmb#404). SQLite cannot drop a CHECK in place, so each table that had one on a
// list is copied into one without it, rows and ids kept; the events are copied, never rewritten.
// tmb itself becomes an actor, for a write no person or agent made, named by the part of tmb
// that made it. The upgrade runs with foreign keys off and checks them all before it commits.
const VERSION_12_SQL = `
CREATE TABLE events_v12 (
  id           TEXT PRIMARY KEY,
  record_kind  TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  type         TEXT NOT NULL,
  data         TEXT NOT NULL CHECK (json_valid(data)),
  actor_kind   TEXT NOT NULL,
  actor_role   TEXT,
  actor_host   TEXT,
  actor_source TEXT,
  at           TEXT NOT NULL,
  CHECK (
    (actor_kind = 'human' AND actor_role IS NULL AND actor_host IS NULL AND actor_source IS NULL)
    OR (actor_kind = 'agent' AND actor_role IS NOT NULL AND actor_host IS NOT NULL AND length(trim(actor_host)) > 0 AND actor_source IS NULL)
    OR (actor_kind = 'tmb' AND actor_role IS NULL AND actor_host IS NULL AND actor_source IS NOT NULL AND length(trim(actor_source)) > 0)
  )
);
INSERT INTO events_v12 (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at)
  SELECT id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at FROM events ORDER BY id;
DROP TABLE events;
ALTER TABLE events_v12 RENAME TO events;
CREATE INDEX idx_events_record ON events(record_id, id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only: UPDATE is refused'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only: DELETE is refused'); END;

CREATE TABLE issues_v12 (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'open',
  milestone  TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO issues_v12 (id, title, body, state, milestone, created_by, created_at, updated_at)
  SELECT id, title, body, state, milestone, created_by, created_at, updated_at FROM issues;
DROP TABLE issues;
ALTER TABLE issues_v12 RENAME TO issues;
CREATE INDEX idx_issues_state ON issues(state, id);

CREATE TABLE discussions_v12 (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id),
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO discussions_v12 (id, issue_id, kind, body, created_by, created_at)
  SELECT id, issue_id, kind, body, created_by, created_at FROM discussions;
DROP TABLE discussions;
ALTER TABLE discussions_v12 RENAME TO discussions;
CREATE INDEX idx_discussions_issue ON discussions(issue_id, kind, id);

CREATE TABLE runs_v12 (
  id         TEXT PRIMARY KEY,
  task_id    TEXT REFERENCES tasks(id),
  feature_id TEXT REFERENCES features(id),
  role       TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  outcome    TEXT,
  cost       TEXT CHECK (cost IS NULL OR json_valid(cost)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO runs_v12 (id, task_id, feature_id, role, started_at, ended_at, outcome, cost, created_by, created_at)
  SELECT id, task_id, feature_id, role, started_at, ended_at, outcome, cost, created_by, created_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v12 RENAME TO runs;
CREATE INDEX idx_runs_task ON runs(task_id, id);
CREATE INDEX idx_runs_feature ON runs(feature_id, id);
CREATE INDEX idx_runs_open ON runs(role, ended_at, id);

CREATE TABLE reviews_v12 (
  id          TEXT PRIMARY KEY,
  run_id      TEXT REFERENCES runs(id),
  feature_id  TEXT REFERENCES features(id),
  commit_sha  TEXT,
  verdict     TEXT NOT NULL,
  findings    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings)),
  target_kind TEXT NOT NULL,
  target      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
INSERT INTO reviews_v12 (id, run_id, feature_id, commit_sha, verdict, findings, target_kind, target, created_by, created_at)
  SELECT id, run_id, feature_id, commit_sha, verdict, findings, target_kind, target, created_by, created_at FROM reviews;
DROP TABLE reviews;
ALTER TABLE reviews_v12 RENAME TO reviews;
CREATE INDEX idx_reviews_feature ON reviews(feature_id, id);

CREATE TABLE guard_decisions_v12 (
  id         TEXT PRIMARY KEY,
  event      TEXT NOT NULL,
  decision   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO guard_decisions_v12 (id, event, decision, reason, created_by, created_at)
  SELECT id, event, decision, reason, created_by, created_at FROM guard_decisions;
DROP TABLE guard_decisions;
ALTER TABLE guard_decisions_v12 RENAME TO guard_decisions;
`;

// Version 13: `audit` goes (trustmybot/tmb#408). Each kind of entry becomes its own record with its
// own columns, so a gate reads rows and never parses text. A rebase carries a review or a waiver
// as a row naming the one it carries, and a feature branch names the base commit last brought in.
// The tables are made here; moving the old entries needs code, in upgrade-audit.ts.
const VERSION_13_SQL = `
ALTER TABLE reviews ADD COLUMN carried_from TEXT REFERENCES reviews(id);
ALTER TABLE features ADD COLUMN base_merged_commit TEXT;

CREATE TABLE waivers (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id),
  feature_id   TEXT REFERENCES features(id),
  carried_from TEXT REFERENCES waivers(id),
  commit_sha   TEXT NOT NULL CHECK (length(trim(commit_sha)) > 0),
  reason       TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK ((task_id IS NULL) <> (feature_id IS NULL))
);
CREATE INDEX idx_waivers_task ON waivers(task_id, id);
CREATE INDEX idx_waivers_feature ON waivers(feature_id, id);
CREATE INDEX idx_waivers_commit ON waivers(commit_sha, id);

CREATE TABLE review_marks (
  id         TEXT PRIMARY KEY,
  task_id    TEXT REFERENCES tasks(id),
  feature_id TEXT REFERENCES features(id),
  commit_sha TEXT NOT NULL CHECK (length(trim(commit_sha)) > 0),
  kind       TEXT NOT NULL,
  state      TEXT NOT NULL,
  sent_at    TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((task_id IS NULL) <> (feature_id IS NULL))
);
CREATE INDEX idx_review_marks_commit ON review_marks(commit_sha, id);

CREATE TABLE setting_changes (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL CHECK (length(trim(key)) > 0),
  repo       TEXT,
  old_value  TEXT CHECK (old_value IS NULL OR json_valid(old_value)),
  new_value  TEXT CHECK (new_value IS NULL OR json_valid(new_value)),
  how        TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_setting_changes_key ON setting_changes(key, repo, id);

CREATE TABLE freezes (
  id         TEXT PRIMARY KEY,
  reason     TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  lifted_by  TEXT CHECK (lifted_by IS NULL OR json_valid(lifted_by)),
  lifted_at  TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE feedback_reports (
  id         TEXT PRIMARY KEY,
  route      TEXT NOT NULL CHECK (length(trim(route)) > 0),
  url        TEXT,
  issue_id   TEXT REFERENCES issues(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE imports (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL CHECK (length(trim(source)) > 0),
  repo       TEXT,
  detail     TEXT NOT NULL CHECK (json_valid(detail)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

// Version 14: a project's own grants and revokes of a role's actions, each with who made it
// (docs/architecture/PERMISSIONS.md). A row never changes; the newest for a role and an
// action is the one in force.
const VERSION_14_SQL = `
CREATE TABLE role_changes (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (length(trim(role)) > 0),
  action     TEXT NOT NULL CHECK (length(trim(action)) > 0),
  change     TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_role_changes_role ON role_changes(role, id);
`;

// Version 15: the roles a project creates, each with what it is for and its prompt
// (docs/architecture/PERMISSIONS.md, "Roles are data"). Its actions stay in role_changes. A
// deleted role keeps its row, so the records its agents wrote still name it.
const VERSION_15_SQL = `
CREATE TABLE roles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  purpose    TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
  prompt     TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
  state      TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_roles_name ON roles(name, id);
`;

// Version 16: the remote's issues, comments, milestones and pull requests come into the record
// through the syncer (trustmybot/tmb#70). Each mirrored row keeps the remote's own id, which a
// rename or a transfer does not change; a row with none is local. An event the syncer writes names
// the remote account that made the change. A repo is a row that milestones and pull requests name.
// sync_state is where each poll of the remote stopped; it is not folded from events.
const VERSION_16_SQL = `
ALTER TABLE events ADD COLUMN actor_remote TEXT;

CREATE TABLE repos (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE CHECK (length(trim(path)) > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE milestones (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description       TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL,
  repo_id           TEXT NOT NULL REFERENCES repos(id),
  remote            TEXT,
  remote_id         TEXT,
  remote_updated_at TEXT,
  remote_gone_at    TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_milestones_title ON milestones(repo_id, title);
CREATE UNIQUE INDEX idx_milestones_remote ON milestones(remote, remote_id);

ALTER TABLE issues ADD COLUMN state_reason TEXT;
ALTER TABLE issues ADD COLUMN milestone_id TEXT REFERENCES milestones(id);
ALTER TABLE issues ADD COLUMN type TEXT;
ALTER TABLE issues ADD COLUMN labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels));
ALTER TABLE issues ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assignees));
ALTER TABLE issues ADD COLUMN remote_url TEXT;
ALTER TABLE issues ADD COLUMN remote TEXT;
ALTER TABLE issues ADD COLUMN remote_id TEXT;
ALTER TABLE issues ADD COLUMN remote_updated_at TEXT;
ALTER TABLE issues ADD COLUMN remote_gone_at TEXT;
CREATE INDEX idx_issues_milestone ON issues(milestone_id, id);
CREATE UNIQUE INDEX idx_issues_remote ON issues(remote, remote_id);
CREATE UNIQUE INDEX idx_issues_remote_url ON issues(remote_url);

ALTER TABLE discussions ADD COLUMN remote_author TEXT;
ALTER TABLE discussions ADD COLUMN remote TEXT;
ALTER TABLE discussions ADD COLUMN remote_id TEXT;
ALTER TABLE discussions ADD COLUMN remote_updated_at TEXT;
ALTER TABLE discussions ADD COLUMN remote_gone_at TEXT;
ALTER TABLE discussions ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX idx_discussions_remote ON discussions(remote, remote_id);

CREATE TABLE pull_requests (
  id                TEXT PRIMARY KEY,
  url               TEXT NOT NULL UNIQUE CHECK (length(trim(url)) > 0),
  repo_id           TEXT NOT NULL REFERENCES repos(id),
  feature_id        TEXT REFERENCES features(id),
  task_id           TEXT REFERENCES tasks(id),
  author            TEXT,
  closes            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(closes)),
  head_remote       TEXT,
  state             TEXT NOT NULL,
  draft             INTEGER NOT NULL DEFAULT 0,
  head_commit       TEXT,
  review_decision   TEXT,
  checks            TEXT,
  remote            TEXT,
  remote_id         TEXT,
  remote_updated_at TEXT,
  remote_gone_at    TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (feature_id IS NULL OR task_id IS NULL)
);
CREATE INDEX idx_pull_requests_repo ON pull_requests(repo_id, id);
CREATE INDEX idx_pull_requests_feature ON pull_requests(feature_id, id);
CREATE INDEX idx_pull_requests_task ON pull_requests(task_id, id);
CREATE UNIQUE INDEX idx_pull_requests_remote ON pull_requests(remote, remote_id);

CREATE TABLE sync_state (
  remote       TEXT NOT NULL,
  list         TEXT NOT NULL,
  tag          TEXT,
  since        TEXT,
  resume       TEXT,
  synced_at    TEXT,
  full_pass_at TEXT,
  wait_until   TEXT,
  claimed_by   TEXT,
  claim_until  TEXT,
  last_error   TEXT,
  PRIMARY KEY (remote, list)
);
`;

// Version 17: the remote's own time a mirrored issue or comment was opened, so a page shows its
// age on the remote rather than when the syncer brought it in (trustmybot/tmb#512).
const VERSION_17_SQL = `
ALTER TABLE issues ADD COLUMN remote_created_at TEXT;
ALTER TABLE discussions ADD COLUMN remote_created_at TEXT;
`;

/** One step: SQL, or code for a step SQL alone cannot take. A step's code is frozen with it and never reads today's projections. */
export type SchemaStep = string | ((db: Database) => void);

/** The step to each version, in order: the step at index i takes a database from version i to version i + 1. */
export const SCHEMA_STEPS: readonly SchemaStep[] = [SCHEMA_SQL, VERSION_2_SQL, VERSION_3_SQL, VERSION_4_SQL, VERSION_5_SQL, VERSION_6_SQL, VERSION_7_SQL, VERSION_8_SQL, VERSION_9_SQL, VERSION_10_SQL, VERSION_11_SQL, VERSION_12_SQL, (db) => upgradeAudit(db, VERSION_13_SQL), VERSION_14_SQL, VERSION_15_SQL, VERSION_16_SQL, VERSION_17_SQL];

/** Runs one schema step on `db`. */
export function runStep(db: Database, step: SchemaStep): void {
  if (typeof step === "string") db.run(step);
  else step(db);
}

export const SCHEMA_VERSION = SCHEMA_STEPS.length;
