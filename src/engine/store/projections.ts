// Current state is a fold over the events. The live write path and the rebuild both call
// applyEvent, so a rebuilt projection matches the live one by construction.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Actor } from "./actor.ts";
import type { ProjectionTable } from "./schema.ts";

export const RECORD_KINDS = ["issue", "discussion", "task", "run", "check_run", "review", "guard_decision", "audit"] as const;
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
};

const RECORDS: Record<RecordKind, RecordShape> = {
  issue: {
    table: "issues",
    columns: ["title", "body", "milestone"],
    updatable: ["title", "body", "state", "milestone"],
    initial: { state: "open" },
    hasUpdatedAt: true,
    searchable: true,
  },
  discussion: { table: "discussions", columns: ["issue_id", "kind", "body"], updatable: [], hasUpdatedAt: false, searchable: true },
  task: {
    table: "tasks",
    columns: ["issue_id", "title", "spec", "state", "branch", "commit_sha", "worktree", "base_commit"],
    updatable: ["state", "commit_sha"],
    hasUpdatedAt: true,
    searchable: false,
  },
  run: {
    table: "runs",
    columns: ["task_id", "role", "started_at", "ended_at", "outcome", "cost"],
    updatable: ["ended_at", "outcome"],
    hasUpdatedAt: false,
    searchable: false,
  },
  check_run: {
    table: "check_runs",
    columns: ["task_id", "commit_sha", "started_at", "ended_at", "result", "commands"],
    updatable: ["ended_at", "result", "commands"],
    hasUpdatedAt: false,
    searchable: false,
  },
  review: { table: "reviews", columns: ["target_kind", "target", "verdict", "findings"], updatable: [], hasUpdatedAt: false, searchable: false },
  guard_decision: { table: "guard_decisions", columns: ["event", "decision", "reason"], updatable: [], hasUpdatedAt: false, searchable: false },
  audit: { table: "audit", columns: ["what", "detail"], updatable: [], hasUpdatedAt: false, searchable: false },
};

export function tableOf(kind: RecordKind): ProjectionTable {
  return RECORDS[kind].table;
}

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
  db.query("INSERT INTO search (record_kind, record_id, issue_id, title, body) VALUES ('discussion', ?, ?, '', ?)").run(
    event.recordId,
    discussion.issue_id,
    discussion.body,
  );
}

export function applyEvent(db: Database, event: StoredEvent): void {
  const shape = RECORDS[event.recordKind];
  if (!shape) throw new Error(`unknown record kind ${JSON.stringify(event.recordKind)}`);
  if (event.type === "created") applyCreated(db, shape, event);
  else if (event.type === "updated" && shape.updatable.length > 0) applyUpdated(db, shape, event);
  else throw new Error(`a ${event.recordKind} has no ${JSON.stringify(event.type)} event`);
  if (shape.searchable) syncSearch(db, event);
}
