// The project's configuration lives in the record: each change to a setting is one audit
// entry, and a setting's current value is its newest entry.
import type { Actor, Role, Store } from "./store/index.ts";

export const SETTING_NAMES = ["host", "host_roles", "base_branch", "review_mode", "checks"] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

export const REVIEW_MODES = ["agile", "truest"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];
/** The review modes built so far; the others are refused until their level. */
export const AVAILABLE_REVIEW_MODES: readonly ReviewMode[] = ["agile"];

/** The roles a host's main agent can take: it plans, or it only reviews. A worker is always a subagent. */
export const HOST_ROLES = ["planner", "reviewer"] as const satisfies readonly Role[];
export type HostRole = (typeof HOST_ROLES)[number];
/** The role each host set up in the project takes, by host id. */
export type HostRoles = Record<string, HostRole>;
/** A host with no role in the record is the planner, as every host was before roles per host. */
export const DEFAULT_HOST_ROLE: HostRole = "planner";

export type SettingValues = { host: string; host_roles: HostRoles; base_branch: string; review_mode: ReviewMode; checks: string[] };
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

/** Checks one host role. Throws SettingError. */
export function validateHostRole(value: unknown): HostRole {
  if (!HOST_ROLES.includes(value as HostRole)) throw new SettingError(`a host's role must be ${HOST_ROLES.join(" or ")}, got ${JSON.stringify(value)}`);
  return value as HostRole;
}

function hostRoles(value: unknown): HostRoles {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SettingError(`host roles must map each host to its role, got ${JSON.stringify(value)}`);
  const roles: HostRoles = {};
  for (const host of Object.keys(value).sort()) roles[nonEmptyText("a host", host)] = validateHostRole((value as Record<string, unknown>)[host]);
  return roles;
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
    case "host_roles":
      return hostRoles(value) as SettingValues[N];
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

/** The role the host's main agent takes in the project: its role in the record, else the planner. */
export function hostRole(store: Store, host: string): HostRole {
  const entry = store.newestAudit(AUDIT_PREFIX + "host_roles");
  const roles = entry ? (JSON.parse(entry.detail) as HostRoles) : {};
  return Object.hasOwn(roles, host) ? roles[host]! : DEFAULT_HOST_ROLE;
}

const LABELS: Record<SettingName, string> = { host: "host", host_roles: "host roles", base_branch: "base branch", review_mode: "review mode", checks: "checks" };

/** One line per setting, as the command line shows them. */
export function settingLines(settings: Settings): string[] {
  return SETTING_NAMES.map((name) => {
    const value = settings[name];
    if (name === "host_roles" && value !== null) {
      const entries = Object.entries(value as HostRoles);
      return `${LABELS[name]}: ${entries.length === 0 ? "(none)" : entries.map(([host, role]) => `${host} ${role}`).join(", ")}`;
    }
    const shown =
      value === null ? "(not set)" : Array.isArray(value) ? (value.length === 0 ? "(none)" : value.map((check) => JSON.stringify(check)).join(", ")) : value;
    return `${LABELS[name]}: ${shown}`;
  });
}
