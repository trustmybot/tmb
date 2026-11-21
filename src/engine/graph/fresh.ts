// Freshness: every read first brings a graph that is behind its base branch forward. A read for
// an open task answers from the task's commit, and a read for a feature branch from the branch's
// tip, each in a layer of its own brought forward the same way (trustmybot/tmb#182). Bringing a
// layer forward reparses only the files whose content changed; anything else is a rebuild of it.
import type { Database } from "bun:sqlite";
import { detectBaseBranch } from "../base-branch.ts";
import { CLOSED, MERGED, OPEN } from "../handlers/common.ts";
import { HandlerError } from "../handlers/errors.ts";
import { inGitWorkTree, type Repo, repoOfRow, resolveRepo, scanRepos } from "../repos.ts";
import type { Feature, Store } from "../store/index.ts";
import { buildLayer, type BuildStats, EXTRACTOR_VERSION } from "./build.ts";
import { BASE_LAYER, dropLayer, featureLayer, layerRow, openGraphDb, taskLayer } from "./db.ts";
import { baseCommit, resolveCommit } from "./git-source.ts";

/** What a read was answered from, and whether it had to bring the graph forward first. */
export type Freshness = {
  baseBranch: string;
  /** The base branch commit the graph answers from. */
  commit: string;
  /** The commit the graph held before this read brought it forward; null when it was at this commit already. */
  broughtForwardFrom: string | null;
  /** True when this read rebuilt the graph because tmb's reader of the code changed (trustmybot/tmb#232). */
  readerChanged: boolean;
  /** Set when the read is for a task: the task's commit, laid on top of the base. */
  task: { id: string; commit: string } | null;
  /** Set when the read is for a feature branch: its name and the tip the read answered from. */
  feature: { name: string; commit: string } | null;
};

export type GraphView = { db: Database; layer: string; freshness: Freshness };

/** The branch a repo's graph is built from: its base branch, else, in a single-repo project, the one tmb detects. */
export function baseBranchOf(repo: Repo): string {
  refuseFolderOfRepos(repo);
  const branch = repo.baseBranch ?? (repo.name === null ? detectBaseBranch(repo.dir) : null);
  if (branch === null) {
    throw new HandlerError(
      "refused",
      repo.name === null ? `the code graph is built from git, and ${repo.dir} is not a git repository` : `the code graph of the repo ${repo.name} is built from its base branch, and it has none set`,
    );
  }
  return branch;
}

/**
 * A project folder that is no repo but holds repos the record does not name has no graph of its
 * own: the way on is init run again, which names them (trustmybot/tmb#258), never an index here.
 */
function refuseFolderOfRepos(repo: Repo): void {
  if (repo.name !== null || inGitWorkTree(repo.dir)) return;
  const found = scanRepos(repo.dir);
  if (found.length === 0) return;
  throw new HandlerError(
    "refused",
    `${repo.dir} is not a git repo, so it has no code graph of its own; it holds the repos ${found.join(", ")}, which the record does not name. ` +
      "Run `tmb init` there again: it names them, writes the push hook in each and builds each repo's graph",
  );
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
async function bringForward(
  db: Database,
  projectDir: string,
  layer: string,
  commit: string,
): Promise<{ from: string | null; readerChanged: boolean; stats: BuildStats | null }> {
  if (isCurrent(db, layer, commit)) return { from: null, readerChanged: false, stats: null };
  const held = layerRow(db, layer);
  const stats = await buildLayer(db, projectDir, commit, layer);
  // A graph at this commit already, built by an older reader, was rebuilt, not brought forward.
  if (held !== null && held.commit_sha === commit) return { from: null, readerChanged: true, stats };
  return { from: held?.commit_sha ?? "none", readerChanged: held !== null && held.extractor !== EXTRACTOR_VERSION, stats };
}

/** A task's work is laid on the graph while it is open, or in review in truest mode, where the reviewer reads it. */
const LAYERED_STATES = new Set(["open", "in_review"]);

/** A feature branch keeps its layer until it is merged or closed. */
const ENDED_FEATURE_STATES = new Set([MERGED, CLOSED]);

function featureIsLive(feature: Feature | null): boolean {
  return feature !== null && !ENDED_FEATURE_STATES.has(feature.state);
}

/**
 * Drops the layers of tasks that are no longer open or in review (their work is on a feature
 * branch, in a pull request, or gone) and of feature branches that are merged or closed.
 */
function dropEndedLayers(db: Database, store: Store): void {
  const layers = db.query("SELECT layer FROM layers WHERE layer LIKE 'task:%' OR layer LIKE 'feature:%'").all() as { layer: string }[];
  for (const { layer } of layers) {
    const ended = layer.startsWith("task:")
      ? !LAYERED_STATES.has(store.getTask(layer.slice("task:".length))?.state ?? "")
      : !featureIsLive(store.getFeature(layer.slice("feature:".length)));
    if (ended) db.transaction(() => dropLayer(db, layer))();
  }
}

/** The live feature branch a task's work was folded into, or null. */
function foldedInto(store: Store, taskId: string): Feature | null {
  const task = store.getTask(taskId);
  if (task === null || LAYERED_STATES.has(task.state) || task.featureId === null) return null;
  const feature = store.getFeature(task.featureId);
  return feature !== null && featureIsLive(feature) ? feature : null;
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

/** The feature branch a read names, refused unless the record holds it neither merged nor closed. */
function namedFeature(store: Store, name: string): Feature {
  const feature = store.findFeature(name);
  if (feature === null) throw new HandlerError("not_found", `no feature branch ${name} in the record; feature_list shows them`);
  if (!featureIsLive(feature)) throw new HandlerError("refused", `the feature branch ${name} is ${feature.state}; its graph is gone, so look it up without feature`);
  return feature;
}

/** The only open feature branch in a repo, or null when there is none or more than one. */
function onlyOpenFeature(store: Store, repo: Repo): Feature | null {
  const open = store.listFeatures(OPEN).filter((feature) => feature.repo === repo.name);
  return open.length === 1 ? open[0]! : null;
}

function featureTipCommit(repo: Repo, feature: Feature): string {
  const tip = resolveCommit(repo.dir, `refs/heads/${feature.name}`);
  if (tip === null) throw new HandlerError("refused", `the feature branch ${feature.name} has no commit in ${repo.dir}`);
  return tip;
}

/** What a read is for: a task, a feature branch by name, or a repo's base branch. */
export type ViewTarget = {
  taskId?: string;
  repo?: string;
  feature?: string;
  /** With no task or feature named, read the repo's only open feature branch if it has one: a task is scoped where it will be cut. */
  defaultToFeature?: boolean;
};

/**
 * Opens the graph for a read: brought forward to the base branch's newest commit; for an open
 * task, its commit; for a feature branch, its tip. A task whose work is already folded into a
 * feature branch that is still open reads that branch. The caller closes `view.db`.
 */
export async function openView(projectDir: string, store: Store, options: ViewTarget = {}): Promise<GraphView> {
  const repo = viewRepo(store, projectDir, options);
  const baseBranch = baseBranchOf(repo);
  const commit = currentBaseCommit(repo.dir, baseBranch);
  const db = openGraphDb(projectDir, repo.name);
  try {
    const { from, readerChanged } = await bringForward(db, repo.dir, BASE_LAYER, commit);
    dropEndedLayers(db, store);
    const freshness: Freshness = { baseBranch, commit, broughtForwardFrom: from, readerChanged, task: null, feature: null };
    const feature =
      options.feature !== undefined
        ? namedFeature(store, options.feature)
        : options.taskId !== undefined
          ? foldedInto(store, options.taskId)
          : options.defaultToFeature === true
            ? onlyOpenFeature(store, repo)
            : null;
    if (feature !== null) {
      const tip = featureTipCommit(repo, feature);
      const layer = featureLayer(feature.id);
      await bringForward(db, repo.dir, layer, tip);
      return { db, layer, freshness: { ...freshness, feature: { name: feature.name, commit: tip } } };
    }
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

/** The repo a read is for: a task's own, else a named feature branch's, else the repo named, else the only one. */
function viewRepo(store: Store, projectDir: string, options: ViewTarget): Repo {
  if (options.taskId !== undefined && options.feature !== undefined) throw new HandlerError("invalid_input", "name a task_id or a feature, not both");
  if (options.feature !== undefined) {
    const feature = namedFeature(store, options.feature);
    const repo = repoOfRow(store, projectDir, feature);
    if (options.repo !== undefined && resolveRepo(store, projectDir, options.repo).name !== repo.name) {
      throw new HandlerError("refused", `the feature branch ${feature.name} is in the repo ${repo.name ?? "(the project folder)"}, not ${options.repo}; leave repo out with feature`);
    }
    return repo;
  }
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
    dropEndedLayers(db, store);
    return { ...stats, baseBranch, repo: repo.name };
  } finally {
    db.close();
  }
}
