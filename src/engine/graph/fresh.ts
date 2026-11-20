// Freshness: every read first brings a graph that is behind its base branch forward, and lays
// an open task's commit on top when the read is for that task. Bringing it forward reparses
// only the files whose content changed; anything else is a rebuild of that layer.
import type { Database } from "bun:sqlite";
import { detectBaseBranch } from "../base-branch.ts";
import { HandlerError } from "../handlers/errors.ts";
import { type Repo, repoOfRow, resolveRepo } from "../repos.ts";
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

/** The branch a repo's graph is built from: its base branch, else, in a single-repo project, the one tmb detects. */
export function baseBranchOf(repo: Repo): string {
  const branch = repo.baseBranch ?? (repo.name === null ? detectBaseBranch(repo.dir) : null);
  if (branch === null) {
    throw new HandlerError(
      "refused",
      repo.name === null ? `the code graph is built from git, and ${repo.dir} is not a git repository` : `the code graph of the repo ${repo.name} is built from its base branch, and it has none set`,
    );
  }
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

/** A task's work is laid on the graph while it is open, or in review in truest mode, where the reviewer reads it. */
const LAYERED_STATES = new Set(["open", "in_review"]);

/** Drops the layers of tasks that are no longer open or in review: their work is on a feature branch, in a pull request, or gone. */
function dropClosedTaskLayers(db: Database, store: Store): void {
  const layers = db.query("SELECT layer FROM layers WHERE layer LIKE 'task:%'").all() as { layer: string }[];
  for (const { layer } of layers) {
    const task = store.getTask(layer.slice("task:".length));
    if (task === null || !LAYERED_STATES.has(task.state)) db.transaction(() => dropLayer(db, layer))();
  }
}

function taskCommit(store: Store, taskId: string): string {
  const task = store.getTask(taskId);
  if (task === null) throw new HandlerError("not_found", `no task ${taskId}`);
  if (!LAYERED_STATES.has(task.state) || task.worktree === null) {
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
export async function openView(projectDir: string, store: Store, options: { taskId?: string; repo?: string } = {}): Promise<GraphView> {
  const repo = viewRepo(store, projectDir, options);
  const baseBranch = baseBranchOf(repo);
  const commit = currentBaseCommit(repo.dir, baseBranch);
  const db = openGraphDb(projectDir, repo.name);
  try {
    const { from } = await bringForward(db, repo.dir, BASE_LAYER, commit);
    dropClosedTaskLayers(db, store);
    const freshness: Freshness = { baseBranch, commit, broughtForwardFrom: from, task: null };
    if (options.taskId === undefined) return { db, layer: BASE_LAYER, freshness };
    const onTop = taskCommit(store, options.taskId);
    const layer = taskLayer(options.taskId);
    await bringForward(db, repo.dir, layer, onTop);
    return { db, layer, freshness: { ...freshness, task: { id: options.taskId, commit: onTop } } };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The repo a read is for: a task's own, else the repo named, else the only one. */
function viewRepo(store: Store, projectDir: string, options: { taskId?: string; repo?: string }): Repo {
  if (options.taskId === undefined) return resolveRepo(store, projectDir, options.repo);
  const task = store.getTask(options.taskId);
  if (task === null) throw new HandlerError("not_found", `no task ${options.taskId}`);
  const repo = repoOfRow(store, projectDir, task);
  if (options.repo !== undefined && resolveRepo(store, projectDir, options.repo).name !== repo.name) {
    throw new HandlerError("refused", `task ${task.id} works in the repo ${repo.name ?? "(the project folder)"}, not ${options.repo}; leave repo out with task_id`);
  }
  return repo;
}

/** Indexes a repo's base branch now (the project folder's in a single-repo project); with `rebuild`, forgets every cached parse and rebuilds from scratch. */
export async function indexProject(
  projectDir: string,
  store: Store,
  options: { rebuild: boolean; repo?: Repo },
): Promise<BuildStats & { baseBranch: string; repo: string | null }> {
  const repo = options.repo ?? resolveRepo(store, projectDir, undefined);
  const baseBranch = baseBranchOf(repo);
  const commit = currentBaseCommit(repo.dir, baseBranch);
  const db = openGraphDb(projectDir, repo.name);
  try {
    if (options.rebuild) db.run("DELETE FROM parsed");
    const stats = await buildLayer(db, repo.dir, commit, BASE_LAYER, { force: true });
    dropClosedTaskLayers(db, store);
    return { ...stats, baseBranch, repo: repo.name };
  } finally {
    db.close();
  }
}
