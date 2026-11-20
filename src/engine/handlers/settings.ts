// The project's settings through the record's tools: the planner reads them, applies the ones
// it recommends when a session starts with them empty, and changes one when the Human asks.
// The review mode is the exception: the planner sets it only to the Human's answer.
// The Human sets them with `tmb onboard`; both write the same audit entries.
import { detectBaseBranch } from "../base-branch.ts";
import { detectChecks } from "../check-detection.ts";
import { inGitWorkTree, repoDirOf, scanRepos } from "../repos.ts";
import { AVAILABLE_REVIEW_MODES, chooseReviewMode, readSettings, type RepoPolicies, type Settings, SettingError, validateSetting, writeSetting } from "../settings.ts";
import type { Actor, Store } from "../store/index.ts";
import { type OperationContext, requireRole } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { type InputSchema, NOT_BLANK, validateInput } from "./input.ts";

/** The settings a project needs before work starts; empty until the planner or `tmb onboard` sets them. */
export const PROJECT_SETTINGS = ["base_branch", "review_mode", "checks"] as const;
export type ProjectSetting = (typeof PROJECT_SETTINGS)[number];

/**
 * The project settings no one has set yet. In a workspace each repo keeps its own base branch and
 * checks in repos, so only the review mode can be empty.
 */
export function emptySettings(settings: Settings): ProjectSetting[] {
  if (settings.repos !== null) return settings.review_mode === null ? ["review_mode"] : [];
  return PROJECT_SETTINGS.filter((name) => settings[name] === null);
}

/** What tmb finds in a repo: the base branch its own git points at and the checks its files suggest. */
export type DetectedRepo = { base_branch: string | null; checks: string[] };

/**
 * What tmb finds in the project, offered to the planner as a start for its recommendation. In a
 * workspace (a folder that is not a git work tree), each repo it holds, by name.
 */
export type Detected = { base_branch: string | null; review_modes: readonly string[]; checks: string[]; repos?: Record<string, DetectedRepo> };

export function detectedSettings(projectDir: string): Detected {
  const found = inGitWorkTree(projectDir) ? [] : scanRepos(projectDir);
  if (found.length > 0) {
    const repos: Record<string, DetectedRepo> = {};
    for (const name of found) {
      const dir = repoDirOf(projectDir, name);
      repos[name] = { base_branch: detectBaseBranch(dir), checks: detectChecks(dir) };
    }
    return { base_branch: null, review_modes: AVAILABLE_REVIEW_MODES, checks: [], repos };
  }
  return { base_branch: detectBaseBranch(projectDir), review_modes: AVAILABLE_REVIEW_MODES, checks: detectChecks(projectDir) };
}

// --- settings_get -------------------------------------------------------------------------

export const settingsGetSchema: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

export type SettingsView = { settings: Settings; empty: ProjectSetting[]; detected: Detected };

export function settingsGet(store: Store, _actor: Actor, input: unknown, context: OperationContext): SettingsView {
  validateInput("settings_get", settingsGetSchema, input);
  const settings = readSettings(store);
  return { settings, empty: emptySettings(settings), detected: detectedSettings(context.projectDir) };
}

// --- settings_set -------------------------------------------------------------------------

export const settingsSetSchema: InputSchema = {
  type: "object",
  properties: {
    base_branch: { type: "string", description: "The branch pull requests merge into.", pattern: NOT_BLANK },
    review_mode: {
      type: "string",
      description: "Only the mode the Human chose when you asked them; never one you picked. agile: one review per feature branch. truest: a review of every task before its push.",
      enum: AVAILABLE_REVIEW_MODES,
    },
    checks: {
      type: "array",
      description: "The shell commands that must pass before a task closes, replacing the list; an empty list means none.",
      items: { type: "string", pattern: NOT_BLANK },
    },
    repos: {
      type: "object",
      description:
        "Only in a workspace of several repos: each named repo's policy, replacing that repo's; repos not named keep theirs. " +
        "base_branch is the branch its pull requests merge into, checks the commands its tasks run before they close, exempt true for a repo tmb does no work in.",
      additionalProperties: {
        type: "object",
        properties: {
          base_branch: { type: "string", pattern: NOT_BLANK },
          checks: { type: "array", items: { type: "string", pattern: NOT_BLANK } },
          exempt: { type: "boolean" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  required: [],
  additionalProperties: false,
};

type SetName = ProjectSetting | "repos";
const SET_NAMES: readonly SetName[] = [...PROJECT_SETTINGS, "repos"];

export type SettingsSetResult = SettingsView & { changed: SetName[] };

/** The workspace's repos with the named ones' policies replaced; a repo must already be registered. */
function mergedRepos(current: RepoPolicies, value: unknown): RepoPolicies {
  let given: RepoPolicies;
  try {
    given = validateSetting("repos", value);
  } catch (error) {
    if (error instanceof SettingError) throw new HandlerError("invalid_input", error.message);
    throw error;
  }
  for (const name of Object.keys(given)) {
    if (current[name] === undefined) {
      throw new HandlerError("not_found", `no repo ${JSON.stringify(name)} in this workspace; its repos are ${Object.keys(current).join(", ") || "none"}, and \`tmb init\` finds new ones`);
    }
  }
  for (const name of Object.keys(given)) {
    if (current[name]!.git === false) {
      throw new HandlerError("refused", `the folder ${name} is not a repo, so it takes no policy; once it is a repo, tmb init records it as one`);
    }
  }
  return { ...current, ...given };
}

export function settingsSet(store: Store, actor: Actor, input: unknown, context: OperationContext): SettingsSetResult {
  requireRole(actor, "settings_set", ["planner"]);
  const values = validateInput<Partial<Record<SetName, unknown>>>("settings_set", settingsSetSchema, input);
  const named = SET_NAMES.filter((name) => values[name] !== undefined);
  if (named.length === 0) throw new HandlerError("invalid_input", `settings_set needs at least one of ${SET_NAMES.join(", ")}`);
  const repos = readSettings(store).repos;
  if (repos === null && named.includes("repos")) {
    throw new HandlerError("refused", "this project is one repo, so it has no repos to set; set base_branch and checks instead");
  }
  if (repos !== null) {
    const projectWide = named.filter((name) => name === "base_branch" || name === "checks");
    if (projectWide.length > 0) {
      throw new HandlerError("refused", `this project is a workspace of several repos, each with its own base branch and checks; set ${projectWide.join(" and ")} for a repo through repos`);
    }
  }
  // With no one to ask, no one chose: the planner never picks the review mode for the Human.
  if (context.unattended === true && named.includes("review_mode") && values.review_mode !== readSettings(store).review_mode) {
    throw new HandlerError(
      "refused",
      "the review mode is the Human's choice, and no one can answer in this run; the Human sets it with `tmb onboard` (`tmb onboard --review-mode <mode> --yes` without a question)",
    );
  }
  const changed: SetName[] = [];
  try {
    store.transaction(() => {
      for (const name of named) {
        // The review mode is the Human's choice, which the planner passes on; the record says it came through the planner.
        const wrote =
          name === "review_mode"
            ? chooseReviewMode(store, actor, values[name], "planner")
            : name === "repos"
              ? writeSetting(store, actor, "repos", mergedRepos(repos ?? {}, values.repos))
              : writeSetting(store, actor, name, values[name]);
        if (wrote) changed.push(name);
      }
    });
  } catch (error) {
    if (error instanceof SettingError) throw new HandlerError("invalid_input", error.message);
    throw error;
  }
  return { ...settingsGet(store, actor, {}, context), changed };
}
