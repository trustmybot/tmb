// Tasks: the unit of work a worker or the planner does on its own branch.
import type { Actor } from "./actor.ts";
import { type EventLog, actorOf } from "./event-log.ts";

/** The state a task is recorded in when its start names none. */
export const NEW_TASK_STATE = "pending";

export type NewTask = {
  /** An id made beforehand, when something outside the record, such as a branch, is named after the task first. */
  id?: string;
  issueId: string;
  title: string;
  spec?: string;
  state?: string;
  branch?: string | null;
  commitSha?: string | null;
  worktree?: string | null;
  baseCommit?: string | null;
  featureId?: string | null;
  kind?: string | null;
  /** The commit that holds the main folder as it was when the task started. */
  mainSnapshot?: string | null;
  /** The repo the task was cut in, by its name in the workspace; null for the project folder itself. */
  repo?: string | null;
  /** The dropped task this one replaces. */
  replaces?: string | null;
};
export type Task = {
  id: string;
  issueId: string;
  title: string;
  spec: string;
  state: string;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  commitSha: string | null;
  featureId: string | null;
  kind: string | null;
  reviewMode: string | null;
  pushResult: string | null;
  pushDetail: string | null;
  /** The pull request the engine opened for a truest task; null until then. */
  prUrl: string | null;
  /** The commit that holds the main folder as it was when the task started; null for a task started before tasks kept one. */
  mainSnapshot: string | null;
  /** The repo the task was cut in, by its name in the workspace; null for the project folder itself. */
  repo: string | null;
  /** Why the task was dropped; null unless it is. */
  dropReason: string | null;
  /** The dropped task this one replaces; null when it replaces none. */
  replaces: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
};
export type TaskChanges = {
  state?: string;
  commitSha?: string | null;
  reviewMode?: string | null;
  pushResult?: string | null;
  pushDetail?: string | null;
  prUrl?: string | null;
  /** A truest task rebased onto a moved base branch now leaves it at the new base. */
  baseCommit?: string | null;
  /** The worktree a worker's host made and tmb adopted as the task's. */
  worktree?: string | null;
  /** Why the planner or the Human dropped the task. */
  dropReason?: string | null;
  /** The workspace repo of a task made before its project became a workspace (trustmybot/tmb#257). */
  repo?: string | null;
};

type TaskRow = {
  id: string;
  issue_id: string;
  title: string;
  spec: string;
  state: string;
  branch: string | null;
  worktree: string | null;
  base_commit: string | null;
  commit_sha: string | null;
  feature_id: string | null;
  kind: string | null;
  review_mode: string | null;
  push_result: string | null;
  push_detail: string | null;
  pr_url?: string | null;
  main_snapshot?: string | null;
  repo?: string | null;
  drop_reason?: string | null;
  replaces?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    issueId: row.issue_id,
    title: row.title,
    spec: row.spec,
    state: row.state,
    branch: row.branch,
    worktree: row.worktree,
    baseCommit: row.base_commit,
    commitSha: row.commit_sha,
    featureId: row.feature_id,
    kind: row.kind,
    reviewMode: row.review_mode,
    pushResult: row.push_result,
    pushDetail: row.push_detail,
    prUrl: row.pr_url ?? null,
    mainSnapshot: row.main_snapshot ?? null,
    repo: row.repo ?? null,
    dropReason: row.drop_reason ?? null,
    replaces: row.replaces ?? null,
    createdBy: actorOf(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskRepository {
  constructor(private readonly log: EventLog) {}

  appendTask(actor: Actor, task: NewTask): string {
    return this.log.create(actor, "task", {
      issue_id: task.issueId,
      title: task.title,
      spec: task.spec ?? "",
      state: task.state ?? NEW_TASK_STATE,
      branch: task.branch ?? null,
      commit_sha: task.commitSha ?? null,
      worktree: task.worktree ?? null,
      base_commit: task.baseCommit ?? null,
      feature_id: task.featureId ?? null,
      kind: task.kind ?? null,
      main_snapshot: task.mainSnapshot ?? null,
      repo: task.repo ?? null,
      replaces: task.replaces ?? null,
    }, task.id);
  }

  updateTask(actor: Actor, id: string, changes: TaskChanges): void {
    this.log.update(actor, "task", id, {
      state: changes.state,
      commit_sha: changes.commitSha,
      review_mode: changes.reviewMode,
      push_result: changes.pushResult,
      push_detail: changes.pushDetail,
      pr_url: changes.prUrl,
      base_commit: changes.baseCommit,
      worktree: changes.worktree,
      drop_reason: changes.dropReason,
      repo: changes.repo,
    });
  }

  getTask(id: string): Task | null {
    const row = this.log.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
    return row ? toTask(row) : null;
  }

  /** Tasks in one state, or in any state when none is given, oldest first. */
  listTasks(state?: string): Task[] {
    const rows = (
      state === undefined
        ? this.log.db.query("SELECT * FROM tasks ORDER BY id").all()
        : this.log.db.query("SELECT * FROM tasks WHERE state = ? ORDER BY id").all(state)
    ) as TaskRow[];
    return rows.map(toTask);
  }

  /** A feature branch's tasks, oldest first. */
  listFeatureTasks(featureId: string): Task[] {
    const rows = this.log.db.query("SELECT * FROM tasks WHERE feature_id = ? ORDER BY id").all(featureId) as TaskRow[];
    return rows.map(toTask);
  }
}
