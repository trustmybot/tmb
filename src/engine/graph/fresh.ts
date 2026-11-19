// Freshness: every read first brings a graph that is behind its base branch forward, and lays
// an open task's commit on top when the read is for that task. Bringing it forward reparses
// only the files whose content changed; anything else is a rebuild of that layer.
import type { Database } from "bun:sqlite";
import { detectBaseBranch } from "../base-branch.ts";
import { HandlerError } from "../handlers/errors.ts";
import { readSettings } from "../settings.ts";
import type { Store } from "../store/index.ts";
import { buildLayer, type BuildStats, EXTRACTOR_VERSION } from "./build.ts";
import { BASE_LAYER, dropLayer, layerRow, openGraphDb, taskLayer } from "./db.ts";
import { baseCommit, resolveCommit } from "./git-source.ts";

/** What a read was answered from, and whether it had to bring the graph forward first. */
export type Freshness = {
  baseBranch: string;
  /** The base branch commit the graph answers from. */
  commit: string;
  /** The commit the graph held before this read brought it forward; null when it was current. */
  broughtForwardFrom: string | null;
  /** Set when the read is for a task: the task's commit, laid on top of the base. */
  task: { id: string; commit: string } | null;
};

export type GraphView = { db: Database; layer: string; freshness: Freshness };

export function baseBranchOf(store: Store, projectDir: string): string {
  const branch = readSettings(store).base_branch ?? detectBaseBranch(projectDir);
  if (branch === null) throw new HandlerError("refused", `the code graph is built from git, and ${projectDir} is not a git repository`);
  return branch;
}

function currentBaseCommit(projectDir: string, baseBranch: string): string {
  const commit = baseCommit(projectDir, baseBranch);
  if (commit === null) throw new HandlerError("refused", `the code graph is built from the base branch ${baseBranch}, which has no commit in ${projectDir}`);
  return commit;
}

function isCurrent(db: Database, layer: string, commit: string): boolean {
  const row = layerRow(db, layer);
  return row !== null && row.commit_sha === commit && row.extractor === EXTRACTOR_VERSION;
}

/** Brings one layer to `commit` unless it is there already; returns the commit it held before, or null when current. */
async function bringForward(db: Database, projectDir: string, layer: string, commit: string): Promise<{ from: string | null; stats: BuildStats | null }> {
  if (isCurrent(db, layer, commit)) return { from: null, stats: null };
  const from = layerRow(db, layer)?.commit_sha ?? null;
  const stats = await buildLayer(db, projectDir, commit, layer);
  return { from: from ?? "none", stats };
}

/** Drops the layers of tasks that are no longer open: their work is on a feature branch or gone. */
function dropClosedTaskLayers(db: Database, store: Store): void {
  const layers = db.query("SELECT layer FROM layers WHERE layer LIKE 'task:%'").all() as { layer: string }[];
  for (const { layer } of layers) {
    const task = store.getTask(layer.slice("task:".length));
    if (task === null || task.state !== "open") db.transaction(() => dropLayer(db, layer))();
  }
}

function taskCommit(store: Store, taskId: string): string {
  const task = store.getTask(taskId);
  if (task === null) throw new HandlerError("not_found", `no task ${taskId}`);
  if (task.state !== "open" || task.worktree === null) {
    throw new HandlerError("refused", `task ${taskId} is ${task.state}; its work is no longer laid on top of the graph, so look it up without task_id`);
  }
  const commit = resolveCommit(task.worktree, "HEAD");
  if (commit === null) throw new HandlerError("refused", `task ${taskId}'s worktree ${task.worktree} has no commit to read`);
  return commit;
}

/**
 * Opens the graph for a read: brought forward to the base branch's newest commit, and for a
 * task, with the task's commit laid on top. The caller closes `view.db`.
 */
export async function openView(projectDir: string, store: Store, options: { taskId?: string } = {}): Promise<GraphView> {
  const baseBranch = baseBranchOf(store, projectDir);
  const commit = currentBaseCommit(projectDir, baseBranch);
  const db = openGraphDb(projectDir);
  try {
    const { from } = await bringForward(db, projectDir, BASE_LAYER, commit);
    dropClosedTaskLayers(db, store);
    const freshness: Freshness = { baseBranch, commit, broughtForwardFrom: from, task: null };
    if (options.taskId === undefined) return { db, layer: BASE_LAYER, freshness };
    const onTop = taskCommit(store, options.taskId);
    const layer = taskLayer(options.taskId);
    await bringForward(db, projectDir, layer, onTop);
    return { db, layer, freshness: { ...freshness, task: { id: options.taskId, commit: onTop } } };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Indexes the base branch now; with `rebuild`, forgets every cached parse and rebuilds from scratch. */
export async function indexProject(projectDir: string, store: Store, options: { rebuild: boolean }): Promise<BuildStats & { baseBranch: string }> {
  const baseBranch = baseBranchOf(store, projectDir);
  const commit = currentBaseCommit(projectDir, baseBranch);
  const db = openGraphDb(projectDir);
  try {
    if (options.rebuild) db.run("DELETE FROM parsed");
    const stats = await buildLayer(db, projectDir, commit, BASE_LAYER);
    dropClosedTaskLayers(db, store);
    return { ...stats, baseBranch };
  } finally {
    db.close();
  }
}
