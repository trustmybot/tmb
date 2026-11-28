// The project's settings through the record's tools: the planner reads them, applies the ones
// it recommends when a session starts with them empty, and changes one when the Human asks.
// The review mode is the exception: the planner sets it only to the Human's answer.
// The Human sets them with `tmb onboard`; both write the same setting changes.
import type { Action } from "../permissions.ts";
import { runningName } from "../program.ts";
import { detectBaseBranch } from "../base-branch.ts";
import { detectChecks } from "../check-detection.ts";
import { inGitWorkTree, repoDirOf, scanRepos } from "../repos.ts";
import {
  AVAILABLE_REVIEW_MODES,
  chooseReviewMode,
  ISSUE_SYNC_MODES,
  readSettings,
  type RepoPolicies,
  reviewModeChanges,
  reviewModeOf,
  type Settings,
  SettingError,
  validateRepoName,
  validateSetting,
  WORKSPACE_REVIEW_MODE,
  writeRepos,
  writeSetting,
} from "../settings.ts";
import { workingRepos } from "../repos.ts";
import type { Actor, Store } from "../store/index.ts";
import { LINK_WAYS } from "../graph/ways.ts";
import { type OperationContext } from "./common.ts";
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
  if (settings.repos !== null) {
    // A repo with a mode of its own needs none from the workspace; the mode is empty while a repo tmb works in follows none.
    const working = workingRepos(settings.repos);
    const unchosen = working.length === 0 ? settings.review_mode === null : working.some((name) => reviewModeOf(settings, name) === null);
    return unchosen ? ["review_mode"] : [];
  }
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
    shared_folders: {
      type: "array",
      description:
        "The folders, as paths inside the repo, that every task worktree links from the main folder instead of installing them: the repo's dependency folders, named from its own toolchain. Replaces the list; an empty list means none.",
      items: { type: "string", pattern: NOT_BLANK },
    },
    graph_links: {
      type: "string",
      description:
        "Which way makes the code graph's links: language-tool, the language's own tool (the default; tmb carries the TypeScript compiler), or built-in, tmb's own rules. A language with no tool uses built-in, and the graph's answer says so. In a workspace, the workspace's; a repo's own in repos.",
      enum: LINK_WAYS,
    },
    issue_sync: {
      type: "string",
      description: "Whether the remote's issues, comments, milestones and pull requests are brought into the record: on (the default) or off. Only as the Human asked.",
      enum: ISSUE_SYNC_MODES,
    },
    repos: {
      type: "object",
      description:
        "Only in a workspace of several repos: each named repo's policy, replacing that repo's; repos not named keep theirs. " +
        "base_branch is the branch its pull requests merge into, checks the commands its tasks run before they close, shared_folders the folders its task worktrees link from its main folder, review_mode its own review mode when the Human chose one, graph_links its own way to make the code graph's links, exempt true for a repo tmb does no work in.",
      additionalProperties: {
        type: "object",
        properties: {
          base_branch: { type: "string", pattern: NOT_BLANK },
          checks: { type: "array", items: { type: "string", pattern: NOT_BLANK } },
          shared_folders: { type: "array", items: { type: "string", pattern: NOT_BLANK } },
          review_mode: {
            type: "string",
            description:
              "Only the mode the Human chose for this repo when you asked them; never one you picked. " +
              `${WORKSPACE_REVIEW_MODE} takes the repo's own mode away, so it follows the workspace's review_mode. Left out, the repo keeps the mode it has.`,
            enum: [...AVAILABLE_REVIEW_MODES, WORKSPACE_REVIEW_MODE],
          },
          graph_links: { type: "string", description: "The repo's own way to make the code graph's links; left out, it follows the workspace's graph_links.", enum: LINK_WAYS },
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

type SetName = ProjectSetting | "shared_folders" | "graph_links" | "repos" | "issue_sync";
const SET_NAMES: readonly SetName[] = [...PROJECT_SETTINGS, "shared_folders", "graph_links", "repos", "issue_sync"];

export type SettingsSetResult = SettingsView & { changed: SetName[] };

/** The workspace's repos with the named ones' policies replaced; a repo must already be registered. */
function mergedRepos(current: RepoPolicies, value: unknown): RepoPolicies {
  // A repo's review mode is the Human's choice: left out, the repo keeps its own; the workspace word takes it away.
  const modes = new Map<string, unknown>();
  const rest: Record<string, unknown> = {};
  let given: RepoPolicies;
  try {
    for (const [raw, policy] of Object.entries(value as Record<string, Record<string, unknown>>)) {
      const { review_mode: mode, ...others } = policy;
      const name = validateRepoName(raw);
      modes.set(name, mode);
      rest[name] = mode === undefined || mode === WORKSPACE_REVIEW_MODE ? others : { ...others, review_mode: mode };
    }
    given = validateSetting("repos", rest);
  } catch (error) {
    if (error instanceof SettingError) throw new HandlerError("invalid_input", error.message);
    throw error;
  }
  for (const name of Object.keys(given)) {
    if (current[name] === undefined) {
      throw new HandlerError("not_found", `no repo ${JSON.stringify(name)} in this workspace; its repos are ${Object.keys(current).join(", ") || "none"}, and \`${runningName()} init\` finds new ones`);
    }
  }
  for (const name of Object.keys(given)) {
    if (current[name]!.git === false) {
      throw new HandlerError("refused", `the folder ${name} is not a repo, so it takes no policy; once it is a repo, ${runningName()} init records it as one`);
    }
    const kept = current[name]!.review_mode;
    if (modes.get(name) === undefined && kept !== undefined) given[name] = { ...given[name]!, review_mode: kept };
  }
  return { ...current, ...given };
}

/**
 * The actions a settings_set call takes: the review mode, a project-wide one or a repo's, is its
 * own action; every other setting is settings.set. A malformed call takes settings.set, and its
 * input is refused after.
 */
export function settingsSetActions(input: unknown): readonly Action[] {
  if (typeof input !== "object" || input === null) return ["settings.set"];
  const actions = new Set<Action>();
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || name === "role") continue;
    if (name === "review_mode") actions.add("settings.review-mode");
    else if (name === "repos" && typeof value === "object" && value !== null) {
      for (const policy of Object.values(value)) {
        const fields = typeof policy === "object" && policy !== null ? Object.keys(policy) : ["?"];
        for (const field of fields) actions.add(field === "review_mode" ? "settings.review-mode" : "settings.set");
      }
    } else actions.add("settings.set");
  }
  return actions.size === 0 ? ["settings.set"] : [...actions];
}

/** The project's settings for one caller: read them, and set the ones the planner may. */
export class SettingsService {
  constructor(
    private readonly store: Store,
    private readonly actor: Actor,
    private readonly context: OperationContext,
  ) {}

  get(input: unknown): SettingsView {
    validateInput("settings_get", settingsGetSchema, input);
    const settings = readSettings(this.store);
    return { settings, empty: emptySettings(settings), detected: detectedSettings(this.context.projectDir) };
  }

  set(input: unknown): SettingsSetResult {
    const values = validateInput<Partial<Record<SetName, unknown>>>("settings_set", settingsSetSchema, input);
    const named = SET_NAMES.filter((name) => values[name] !== undefined);
    if (named.length === 0) throw new HandlerError("invalid_input", `settings_set needs at least one of ${SET_NAMES.join(", ")}`);
    const repos = readSettings(this.store).repos;
    if (repos === null && named.includes("repos")) {
      throw new HandlerError("refused", "this project is one repo, so it has no repos to set; set base_branch and checks instead");
    }
    if (repos !== null) {
      const projectWide = named.filter((name) => name === "base_branch" || name === "checks" || name === "shared_folders");
      if (projectWide.length > 0) {
        throw new HandlerError("refused", `this project is a workspace of several repos, each with its own base branch, checks and shared folders; set ${projectWide.join(" and ")} for a repo through repos`);
      }
    }
    // With no one to ask, no one chose: the planner never picks the review mode for the Human.
    if (this.context.unattended === true && named.includes("review_mode") && values.review_mode !== readSettings(this.store).review_mode) {
      throw new HandlerError(
        "refused",
        `the review mode is the Human's choice, and no one can answer in this run; the Human sets it with \`${runningName()} onboard\` (\`${runningName()} onboard --review-mode <mode>\`, once they type yes on their terminal)`,
      );
    }
    const nextRepos = repos !== null && named.includes("repos") ? mergedRepos(repos, values.repos) : null;
    if (this.context.unattended === true && nextRepos !== null && reviewModeChanges(repos, nextRepos).length > 0) {
      throw new HandlerError(
        "refused",
        `a repo's review mode is the Human's choice, and no one can answer in this run; the Human sets it with \`${runningName()} onboard\` (\`${runningName()} onboard --repo <repo> --review-mode <mode> --yes\` without a question)`,
      );
    }
    const changed: SetName[] = [];
    try {
      this.store.transaction(() => {
        for (const name of named) {
          // The review mode is the Human's choice, which the planner passes on; the record says it came through the planner.
          const wrote =
            name === "review_mode"
              ? chooseReviewMode(this.store, this.actor, values[name], "planner")
              : name === "repos"
                ? writeRepos(this.store, this.actor, nextRepos, "planner")
                : writeSetting(this.store, this.actor, name, values[name]);
          if (wrote) changed.push(name);
        }
      });
    } catch (error) {
      if (error instanceof SettingError) throw new HandlerError("invalid_input", error.message);
      throw error;
    }
    return { ...this.get({}), changed };
  }
}

// The operations as the operation table and the command line call them.
export const settingsGet = (store: Store, actor: Actor, input: unknown, context: OperationContext): SettingsView => new SettingsService(store, actor, context).get(input);
export const settingsSet = (store: Store, actor: Actor, input: unknown, context: OperationContext): SettingsSetResult => new SettingsService(store, actor, context).set(input);
