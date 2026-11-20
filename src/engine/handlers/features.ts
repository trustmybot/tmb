// Feature branches: the planner names one for the work of a milestone, the engine cuts it
// from the base branch, and each task of that work is cut from its tip and folds back into it.
import { gitFailure, runGit } from "../git.ts";
import { repoOfRow, resolveRepo } from "../repos.ts";
import { readSettings } from "../settings.ts";
import type { Actor, Feature, Store } from "../store/index.ts";
import { OPEN, type OperationContext, requireRole, TASK_BRANCH_PREFIX, TRUEST } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { branchRef, isAncestor, moveFeature, type PushOutcome, pushFeature } from "./fold.ts";
import { type InputSchema, NOT_BLANK, validateInput } from "./input.ts";

export type FeatureSummary = {
  id: string;
  name: string;
  baseBranch: string;
  baseCommit: string;
  state: string;
  /** The repo it was cut in, by its name in the workspace; null in a single-repo project. */
  repo: string | null;
  /** The ids of the tasks started on it, oldest first. */
  tasks: string[];
};

const HOW_TO_START = "start one with feature_start (`tmb feature start <name>` from the command line)";

function summaryOf(store: Store, feature: Feature): FeatureSummary {
  return {
    id: feature.id,
    name: feature.name,
    baseBranch: feature.baseBranch,
    baseCommit: feature.baseCommit,
    state: feature.state,
    repo: feature.repo,
    tasks: store.listFeatureTasks(feature.id).map((task) => task.id),
  };
}

/** The commit the base branch is at now, or a refusal naming why it cannot be read. */
export function baseBranchTip(projectDir: string, baseBranch: string, cutting: string): string {
  // A leading dash would reach git as an option, and no branch name starts with one.
  if (baseBranch.startsWith("-")) throw new HandlerError("refused", `the base branch ${baseBranch} is not a branch name; set another with \`tmb onboard --base <branch>\``);
  const resolved = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]);
  if (!resolved.ok) {
    const why = resolved.stderr === "" ? `it names no commit in the git repository at ${projectDir}` : gitFailure(resolved);
    throw new HandlerError("refused", `cannot cut ${cutting} from the base branch ${baseBranch}: ${why}`);
  }
  return resolved.stdout;
}

const ORIGIN = "origin";

/**
 * The commit a feature branch is cut from and takes in: the base branch as origin holds it,
 * fetched first, unless the local base branch holds a commit origin lacks, which only the local
 * one would carry. The local base branch when there is no origin, or origin does not have it.
 * A fetch that fails, offline say, leaves origin's copy as it was.
 */
export function fetchedBase(projectDir: string, baseBranch: string, cutting: string): string {
  if (!baseBranch.startsWith("-") && runGit(projectDir, ["remote", "get-url", ORIGIN]).ok) {
    runGit(projectDir, ["fetch", "--quiet", ORIGIN, `+refs/heads/${baseBranch}:refs/remotes/${ORIGIN}/${baseBranch}`], { GIT_TERMINAL_PROMPT: "0" });
  }
  return knownBase(projectDir, baseBranch, cutting);
}

/** The commit fetchedBase would give from what git holds now, without fetching. */
export function knownBase(projectDir: string, baseBranch: string, cutting: string): string {
  if (baseBranch.startsWith("-")) return baseBranchTip(projectDir, baseBranch, cutting);
  const remote = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ORIGIN}/${baseBranch}^{commit}`]);
  if (!remote.ok) return baseBranchTip(projectDir, baseBranch, cutting);
  const local = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${branchRef(baseBranch)}^{commit}`]);
  return !local.ok || isAncestor(projectDir, local.stdout, remote.stdout) ? remote.stdout : local.stdout;
}

/** The folder of the repo a feature branch was cut in. */
export function featureDir(store: Store, projectDir: string, feature: Feature): string {
  return repoOfRow(store, projectDir, feature).dir;
}

/** The commit the feature branch is at now, in the repo at `projectDir`; refuses when git no longer has it. */
export function featureTip(projectDir: string, feature: Feature): string {
  const resolved = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${branchRef(feature.name)}^{commit}`]);
  if (!resolved.ok) {
    const why = resolved.stderr === "" ? `the git repository at ${projectDir} has no branch ${feature.name}` : gitFailure(resolved);
    throw new HandlerError("refused", `cannot read the feature branch ${feature.name}: ${why}`);
  }
  return resolved.stdout;
}

/**
 * The open feature branch a task starts on: the one named, or with none named the only one
 * open (in `repo` when the task names one). Refuses none open, several open, and a name the
 * record does not hold open.
 */
export function featureForTask(store: Store, name: string | undefined, repo?: string): Feature {
  const open = store.listFeatures(OPEN).filter((feature) => name !== undefined || repo === undefined || feature.repo === repo);
  const names = open.map((feature) => feature.name).join(", ");
  if (name !== undefined) {
    const feature = store.findFeature(name);
    if (!feature) {
      throw new HandlerError("not_found", `no feature branch ${name} in the record; ${open.length === 0 ? HOW_TO_START : `the open ones are ${names}`}`);
    }
    if (feature.state !== OPEN) throw new HandlerError("refused", `the feature branch ${name} is ${feature.state}; a task starts only on an open one`);
    return feature;
  }
  if (open.length === 1) return open[0]!;
  if (open.length === 0) throw new HandlerError("refused", `no feature branch is open, and every task is cut from one; ${HOW_TO_START}, then start the task`);
  throw new HandlerError("refused", `${open.length} feature branches are open (${names}); name the one this task belongs to with feature`);
}

// --- feature_start ------------------------------------------------------------------------

export const featureStartSchema: InputSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The feature branch's name, a valid git branch name that no branch has yet, such as feat/dark-mode.",
      pattern: NOT_BLANK,
    },
    repo: {
      type: "string",
      description: "In a workspace of several repos, the repo to cut it in, by its name in the workspace (settings_get lists them). Omit it in a project of one repo.",
      pattern: NOT_BLANK,
    },
  },
  required: ["name"],
  additionalProperties: false,
};

/** Refuses a name git would not take as a branch name as written, or one in the task branches' space. */
function requireBranchName(projectDir: string, name: string): void {
  const invalid = (why: string) => new HandlerError("invalid_input", `${JSON.stringify(name)} is not a feature branch name: ${why}`);
  if (name.startsWith("-")) throw invalid("it starts with -");
  // --branch would expand @{-1} to another branch's name, so the output must be the name itself.
  const checked = runGit(projectDir, ["check-ref-format", "--branch", name]);
  if (!checked.ok || checked.stdout !== name) throw invalid("git check-ref-format --branch refuses it");
  if (name === TASK_BRANCH_PREFIX.slice(0, -1) || name.startsWith(TASK_BRANCH_PREFIX)) {
    throw invalid(`tmb cuts its task branches under ${TASK_BRANCH_PREFIX}`);
  }
}

function refuseRecorded(store: Store, name: string): void {
  if (store.findFeature(name)) throw new HandlerError("refused", `the record already holds a feature branch ${name}; pick another name`);
}

export function featureStart(store: Store, actor: Actor, input: unknown, context: OperationContext): FeatureSummary {
  const { name, repo: named } = validateInput<{ name: string; repo?: string }>("feature_start", featureStartSchema, input);
  requireRole(actor, "feature_start", ["planner"]);
  const repo = resolveRepo(store, context.projectDir, named);
  const dir = repo.dir;
  requireBranchName(dir, name);
  const settings = readSettings(store);
  const baseBranch = repo.baseBranch;
  if (baseBranch === null) throw new HandlerError("refused", noBaseBranch(repo.name));
  if (settings.review_mode === TRUEST) {
    throw new HandlerError(
      "refused",
      `the project is in truest mode, which has no feature branches: each task is cut from the base branch ${baseBranch}, reviewed on its own and opened as its own pull request. Start the task with task_start.`,
    );
  }
  refuseRecorded(store, name);
  const ref = branchRef(name);
  if (runGit(dir, ["rev-parse", "--verify", "--quiet", ref]).ok) {
    throw new HandlerError("refused", `the branch ${name} already exists in git; pick another name`);
  }
  const baseCommit = fetchedBase(dir, baseBranch, `the feature branch ${name}`);

  // The empty old value makes git refuse when the branch appeared since the check above.
  const created = runGit(dir, ["update-ref", "-m", `tmb: feature_start ${name} at ${baseBranch}`, ref, baseCommit, ""]);
  if (!created.ok) throw new HandlerError("refused", `git could not create the branch ${name}, so nothing was recorded: ${gitFailure(created)}`);
  let id: string;
  try {
    id = store.transaction(() => {
      refuseRecorded(store, name);
      return store.createFeature(actor, { name, baseBranch, baseCommit, repo: repo.name });
    });
  } catch (error) {
    runGit(dir, ["update-ref", "-d", ref, baseCommit]);
    throw error;
  }
  return summaryOf(store, store.getFeature(id)!);
}

/** The refusal when the repo work is cut in has no base branch. */
export function noBaseBranch(repo: string | null): string {
  return repo === null
    ? "no base branch is set: the planner sets it with settings_set, or the Human with `tmb onboard --base <branch>`; in a project where `tmb init` has not run, run it first"
    : `the repo ${repo} has no base branch set: the planner sets it in repos with settings_set, or the Human with \`tmb onboard --repo ${repo} --base <branch>\``;
}

// --- feature_update -----------------------------------------------------------------------

/** What an audit entry of a base branch brought into a feature branch is about. */
export const FEATURE_UPDATE = "feature_update";

export const featureUpdateSchema: InputSchema = {
  type: "object",
  properties: {
    feature: { type: "string", description: "The feature branch's name, as feature_list shows it.", pattern: NOT_BLANK },
  },
  required: ["feature"],
  additionalProperties: false,
};

export type FeatureUpdateResult = {
  feature: string;
  baseBranch: string;
  /** The base branch's commit taken in: origin's, fetched first, unless the local one is ahead of it. */
  base: string;
  /** The feature branch's tip before the step. */
  from: string;
  /** Its tip after: a merge commit, the base itself when the branch had no commit of its own, or `from` when it held the base already. */
  to: string;
  /** `merged`, `fast_forward`, or `none` when the branch held the base already. */
  how: "merged" | "fast_forward" | "none";
  /** The backup push of the moved branch; null when nothing moved. */
  push: PushOutcome | null;
};

/** The files a merge of `ours` and `theirs` would leave in conflict, or the merged tree when there are none. */
function mergeTree(dir: string, ours: string, theirs: string): { tree: string } | { conflicts: string[] } {
  const merged = runGit(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs]);
  const lines = merged.stdout.split("\n").filter((line) => line !== "");
  // git exits 1 on a conflict, printing the tree and then each conflicted file; any other failure says why.
  if (merged.ok && lines.length > 0) return { tree: lines[0]! };
  if (merged.status === 1 && lines.length > 1) return { conflicts: [...new Set(lines.slice(1))] };
  throw new HandlerError("refused", `git could not merge ${theirs} into ${ours}: ${gitFailure(merged)}`);
}

/**
 * Brings the base branch into a feature branch, so its review judges a tip that holds the base and
 * a conflict shows here, before the pull request. Merges, never rebases: the branch is pushed as a
 * backup, and rewriting it would rewrite what was pushed. A conflict changes nothing and names the files.
 */
export function featureUpdate(store: Store, actor: Actor, input: unknown, context: OperationContext): FeatureUpdateResult {
  const given = validateInput<{ feature: string }>("feature_update", featureUpdateSchema, input);
  requireRole(actor, "feature_update", ["planner"]);
  const feature = store.findFeature(given.feature);
  if (!feature) throw new HandlerError("not_found", `no feature branch ${given.feature} in the record; feature_list lists them`);
  if (feature.state !== OPEN) throw new HandlerError("refused", `the feature branch ${feature.name} is ${feature.state}; only an open one takes the base branch in`);
  const dir = featureDir(store, context.projectDir, feature);
  const from = featureTip(dir, feature);
  const base = fetchedBase(dir, feature.baseBranch, `into the feature branch ${feature.name}`);
  const result = (to: string, how: FeatureUpdateResult["how"], push: PushOutcome | null): FeatureUpdateResult => ({
    feature: feature.name,
    baseBranch: feature.baseBranch,
    base,
    from,
    to,
    how,
    push,
  });
  if (isAncestor(dir, base, from)) return result(from, "none", null);

  let to = base;
  let how: FeatureUpdateResult["how"] = "fast_forward";
  if (!isAncestor(dir, from, base)) {
    const merged = mergeTree(dir, from, base);
    if ("conflicts" in merged) {
      throw new HandlerError(
        "refused",
        `bringing ${feature.baseBranch} at ${base} into the feature branch ${feature.name} conflicts in:\n${merged.conflicts.join("\n")}\n` +
          `Nothing changed: ${feature.name} stays at ${from}. Settle it in a task on ${feature.name} whose worker runs \`git merge ${base}\` in its worktree, resolves the conflicts and commits, or raise it to the Human; then call feature_update again.`,
      );
    }
    const message = `Merge ${feature.baseBranch} into ${feature.name}\n\ntmb: feature_update brought ${feature.baseBranch} at ${base} into ${feature.name}.`;
    const committed = runGit(dir, ["commit-tree", merged.tree, "-p", from, "-p", base, "-m", message]);
    if (!committed.ok) throw new HandlerError("refused", `git could not write the merge commit, so ${feature.name} stays at ${from}: ${gitFailure(committed)}`);
    to = committed.stdout;
    how = "merged";
  }
  const why = `tmb: feature_update ${feature.name} with ${feature.baseBranch} at ${base}`;
  const undo = moveFeature(dir, feature.name, from, to, why);
  try {
    store.recordAudit(actor, { what: FEATURE_UPDATE, detail: JSON.stringify({ feature_id: feature.id, feature: feature.name, base, from, to, how }) });
  } catch (error) {
    undo();
    throw error;
  }
  return result(to, how, pushFeature(dir, feature.name));
}

// --- feature_list -------------------------------------------------------------------------

export const featureListSchema: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

export function featureList(store: Store, _actor: Actor, input: unknown): FeatureSummary[] {
  validateInput("feature_list", featureListSchema, input);
  return store.listFeatures().map((feature) => summaryOf(store, feature));
}
