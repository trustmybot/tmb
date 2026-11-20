// The project's settings through the record's tools: the planner reads them, applies the ones
// it recommends when a session starts with them empty, and changes one when the Human asks.
// The Human sets them with `tmb onboard`; both write the same audit entries.
import { detectBaseBranch } from "../base-branch.ts";
import { detectChecks } from "../check-detection.ts";
import { AVAILABLE_REVIEW_MODES, readSettings, type Settings, SettingError, writeSetting } from "../settings.ts";
import type { Actor, Store } from "../store/index.ts";
import { type OperationContext, requireRole } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { type InputSchema, NOT_BLANK, validateInput } from "./input.ts";

/** The settings a project needs before work starts; empty until the planner or `tmb onboard` sets them. */
export const PROJECT_SETTINGS = ["base_branch", "review_mode", "checks"] as const;
export type ProjectSetting = (typeof PROJECT_SETTINGS)[number];

/** The project settings no one has set yet. */
export function emptySettings(settings: Settings): ProjectSetting[] {
  return PROJECT_SETTINGS.filter((name) => settings[name] === null);
}

/** What tmb finds in the project, offered to the planner as a start for its recommendation. */
export type Detected = { base_branch: string | null; review_modes: readonly string[]; checks: string[] };

export function detectedSettings(projectDir: string): Detected {
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
    review_mode: { type: "string", description: "agile: one review per feature branch. truest: a review of every task before its push.", enum: AVAILABLE_REVIEW_MODES },
    checks: {
      type: "array",
      description: "The shell commands that must pass before a task closes, replacing the list; an empty list means none.",
      items: { type: "string", pattern: NOT_BLANK },
    },
  },
  required: [],
  additionalProperties: false,
};

export type SettingsSetResult = SettingsView & { changed: ProjectSetting[] };

export function settingsSet(store: Store, actor: Actor, input: unknown, context: OperationContext): SettingsSetResult {
  requireRole(actor, "settings_set", ["planner"]);
  const values = validateInput<Partial<Record<ProjectSetting, unknown>>>("settings_set", settingsSetSchema, input);
  const named = PROJECT_SETTINGS.filter((name) => values[name] !== undefined);
  if (named.length === 0) throw new HandlerError("invalid_input", `settings_set needs at least one of ${PROJECT_SETTINGS.join(", ")}`);
  const changed: ProjectSetting[] = [];
  try {
    store.transaction(() => {
      for (const name of named) if (writeSetting(store, actor, name, values[name])) changed.push(name);
    });
  } catch (error) {
    if (error instanceof SettingError) throw new HandlerError("invalid_input", error.message);
    throw error;
  }
  return { ...settingsGet(store, actor, {}, context), changed };
}
