// The project's configuration lives in the record: each change to a setting is one audit
// entry, and a setting's current value is its newest entry.
import type { Actor, Store } from "./store/index.ts";

export const SETTING_NAMES = ["host", "base_branch", "review_mode", "checks"] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

export const REVIEW_MODES = ["agile", "truest"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];
/** The review modes built so far; the others are refused until their level. */
export const AVAILABLE_REVIEW_MODES: readonly ReviewMode[] = ["agile"];

export type SettingValues = { host: string; base_branch: string; review_mode: ReviewMode; checks: string[] };
/** Each setting's current value, null while it has never been set. */
export type Settings = { [N in SettingName]: SettingValues[N] | null };

export class SettingError extends Error {
  override name = "SettingError";
}

const AUDIT_PREFIX = "setting:";

function nonEmptyText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new SettingError(`${name} must be a non-empty text, got ${JSON.stringify(value)}`);
  return value.trim();
}

function reviewMode(value: unknown): ReviewMode {
  if (value === "truest") throw new SettingError("review mode truest arrives at level 10; only agile is available now");
  if (!AVAILABLE_REVIEW_MODES.includes(value as ReviewMode)) {
    throw new SettingError(`review mode must be ${AVAILABLE_REVIEW_MODES.join(" or ")}, got ${JSON.stringify(value)}`);
  }
  return value as ReviewMode;
}

function checkList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new SettingError(`checks must be a list of commands, got ${JSON.stringify(value)}`);
  return value.map((check) => nonEmptyText("each check", check));
}

/** Checks a value for a setting and returns it as it is stored: text trimmed. Throws SettingError. */
export function validateSetting<N extends SettingName>(name: N, value: unknown): SettingValues[N] {
  switch (name) {
    case "host":
      return nonEmptyText("host", value) as SettingValues[N];
    case "base_branch":
      return nonEmptyText("base branch", value) as SettingValues[N];
    case "review_mode":
      return reviewMode(value) as SettingValues[N];
    case "checks":
      return checkList(value) as SettingValues[N];
  }
  throw new SettingError(`unknown setting ${JSON.stringify(name)}; the settings are ${SETTING_NAMES.join(", ")}`);
}

/** The current value of every setting. */
export function readSettings(store: Store): Settings {
  const settings: Record<string, unknown> = {};
  for (const name of SETTING_NAMES) {
    const entry = store.newestAudit(AUDIT_PREFIX + name);
    settings[name] = entry ? JSON.parse(entry.detail) : null;
  }
  return settings as Settings;
}

/**
 * Sets one setting, recording the change as an audit entry by `actor`. A value equal to the
 * current one records nothing. Returns whether an entry was recorded.
 */
export function writeSetting<N extends SettingName>(store: Store, actor: Actor, name: N, value: unknown): boolean {
  const detail = JSON.stringify(validateSetting(name, value));
  if (store.newestAudit(AUDIT_PREFIX + name)?.detail === detail) return false;
  store.recordAudit(actor, { what: AUDIT_PREFIX + name, detail });
  return true;
}

const LABELS: Record<SettingName, string> = { host: "host", base_branch: "base branch", review_mode: "review mode", checks: "checks" };

/** One line per setting, as the command line shows them. */
export function settingLines(settings: Settings): string[] {
  return SETTING_NAMES.map((name) => {
    const value = settings[name];
    const shown =
      value === null ? "(not set)" : Array.isArray(value) ? (value.length === 0 ? "(none)" : value.map((check) => JSON.stringify(check)).join(", ")) : value;
    return `${LABELS[name]}: ${shown}`;
  });
}
