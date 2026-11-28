// Current state is a fold over the events. The live write path and the rebuild both call
// applyEvent, so a rebuilt projection matches the live one by construction.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { type Actor, ROLES } from "./actor.ts";
import type { ProjectionTable } from "./schema.ts";
import { DISCUSSION_KINDS, GUARD_DECISIONS, ISSUE_STATES, MARK_KINDS, MARK_STATES, MILESTONE_STATES, PULL_REQUEST_STATES, REVIEW_TARGET_KINDS, ROLE_CHANGE_KINDS, ROLE_STATES, ValueError, assertOneOf } from "./values.ts";

export const RECORD_KINDS = [
  "issue",
  "discussion",
  "task",
  "run",
  "check_run",
  "review",
  "guard_decision",
  "feature",
  "waiver",
  "review_mark",
  "setting_change",
  "freeze",
  "feedback_report",
  "import",
  "role_change",
  "role",
  "repo",
  "milestone",
  "pull_request",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export type EventType = "created" | "updated";

export type StoredEvent = {
  id: string;
  recordKind: RecordKind;
  recordId: string;
  type: EventType;
  data: Record<string, unknown>;
  actor: Actor;
  at: string;
};

type RecordShape = {
  table: ProjectionTable;
  /** Columns a created event fills from its data; read from this list, never from the data's keys. */
  columns: readonly string[];
  /** Columns an updated event may change; empty when the record has no update yet. */
  updatable: readonly string[];
  /** Fixed values a new row starts with. */
  initial?: Record<string, SQLQueryBindings>;
  hasUpdatedAt: boolean;
  searchable: boolean;
  /** Columns that take a value from a fixed list, checked on each write (trustmybot/tmb#404). */
  lists?: Record<string, readonly string[]>;
};

/** The columns every mirrored row keeps of its item on the remote (trustmybot/tmb#70). */
const REMOTE_COLUMNS = ["remote", "remote_id", "remote_updated_at", "remote_gone_at"] as const;
/** What the syncer sets on an issue mirrored from the remote; a local issue leaves them empty. */
const MIRRORED_ISSUE_COLUMNS = ["state", "state_reason", "milestone_id", "type", "labels", "assignees", "remote_url", "remote_created_at", ...REMOTE_COLUMNS] as const;

const RECORDS: Record<RecordKind, RecordShape> = {
  issue: {
    table: "issues",
    columns: ["title", "body", "milestone", ...MIRRORED_ISSUE_COLUMNS],
    updatable: ["title", "body", "state", "milestone", ...MIRRORED_ISSUE_COLUMNS],
    initial: { state: "open" },
    hasUpdatedAt: true,
    searchable: true,
    lists: { state: ISSUE_STATES },
  },
  discussion: {
    table: "discussions",
    columns: ["issue_id", "kind", "body", "remote_author", "remote_created_at", "updated_at", ...REMOTE_COLUMNS],
    // Only a comment mirrored from the remote changes; the store refuses it for a note or a decision.
    updatable: ["body", "updated_at", "remote_created_at", ...REMOTE_COLUMNS],
    hasUpdatedAt: false,
    searchable: true,
    lists: { kind: DISCUSSION_KINDS },
  },
  task: {
    table: "tasks",
    columns: ["issue_id", "title", "spec", "state", "branch", "commit_sha", "worktree", "base_commit", "feature_id", "kind", "main_snapshot", "repo", "replaces"],
    updatable: ["state", "commit_sha", "review_mode", "push_result", "push_detail", "pr_url", "base_commit", "worktree", "drop_reason", "repo"],
    hasUpdatedAt: true,
    searchable: false,
  },
  run: {
    table: "runs",
    columns: ["task_id", "role", "started_at", "ended_at", "outcome", "cost", "feature_id"],
    updatable: ["ended_at", "outcome", "cost", "feature_id"],
    hasUpdatedAt: false,
    searchable: false,
    lists: { role: ROLES },
  },
  check_run: {
    table: "check_runs",
    columns: ["task_id", "commit_sha", "started_at", "ended_at", "result", "commands"],
    updatable: ["ended_at", "result", "commands"],
    hasUpdatedAt: false,
    searchable: false,
  },
  review: {
    table: "reviews",
    columns: ["target_kind", "target", "verdict", "findings", "feature_id", "commit_sha", "run_id", "carried_from"],
    updatable: [],
    hasUpdatedAt: false,
    searchable: false,
    lists: { target_kind: REVIEW_TARGET_KINDS },
  },
  guard_decision: {
    table: "guard_decisions",
    columns: ["event", "decision", "reason"],
    updatable: [],
    hasUpdatedAt: false,
    searchable: false,
    lists: { decision: GUARD_DECISIONS },
  },
  feature: {
    table: "features",
    columns: ["name", "base_branch", "base_commit", "repo"],
    updatable: ["state", "pr_url", "drop_reason", "base_merged_commit"],
    initial: { state: "open" },
    hasUpdatedAt: true,
    searchable: false,
  },
  // What `audit` held, each kind in its own table (trustmybot/tmb#408).
  waiver: { table: "waivers", columns: ["task_id", "feature_id", "carried_from", "commit_sha", "reason"], updatable: [], hasUpdatedAt: false, searchable: false },
  review_mark: {
    table: "review_marks",
    columns: ["task_id", "feature_id", "commit_sha", "kind", "state", "sent_at"],
    updatable: ["sent_at"],
    hasUpdatedAt: false,
    searchable: false,
    lists: { kind: MARK_KINDS, state: MARK_STATES },
  },
  setting_change: { table: "setting_changes", columns: ["key", "repo", "old_value", "new_value", "how"], updatable: [], hasUpdatedAt: false, searchable: false },
  freeze: { table: "freezes", columns: ["reason", "session_id"], updatable: ["lifted_by", "lifted_at"], hasUpdatedAt: false, searchable: false },
  feedback_report: { table: "feedback_reports", columns: ["route", "url", "issue_id"], updatable: [], hasUpdatedAt: false, searchable: false },
  import: { table: "imports", columns: ["source", "repo", "detail"], updatable: [], hasUpdatedAt: false, searchable: false },
  role_change: { table: "role_changes", columns: ["role", "action", "change"], updatable: [], hasUpdatedAt: false, searchable: false, lists: { change: ROLE_CHANGE_KINDS } },
  repo: { table: "repos", columns: ["path"], updatable: [], hasUpdatedAt: false, searchable: false },
  milestone: {
    table: "milestones",
    columns: ["title", "description", "state", "repo_id", ...REMOTE_COLUMNS],
    updatable: ["title", "description", "state", ...REMOTE_COLUMNS],
    hasUpdatedAt: true,
    searchable: false,
    lists: { state: MILESTONE_STATES },
  },
  pull_request: {
    table: "pull_requests",
    columns: ["url", "repo_id", "feature_id", "task_id", "author", "head_remote", "state", "draft", "head_commit", ...REMOTE_COLUMNS],
    updatable: ["url", "feature_id", "task_id", "state", "draft", "head_commit", "head_remote", ...REMOTE_COLUMNS],
    hasUpdatedAt: true,
    searchable: false,
    lists: { state: PULL_REQUEST_STATES },
  },
  role: {
    table: "roles",
    columns: ["name", "purpose", "prompt"],
    updatable: ["state"],
    initial: { state: "active" },
    hasUpdatedAt: true,
    searchable: false,
    lists: { state: ROLE_STATES },
  },
};

/** The record kind `audit` had before version 13: its old events stay, and the fold skips them (trustmybot/tmb#408). */
export const RETIRED_RECORD_KINDS: readonly string[] = ["audit"];

export function tableOf(kind: RecordKind): ProjectionTable {
  return RECORDS[kind].table;
}

/**
 * Refuses a new event whose record kind, or a value it sets, is not on its list. Checked when an
 * event is written, never when one is replayed: a value an older tmb wrote stays in the record.
 */
export function assertValues(recordKind: string, data: Record<string, unknown>): void {
  assertOneOf("record kind", RECORD_KINDS, recordKind);
  for (const [column, list] of Object.entries(RECORDS[recordKind as RecordKind].lists ?? {})) {
    if (column in data) assertOneOf(`a ${recordKind}'s ${column}`, list, data[column]);
  }
}

export { ValueError };

/** A JSON object or array in event data is stored in its column as JSON text. */
function toColumnValue(value: unknown): SQLQueryBindings {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`cannot store a ${typeof value} in a column`);
}

// Table and column names in these statements come from RECORDS, never from event data;
// the values are bound.
function insertRow(db: Database, table: ProjectionTable, row: Record<string, SQLQueryBindings>): void {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...columns.map((column) => row[column]!),
  );
}

function applyCreated(db: Database, shape: RecordShape, event: StoredEvent): void {
  const row: Record<string, SQLQueryBindings> = {
    id: event.recordId,
    ...shape.initial,
    created_by: JSON.stringify(event.actor),
    created_at: event.at,
  };
  if (shape.hasUpdatedAt) row.updated_at = event.at;
  for (const column of shape.columns) {
    if (column in event.data) row[column] = toColumnValue(event.data[column]);
  }
  insertRow(db, shape.table, row);
}

function applyUpdated(db: Database, shape: RecordShape, event: StoredEvent): void {
  const changed = shape.updatable.filter((column) => column in event.data);
  if (changed.length === 0) throw new Error(`a ${event.recordKind} update must change one of: ${shape.updatable.join(", ")}`);
  const assignments = changed.map((column) => `${column} = ?`);
  const values = changed.map((column) => toColumnValue(event.data[column]));
  if (shape.hasUpdatedAt) {
    assignments.push("updated_at = ?");
    values.push(event.at);
  }
  const result = db.query(`UPDATE ${shape.table} SET ${assignments.join(", ")} WHERE id = ?`).run(...values, event.recordId);
  if (result.changes !== 1) throw new Error(`no ${event.recordKind} ${event.recordId}`);
}

/** Keeps the full-text index in step with the issue or discussion the event changed. */
function syncSearch(db: Database, event: StoredEvent): void {
  if (event.recordKind === "issue") {
    const issue = db.query("SELECT title, body FROM issues WHERE id = ?").get(event.recordId) as { title: string; body: string };
    if (event.type === "created") {
      db.query("INSERT INTO search (record_kind, record_id, issue_id, title, body) VALUES ('issue', ?, ?, ?, ?)").run(
        event.recordId,
        event.recordId,
        issue.title,
        issue.body,
      );
    } else {
      db.query("UPDATE search SET title = ?, body = ? WHERE record_kind = 'issue' AND record_id = ?").run(
        issue.title,
        issue.body,
        event.recordId,
      );
    }
    return;
  }
  const discussion = db.query("SELECT issue_id, body FROM discussions WHERE id = ?").get(event.recordId) as {
    issue_id: string;
    body: string;
  };
  if (event.type === "updated") {
    db.query("UPDATE search SET body = ? WHERE record_kind = 'discussion' AND record_id = ?").run(discussion.body, event.recordId);
    return;
  }
  db.query("INSERT INTO search (record_kind, record_id, issue_id, title, body) VALUES ('discussion', ?, ?, '', ?)").run(
    event.recordId,
    discussion.issue_id,
    discussion.body,
  );
}

export function applyEvent(db: Database, event: StoredEvent): void {
  if (RETIRED_RECORD_KINDS.includes(event.recordKind)) return;
  const shape = RECORDS[event.recordKind];
  if (!shape) throw new Error(`unknown record kind ${JSON.stringify(event.recordKind)}`);
  if (event.type === "created") applyCreated(db, shape, event);
  else if (event.type === "updated" && shape.updatable.length > 0) applyUpdated(db, shape, event);
  else throw new Error(`a ${event.recordKind} has no ${JSON.stringify(event.type)} event`);
  if (shape.searchable) syncSearch(db, event);
}
