// Feature branches: the planner names one for the work of a milestone, the engine cuts it
// from the base branch, and each task of that work is cut from its tip and folds back into it.
import { gitFailure, runGit } from "../git.ts";
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

/** The commit the feature branch is at now; refuses when git no longer has it. */
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
 * open. Refuses none open, several open, and a name the record does not hold open.
 */
export function featureForTask(store: Store, name: string | undefined): Feature {
  const open = store.listFeatures(OPEN);
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
  const { name } = validateInput<{ name: string }>("feature_start", featureStartSchema, input);
  requireRole(actor, "feature_start", ["planner"]);
  requireBranchName(context.projectDir, name);
  const settings = readSettings(store);
  const baseBranch = settings.base_branch;
  if (baseBranch === null) throw new HandlerError("refused", "no base branch is set, so tmb init has not run here; run `tmb init` in the project first");
  if (settings.review_mode === TRUEST) {
    throw new HandlerError(
      "refused",
      `the project is in truest mode, which has no feature branches: each task is cut from the base branch ${baseBranch}, reviewed on its own and opened as its own pull request. Start the task with task_start.`,
    );
  }
  refuseRecorded(store, name);
  const ref = branchRef(name);
  if (runGit(context.projectDir, ["rev-parse", "--verify", "--quiet", ref]).ok) {
    throw new HandlerError("refused", `the branch ${name} already exists in git; pick another name`);
  }
  const baseCommit = baseBranchTip(context.projectDir, baseBranch, `the feature branch ${name}`);

  // The empty old value makes git refuse when the branch appeared since the check above.
  const created = runGit(context.projectDir, ["update-ref", "-m", `tmb: feature_start ${name} at ${baseBranch}`, ref, baseCommit, ""]);
  if (!created.ok) throw new HandlerError("refused", `git could not create the branch ${name}, so nothing was recorded: ${gitFailure(created)}`);
  let id: string;
  try {
    id = store.transaction(() => {
      refuseRecorded(store, name);
      return store.createFeature(actor, { name, baseBranch, baseCommit });
    });
  } catch (error) {
    runGit(context.projectDir, ["update-ref", "-d", ref, baseCommit]);
    throw error;
  }
  return summaryOf(store, store.getFeature(id)!);
}

// --- feature_list -------------------------------------------------------------------------

export const featureListSchema: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

export function featureList(store: Store, _actor: Actor, input: unknown): FeatureSummary[] {
  validateInput("feature_list", featureListSchema, input);
  return store.listFeatures().map((feature) => summaryOf(store, feature));
}
