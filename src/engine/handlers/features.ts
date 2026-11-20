// Feature branches: the planner names one for the work of a milestone, the engine cuts it
// from the base branch, and each task of that work is cut from its tip and folds back into it.
import { gitFailure, runGit } from "../git.ts";
import { refreshPullRequestStates } from "../pull-request-state.ts";
import { repoOfRow, resolveRepo } from "../repos.ts";
import { readSettings } from "../settings.ts";
import type { Actor, Feature, Store } from "../store/index.ts";
import { OPEN, type OperationContext, requireRole, TASK_BRANCH_PREFIX, TRUEST } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { branchRef } from "./fold.ts";
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
  const baseCommit = baseBranchTip(dir, baseBranch, `the feature branch ${name}`);

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

// --- feature_list -------------------------------------------------------------------------

export const featureListSchema: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

export function featureList(store: Store, actor: Actor, input: unknown, context?: OperationContext): FeatureSummary[] {
  validateInput("feature_list", featureListSchema, input);
  // A feature whose pull request merged or closed moves on first (trustmybot/tmb#131); a read that fails changes nothing.
  if (context !== undefined) refreshPullRequestStates(store, actor, context.projectDir);
  return store.listFeatures().map((feature) => summaryOf(store, feature));
}
