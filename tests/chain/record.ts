// tmb's record, read straight from its database, for the session steps' checks. Read-only: the
// chain never writes the record itself.
import { Database } from "bun:sqlite";
import path from "node:path";
import type { World } from "./world.ts";

export type FeatureRow = { id: string; name: string; repo: string | null; state: string; base_commit: string; pr_url: string | null; drop_reason: string | null; created_at: string };
export type TaskRow = {
  id: string;
  issue_id: string;
  title: string;
  spec: string;
  state: string;
  branch: string | null;
  commit_sha: string | null;
  feature_id: string | null;
  kind: string | null;
  review_mode: string | null;
  pr_url: string | null;
  repo: string | null;
  worktree: string | null;
  drop_reason: string | null;
  created_at: string;
};
export type ReviewRow = { id: string; target_kind: "commit" | "branch"; target: string; verdict: string; feature_id: string | null; commit_sha: string | null; run_id: string | null; created_by: string; created_at: string };
export type RunRow = { id: string; task_id: string | null; feature_id: string | null; role: string; started_at: string; ended_at: string | null; outcome: string | null; cost: string | null; created_by: string };
export type IssueRow = { id: string; title: string; state: string; created_by: string; created_at: string };
export type GuardRow = { event: string; decision: string; reason: string; created_by: string; created_at: string };
export type AuditRow = { what: string; detail: string; created_by: string; created_at: string };

export function readRecord<T>(world: World, read: (db: Database) => T): T {
  const db = new Database(path.join(world.project, ".tmb", "trajectory.db"), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export const features = (world: World) => readRecord(world, (db) => db.query("SELECT * FROM features ORDER BY created_at, id").all() as FeatureRow[]);
export const tasks = (world: World) => readRecord(world, (db) => db.query("SELECT * FROM tasks ORDER BY created_at, id").all() as TaskRow[]);
export const reviews = (world: World) => readRecord(world, (db) => db.query("SELECT * FROM reviews ORDER BY created_at, id").all() as ReviewRow[]);
export const runs = (world: World) => readRecord(world, (db) => db.query("SELECT * FROM runs ORDER BY started_at, id").all() as RunRow[]);
export const issues = (world: World) => readRecord(world, (db) => db.query("SELECT * FROM issues ORDER BY created_at, id").all() as IssueRow[]);
export const guardDecisions = (world: World) => readRecord(world, (db) => db.query("SELECT * FROM guard_decisions ORDER BY created_at, id").all() as GuardRow[]);
export const audit = (world: World) => readRecord(world, (db) => db.query("SELECT * FROM audit ORDER BY created_at, id").all() as AuditRow[]);

/** The actor a row names, as `{kind, role?, host?}`. */
export function actorOf(createdBy: string): { kind: string; role?: string; host?: string } {
  try {
    return JSON.parse(createdBy) as { kind: string; role?: string; host?: string };
  } catch {
    return { kind: createdBy };
  }
}

/** Rows made at or after `since`. */
export const since = <T extends { created_at: string }>(rows: T[], at: string) => rows.filter((row) => row.created_at >= at);

/** The record's clock, as tmb writes it, for "since this step began". */
export function now(): string {
  return new Date().toISOString();
}

/** One line per row, for a check's detail. */
export const show = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") || "(none)";

/** tmb bugs the record checks meet, filed: the checks they fail are marked known until each is fixed. */
export const RECORD_BUGS = {
  /** A worker start Claude Code fails leaves its run open; the real worker's stop then finds two open and ends none. */
  strandedStart: 285,
};

/**
 * The worker runs trustmybot/tmb#285 left open: on a task with two or more worker runs, none ended.
 * A failed start's run is never closed, and the worker that did start cannot end its own beside it.
 */
export function strandedRuns(rows: RunRow[]): RunRow[] {
  const byTask = new Map<string, RunRow[]>();
  for (const run of rows) if (run.role === "worker" && run.task_id !== null) byTask.set(run.task_id, [...(byTask.get(run.task_id) ?? []), run]);
  return [...byTask.values()].filter((workers) => workers.length >= 2 && workers.every((run) => run.ended_at === null)).flat();
}
