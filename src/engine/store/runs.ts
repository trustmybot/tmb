// Agent runs and check runs: what ran, when, and how it ended.
import type { Actor, Role } from "./actor.ts";
import { type EventLog, actorOf, nowIso } from "./event-log.ts";

/** Tokens one model used in a run, as the host reported them; never money (trustmybot/tmb#133). */
export type ModelUsage = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type Run = {
  id: string;
  taskId: string | null;
  /** The feature branch a branch review's run reviewed; a worker's run reads its feature through its task. */
  featureId: string | null;
  role: Role;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  /** One entry per model, or null when the host gave none. */
  cost: ModelUsage[] | null;
  createdBy: Actor;
};
export type RunEnd = { endedAt?: string; outcome?: string | null; cost?: ModelUsage[] | null };
export type CheckRun = {
  id: string;
  taskId: string;
  commitSha: string;
  startedAt: string;
  endedAt: string | null;
  result: string | null;
  commands: unknown[];
  createdBy: Actor;
};
export type CheckRunEnd = { endedAt?: string; result: string; commands: unknown[] };
export type NewRun = {
  id?: string;
  taskId?: string | null;
  role: Role;
  startedAt?: string;
  endedAt?: string | null;
  outcome?: string | null;
  cost?: ModelUsage[] | Record<string, unknown> | null;
  featureId?: string | null;
};
export type NewCheckRun = {
  id?: string;
  taskId: string;
  commitSha: string;
  startedAt?: string;
  endedAt?: string | null;
  result?: string | null;
  commands?: unknown[];
};

type RunRow = {
  id: string;
  task_id: string | null;
  feature_id: string | null;
  role: Role;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  cost: string | null;
  created_by: string;
};
type CheckRunRow = {
  id: string;
  task_id: string;
  commit_sha: string;
  started_at: string;
  ended_at: string | null;
  result: string | null;
  commands: string;
  created_by: string;
};

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    featureId: row.feature_id,
    role: row.role,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    cost: row.cost === null ? null : (JSON.parse(row.cost) as ModelUsage[]),
    createdBy: actorOf(row.created_by),
  };
}

function toCheckRun(row: CheckRunRow): CheckRun {
  return {
    id: row.id,
    taskId: row.task_id,
    commitSha: row.commit_sha,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    result: row.result,
    commands: JSON.parse(row.commands) as unknown[],
    createdBy: actorOf(row.created_by),
  };
}

export class RunRepository {
  constructor(private readonly log: EventLog) {}

  appendRun(actor: Actor, run: NewRun): string {
    return this.log.create(actor, "run", {
      task_id: run.taskId ?? null,
      role: run.role,
      started_at: run.startedAt ?? nowIso(),
      ended_at: run.endedAt ?? null,
      outcome: run.outcome ?? null,
      cost: run.cost ?? null,
      feature_id: run.featureId ?? null,
    }, run.id);
  }

  endRun(actor: Actor, id: string, end: RunEnd = {}): void {
    this.log.update(actor, "run", id, {
      ended_at: end.endedAt ?? nowIso(),
      outcome: end.outcome ?? null,
      ...(end.cost === undefined || end.cost === null ? {} : { cost: end.cost }),
    });
  }

  /** Links a branch review's run to the feature branch it reviewed. */
  setRunFeature(actor: Actor, id: string, featureId: string): void {
    this.log.update(actor, "run", id, { feature_id: featureId });
  }

  getRun(id: string): Run | null {
    const row = this.log.db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;
    return row ? toRun(row) : null;
  }

  /** Runs of a role that have a start and no end, oldest first; only those of `taskId` when given. */
  openRuns(role: Role, taskId?: string): Run[] {
    const rows = (
      taskId === undefined
        ? this.log.db.query("SELECT * FROM runs WHERE role = ? AND ended_at IS NULL ORDER BY id").all(role)
        : this.log.db.query("SELECT * FROM runs WHERE role = ? AND ended_at IS NULL AND task_id = ? ORDER BY id").all(role, taskId)
    ) as RunRow[];
    return rows.map(toRun);
  }

  /** Runs of any role that have a start and no end, oldest first: what is stuck, or still running. */
  unendedRuns(): Run[] {
    return (this.log.db.query("SELECT * FROM runs WHERE ended_at IS NULL ORDER BY id").all() as RunRow[]).map(toRun);
  }

  /** How many runs ended, and how many of those carry no cost (trustmybot/tmb#257). */
  runCostCounts(): { ended: number; withoutCost: number } {
    const row = this.log.db.query("SELECT count(*) AS ended, coalesce(sum(cost IS NULL), 0) AS without FROM runs WHERE ended_at IS NOT NULL").get() as { ended: number; without: number };
    return { ended: row.ended, withoutCost: row.without };
  }

  /** The tasks any agent run names. */
  tasksWithRuns(): Set<string> {
    const rows = this.log.db.query("SELECT DISTINCT task_id FROM runs WHERE task_id IS NOT NULL").all() as { task_id: string }[];
    return new Set(rows.map((row) => row.task_id));
  }

  appendCheckRun(actor: Actor, check: NewCheckRun): string {
    return this.log.create(actor, "check_run", {
      task_id: check.taskId,
      commit_sha: check.commitSha,
      started_at: check.startedAt ?? nowIso(),
      ended_at: check.endedAt ?? null,
      result: check.result ?? null,
      commands: check.commands ?? [],
    }, check.id);
  }

  endCheckRun(actor: Actor, id: string, end: CheckRunEnd): void {
    this.log.update(actor, "check_run", id, {
      ended_at: end.endedAt ?? nowIso(),
      result: end.result,
      commands: end.commands,
    });
  }

  /** A task's check runs, oldest first. */
  listCheckRuns(taskId: string): CheckRun[] {
    const rows = this.log.db.query("SELECT * FROM check_runs WHERE task_id = ? ORDER BY id").all(taskId) as CheckRunRow[];
    return rows.map(toCheckRun);
  }

  /** Check runs that have a start and no end, oldest first. */
  unendedCheckRuns(): CheckRun[] {
    return (this.log.db.query("SELECT * FROM check_runs WHERE ended_at IS NULL ORDER BY id").all() as CheckRunRow[]).map(toCheckRun);
  }
}
