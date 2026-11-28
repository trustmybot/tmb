// Feature branches: the planner names one for the work of a milestone, the engine cuts it
// from the base branch, and each task of that work is cut from its tip and folds back into it.
import { runningName } from "../program.ts";
import { type Git, gitFailure, runGit, SYSTEM_GIT } from "../git.ts";
import { refreshLocalMerges, refreshPullRequestStates } from "../pull-request-state.ts";
import { repoOfRow, resolveRepo } from "../repos.ts";
import { readSettings, reviewModeOf } from "../settings.ts";
import type { Actor, Feature, Store } from "../store/index.ts";
import { CLOSED_UNMERGED, DROPPED, IN_REVIEW, OPEN, type OperationContext, PR_OPEN, READY, TASK_BRANCH_PREFIX, TRUEST } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { backupPush, branchRef, isAncestor, moveFeature, type PushOutcome } from "./fold.ts";
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
  /** Why it was dropped; null unless it is. */
  dropReason: string | null;
};

function howToStart(): string {
  return `start one with feature_start`;
}

function summaryOf(store: Store, feature: Feature): FeatureSummary {
  return {
    id: feature.id,
    name: feature.name,
    baseBranch: feature.baseBranch,
    baseCommit: feature.baseCommit,
    state: feature.state,
    repo: feature.repo,
    tasks: store.listFeatureTasks(feature.id).map((task) => task.id),
    dropReason: feature.dropReason,
  };
}

/** The commit the base branch is at now, or a refusal naming why it cannot be read. */
export function baseBranchTip(projectDir: string, baseBranch: string, cutting: string): string {
  // A leading dash would reach git as an option, and no branch name starts with one.
  if (baseBranch.startsWith("-")) throw new HandlerError("refused", `the base branch ${baseBranch} is not a branch name; set another with \`${runningName()} onboard --base <branch>\``);
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
 * The feature branch a task starts on: the one named, or with none named the only one open (in
 * `repo` when the task names one). A branch named whose pull request closed without a merge takes
 * the task too: the task start moves it back to open (trustmybot/tmb#152). So does one whose pull
 * request is open, which stays pr_open: a fix task (trustmybot/tmb#168). Refuses none open,
 * several open, and a name the record does not hold open or closed.
 */
export function featureForTask(store: Store, name: string | undefined, repo?: string): Feature {
  const open = store.listFeatures(OPEN).filter((feature) => name !== undefined || repo === undefined || feature.repo === repo);
  const names = open.map((feature) => feature.name).join(", ");
  if (name !== undefined) {
    const feature = store.findFeature(name);
    if (!feature) {
      throw new HandlerError("not_found", `no feature branch ${name} in the record; ${open.length === 0 ? howToStart() : `the open ones are ${names}`}`);
    }
    if (feature.state !== OPEN && feature.state !== CLOSED_UNMERGED && feature.state !== PR_OPEN && feature.state !== READY) {
      throw new HandlerError(
        "refused",
        `the feature branch ${name} is ${feature.state}; a task starts only on an open one, one whose pull request is open, one ready for a local merge, or one whose pull request closed without a merge`,
      );
    }
    return feature;
  }
  if (open.length === 1) return open[0]!;
  if (open.length === 0) throw new HandlerError("refused", `no feature branch is open, and every task is cut from one; ${howToStart()}, then start the task`);
  throw new HandlerError("refused", `${open.length} feature branches are open (${names}); name the one this task belongs to with feature`);
}

// --- schemas --------------------------------------------------------------------------------

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

export const featureUpdateSchema: InputSchema = {
  type: "object",
  properties: {
    feature: { type: "string", description: "The feature branch's name, as feature_list shows it.", pattern: NOT_BLANK },
  },
  required: ["feature"],
  additionalProperties: false,
};

export const featureListSchema: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

export const featureDropSchema: InputSchema = {
  type: "object",
  properties: {
    feature: { type: "string", description: "The feature branch's name, as feature_list shows it.", pattern: NOT_BLANK },
    reason: {
      type: "string",
      description: "Why the feature branch is dropped: nobody will merge it, or its work reached the base branch another way (say where).",
      pattern: NOT_BLANK,
    },
  },
  required: ["feature", "reason"],
  additionalProperties: false,
};

/** The refusal when the repo work is cut in has no base branch. */
export function noBaseBranch(repo: string | null): string {
  return repo === null
    ? `no base branch is set: the planner sets it with settings_set, or the Human with \`${runningName()} onboard --base <branch>\`; in a project where \`${runningName()} init\` has not run, run it first`
    : `the repo ${repo} has no base branch set: the planner sets it in repos with settings_set, or the Human with \`${runningName()} onboard --repo ${repo} --base <branch>\``;
}

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

export type FeatureDropResult = {
  feature: FeatureSummary;
  /** The branch, kept, with how to delete it; null when git no longer has it. */
  keptBranch: string | null;
};

/** What a merge of two commits gives: the merged tree, or the files left in conflict. */
type MergeTree = { kind: "tree"; tree: string } | { kind: "conflicts"; conflicts: string[] };

/** Feature branches for one caller: start, update, list and drop. */
export class FeatureService {
  constructor(
    private readonly store: Store,
    private readonly actor: Actor,
    private readonly context: OperationContext | undefined,
    private readonly git: Git = SYSTEM_GIT,
  ) {}

  start(input: unknown): FeatureSummary {
    const { store, actor } = this;
    const { name, repo: named } = validateInput<{ name: string; repo?: string }>("feature_start", featureStartSchema, input);
    const repo = resolveRepo(store, this.projectDir(), named);
    const dir = repo.dir;
    this.requireBranchName(dir, name);
    const settings = readSettings(store);
    const baseBranch = repo.baseBranch;
    if (baseBranch === null) throw new HandlerError("refused", noBaseBranch(repo.name));
    if (reviewModeOf(settings, repo.name) === TRUEST) {
      throw new HandlerError(
        "refused",
        `${repo.name === null ? "the project is" : `the repo ${repo.name} is`} in truest mode, which has no feature branches: each task is cut from the base branch ${baseBranch}, reviewed on its own and opened as its own pull request. Start the task with task_start.`,
      );
    }
    this.refuseRecorded(name);
    const ref = branchRef(name);
    if (this.git.run(dir, ["rev-parse", "--verify", "--quiet", ref]).ok) {
      throw new HandlerError("refused", `the branch ${name} already exists in git; pick another name`);
    }
    const baseCommit = fetchedBase(dir, baseBranch, `the feature branch ${name}`);

    // The empty old value makes git refuse when the branch appeared since the check above.
    const created = this.git.run(dir, ["update-ref", "-m", `tmb: feature_start ${name} at ${baseBranch}`, ref, baseCommit, ""]);
    if (!created.ok) throw new HandlerError("refused", `git could not create the branch ${name}, so nothing was recorded: ${gitFailure(created)}`);
    let id: string;
    try {
      id = store.transaction(() => {
        this.refuseRecorded(name);
        return store.createFeature(actor, { name, baseBranch, baseCommit, repo: repo.name });
      });
    } catch (error) {
      this.git.run(dir, ["update-ref", "-d", ref, baseCommit]);
      throw error;
    }
    return summaryOf(store, store.getFeature(id)!);
  }

  /**
   * Brings the base branch into a feature branch, so its review judges a tip that holds the base and
   * a conflict shows here, before the pull request. Merges, never rebases: the branch is pushed as a
   * backup, and rewriting it would rewrite what was pushed. A conflict changes nothing and names the files.
   */
  update(input: unknown): FeatureUpdateResult {
    const { store, actor } = this;
    const given = validateInput<{ feature: string }>("feature_update", featureUpdateSchema, input);
    // A ready branch the Human already merged locally is merged, not updated (trustmybot/tmb#183).
    refreshLocalMerges(store, actor, this.projectDir());
    const feature = store.findFeature(given.feature);
    if (!feature) throw new HandlerError("not_found", `no feature branch ${given.feature} in the record; feature_list lists them`);
    if (feature.state !== OPEN && feature.state !== PR_OPEN && feature.state !== READY) {
      throw new HandlerError("refused", `the feature branch ${feature.name} is ${feature.state}; only an open one, one whose pull request is open, or one ready for a local merge takes the base branch in`);
    }
    const dir = featureDir(store, this.projectDir(), feature);
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
      const merged = this.mergeTree(dir, from, base);
      if (merged.kind === "conflicts") {
        throw new HandlerError(
          "refused",
          `bringing ${feature.baseBranch} at ${base} into the feature branch ${feature.name} conflicts in:\n${merged.conflicts.join("\n")}\n` +
            `Nothing changed: ${feature.name} stays at ${from}. Settle it in a task on ${feature.name} whose worker runs \`git merge ${base}\` in its worktree, resolves the conflicts and commits, or raise it to the Human; then call feature_update again.`,
        );
      }
      const message = `Merge ${feature.baseBranch} into ${feature.name}\n\ntmb: feature_update brought ${feature.baseBranch} at ${base} into ${feature.name}.`;
      const committed = this.git.run(dir, ["commit-tree", merged.tree, "-p", from, "-p", base, "-m", message]);
      if (!committed.ok) throw new HandlerError("refused", `git could not write the merge commit, so ${feature.name} stays at ${from}: ${gitFailure(committed)}`);
      to = committed.stdout;
      how = "merged";
    }
    const why = `tmb: feature_update ${feature.name} with ${feature.baseBranch} at ${base}`;
    const undo = moveFeature(dir, feature.name, from, to, why);
    try {
      store.transaction(() => {
        // The base commit brought in is the feature's own column; from, to and how stay in the event (trustmybot/tmb#408).
        // A ready branch's tip moved: it is open again until a pass or a waiver covers the new tip and feature_pr makes it ready.
        store.updateFeature(actor, feature.id, { baseMergedCommit: base, ...(feature.state === READY ? { state: OPEN } : {}) }, { from, to, how });
      });
    } catch (error) {
      undo();
      throw error;
    }
    return result(to, how, backupPush(store, dir, feature.name, actor));
  }

  list(input: unknown): FeatureSummary[] {
    validateInput("feature_list", featureListSchema, input);
    // A feature whose pull request merged or closed moves on first (trustmybot/tmb#131); a read that fails changes nothing.
    if (this.context !== undefined) refreshPullRequestStates(this.store, this.actor, this.context.projectDir);
    return this.store.listFeatures().map((feature) => summaryOf(this.store, feature));
  }

  /**
   * Ends a feature branch without a merge tmb saw, with the reason (trustmybot/tmb#214): one nobody
   * will merge, or one whose work reached the base branch in a way tmb cannot tell. Open, closed and
   * ready branches are dropped; one whose pull request is open is not, since GitHub could still merge
   * it: the Human closes the pull request first. Refused while a task on it is open or in review. The
   * branch itself is kept, so nothing committed is lost.
   */
  drop(input: unknown): FeatureDropResult {
    const { store, actor } = this;
    const given = validateInput<{ feature: string; reason: string }>("feature_drop", featureDropSchema, input);
    // A pull request that merged or closed, or a local merge, is recorded first: a merged branch is not dropped.
    refreshPullRequestStates(store, actor, this.projectDir());
    store.transaction(() => {
      const feature = store.findFeature(given.feature);
      if (!feature) throw new HandlerError("not_found", `no feature branch ${given.feature} in the record; feature_list lists them`);
      if (feature.state === PR_OPEN) {
        throw new HandlerError(
          "refused",
          `the feature branch ${feature.name} has an open pull request${feature.prUrl === null ? "" : ` (${feature.prUrl})`}, which GitHub could still merge; close the pull request first, then drop the branch once tmb records it closed`,
        );
      }
      if (feature.state !== OPEN && feature.state !== CLOSED_UNMERGED && feature.state !== READY) {
        throw new HandlerError("refused", `the feature branch ${feature.name} is ${feature.state}; only an open one, a closed one or one ready for a local merge is dropped`);
      }
      const busy = store.listFeatureTasks(feature.id).filter((task) => task.state === OPEN || task.state === IN_REVIEW);
      if (busy.length > 0) {
        throw new HandlerError(
          "refused",
          `the feature branch ${feature.name} has tasks still open or in review (${busy.map((task) => `${task.id} ${task.state}`).join(", ")}); close or drop them first`,
        );
      }
      store.updateFeature(actor, feature.id, { state: DROPPED, dropReason: given.reason.trim() });
    });
    const feature = store.findFeature(given.feature)!;
    const dir = featureDir(store, this.projectDir(), feature);
    const exists = this.git.run(dir, ["rev-parse", "--verify", "--quiet", `${branchRef(feature.name)}^{commit}`]).ok;
    const keptBranch = exists ? `the branch ${feature.name} was kept. Delete it once nothing there is needed: git branch -D ${feature.name}` : null;
    return { feature: summaryOf(store, feature), keptBranch };
  }

  /** The project folder; every operation but a list needs one. */
  private projectDir(): string {
    return this.context!.projectDir;
  }

  /** Refuses a name git would not take as a branch name as written, or one in the task branches' space. */
  private requireBranchName(dir: string, name: string): void {
    const invalid = (why: string) => new HandlerError("invalid_input", `${JSON.stringify(name)} is not a feature branch name: ${why}`);
    if (name.startsWith("-")) throw invalid("it starts with -");
    // --branch would expand @{-1} to another branch's name, so the output must be the name itself.
    const checked = this.git.run(dir, ["check-ref-format", "--branch", name]);
    if (!checked.ok || checked.stdout !== name) throw invalid("git check-ref-format --branch refuses it");
    if (name === TASK_BRANCH_PREFIX.slice(0, -1) || name.startsWith(TASK_BRANCH_PREFIX)) {
      throw invalid(`tmb cuts its task branches under ${TASK_BRANCH_PREFIX}`);
    }
  }

  private refuseRecorded(name: string): void {
    if (this.store.findFeature(name)) throw new HandlerError("refused", `the record already holds a feature branch ${name}; pick another name`);
  }

  /** The files a merge of `ours` and `theirs` would leave in conflict, or the merged tree when there are none. */
  private mergeTree(dir: string, ours: string, theirs: string): MergeTree {
    const merged = this.git.run(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs]);
    const lines = merged.stdout.split("\n").filter((line) => line !== "");
    // git exits 1 on a conflict, printing the tree and then each conflicted file; any other failure says why.
    if (merged.ok && lines.length > 0) return { kind: "tree", tree: lines[0]! };
    if (merged.status === 1 && lines.length > 1) return { kind: "conflicts", conflicts: [...new Set(lines.slice(1))] };
    throw new HandlerError("refused", `git could not merge ${theirs} into ${ours}: ${gitFailure(merged)}`);
  }
}

// The operations as the operation table and the command line call them.
export const featureStart = (store: Store, actor: Actor, input: unknown, context: OperationContext): FeatureSummary => new FeatureService(store, actor, context).start(input);
export const featureUpdate = (store: Store, actor: Actor, input: unknown, context: OperationContext): FeatureUpdateResult => new FeatureService(store, actor, context).update(input);
export const featureList = (store: Store, actor: Actor, input: unknown, context?: OperationContext): FeatureSummary[] => new FeatureService(store, actor, context).list(input);
export const featureDrop = (store: Store, actor: Actor, input: unknown, context: OperationContext): FeatureDropResult => new FeatureService(store, actor, context).drop(input);
