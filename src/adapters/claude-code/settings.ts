// Claude Code's per-user, per-project settings file: the Human's own, never shared. tmb adds
// its hooks and enables its tool server from the project's .mcp.json.
import { existsSync } from "node:fs";
import path from "node:path";
import { ignoreInGit } from "../common/git.ts";
import { deleteFile, isObject, type JsonObject, readJsonObject, writeJsonObject } from "../common/json-file.ts";
import { SERVER_KEY } from "./mcp-json.ts";

const SETTINGS_RELATIVE = path.join(".claude", "settings.local.json");
const GITIGNORE_ENTRY = ".claude/settings.local.json";
const ENABLED_SERVERS_KEY = "enabledMcpjsonServers";

/** tmb's own tools a worker names its task with, as Claude Code names them; the first call tells tmb the worker's folder. */
export const TASK_NAMING_TOOLS = [`mcp__${SERVER_KEY}__task_brief`, `mcp__${SERVER_KEY}__task_close`] as const;

/** The tools whose calls raise a tmb event: file writes, subagent starts, and a worker naming its task. tmb reads no shell command. */
export const GUARDED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task", ...TASK_NAMING_TOOLS] as const;

/** Each Claude Code hook tmb wires: the hook event, its matcher, and the `tmb hook` name it runs. */
export const TMB_HOOKS = [
  { hookEvent: "SessionStart", name: "session-start" },
  { hookEvent: "PreToolUse", name: "pre-tool-use", matcher: GUARDED_TOOLS.join("|") },
  { hookEvent: "SubagentStop", name: "subagent-stop" },
  { hookEvent: "SessionEnd", name: "session-end" },
] as const;

type TmbHook = (typeof TMB_HOOKS)[number];
export type HookName = TmbHook["name"];
type HookCommand = { type?: unknown; command?: unknown } & JsonObject;
type HookGroup = { matcher?: unknown; hooks?: unknown } & JsonObject;

/**
 * The hooks an earlier version wired and this one no longer does. tmb still knows them as its own,
 * so init and remove take them out; a hook that moves to another event needs no entry here.
 */
export const RETIRED_HOOK_NAMES: readonly string[] = [];

const HOOK_NAMES = [...TMB_HOOKS.map((hook) => hook.name), ...RETIRED_HOOK_NAMES].join("|");
// The hook a compiled tmb writes: its quoted executable, named tmb, then the hook arguments.
const BINARY_HOOK_COMMAND = new RegExp(String.raw`^"(?:[^"]*[\\/])?tmb(?:[^"\\/]*)"\s+hook\s+(${HOOK_NAMES})$`, "i");
// The hook a source run writes: quoted Bun, then tmb's src/cli.ts, quoted or not, then the arguments.
const SOURCE_HOOK_COMMAND = new RegExp(
  String.raw`^"[^"]*"\s+(?:"[^"]*[\\/]src[\\/]cli\.ts"|[^"\s]*[\\/]src[\\/]cli\.ts)\s+hook\s+(${HOOK_NAMES})$`,
  "i",
);

export function settingsPath(projectDir: string): string {
  return path.join(projectDir, SETTINGS_RELATIVE);
}

/** The hook's shell command: each part of the tmb command quoted, then the hook arguments. */
export function hookCommand(tmbCommand: readonly string[], name: HookName): string {
  return `${tmbCommand.map((part) => `"${part}"`).join(" ")} hook ${name}`;
}

/** The `tmb hook` name a command runs when it is one of tmb's hooks, else null. */
function tmbHookName(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const match = BINARY_HOOK_COMMAND.exec(command) ?? SOURCE_HOOK_COMMAND.exec(command);
  return match ? match[1]!.toLowerCase() : null;
}

/** Whether the command is a tmb hook, any of them, or the one named. */
export function isTmbHookCommand(command: unknown, name?: HookName): boolean {
  const found = tmbHookName(command);
  return found !== null && (name === undefined || found === name);
}

function isTmbHookOf(name: HookName): (hook: unknown) => boolean {
  return (hook) => isTmbHookCommand((hook as HookCommand | null)?.command, name);
}

function hooksOf(group: unknown): unknown[] {
  const hooks = (group as HookGroup | null)?.hooks;
  return isObject(group) && Array.isArray(hooks) ? hooks : [];
}

/** Removes tmb's hooks of one kind from the groups, dropping groups left empty. */
function withoutTmbHooks(groups: unknown[], name: HookName): unknown[] {
  const isTmb = isTmbHookOf(name);
  const kept: unknown[] = [];
  for (const group of groups) {
    const hooks = hooksOf(group);
    if (!hooks.some(isTmb)) {
      kept.push(group);
      continue;
    }
    const remaining = hooks.filter((hook) => !isTmb(hook));
    if (remaining.length > 0) kept.push({ ...(group as JsonObject), hooks: remaining });
  }
  return kept;
}

function groupFor(hook: TmbHook, command: string): JsonObject {
  const group: JsonObject = "matcher" in hook ? { matcher: hook.matcher } : {};
  group.hooks = [{ type: "command", command }];
  return group;
}

/** True when the groups hold exactly one tmb hook of this kind, and it is the current one. */
function isWired(groups: unknown[], hook: TmbHook, command: string): boolean {
  const isTmb = isTmbHookOf(hook.name);
  const wired = groups.flatMap((group) => hooksOf(group).filter(isTmb).map((found) => ({ group: group as HookGroup, found })));
  if (wired.length !== 1) return false;
  const { group, found } = wired[0]!;
  const matcher = "matcher" in hook ? hook.matcher : undefined;
  return (found as HookCommand).command === command && group.matcher === matcher;
}

/** Adds the hook unless it is there already; a tmb hook of the same kind pointing elsewhere is stale and replaced. */
function addHook(settings: JsonObject, hook: TmbHook, command: string): boolean {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks[hook.hookEvent]) ? (hooks[hook.hookEvent] as unknown[]) : [];
  if (isWired(groups, hook, command)) return false;
  settings.hooks = { ...hooks, [hook.hookEvent]: [...withoutTmbHooks(groups, hook.name), groupFor(hook, command)] };
  return true;
}

function removeHook(settings: JsonObject, hook: TmbHook): boolean {
  const hooks = settings.hooks;
  const groups = isObject(hooks) ? hooks[hook.hookEvent] : undefined;
  if (!isObject(hooks) || !Array.isArray(groups)) return false;
  const kept = withoutTmbHooks(groups, hook.name);
  if (kept.length === groups.length && kept.every((group, i) => group === groups[i])) return false;
  if (kept.length > 0) hooks[hook.hookEvent] = kept;
  else delete hooks[hook.hookEvent];
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return true;
}

function enabledServers(settings: JsonObject, file: string): unknown[] {
  const enabled = settings[ENABLED_SERVERS_KEY];
  if (enabled === undefined) return [];
  if (!Array.isArray(enabled)) throw new Error(`${ENABLED_SERVERS_KEY} in ${file} is not a list`);
  return enabled;
}

/**
 * Takes out each tmb hook wired under an event its kind no longer uses: a retired hook, or one an
 * earlier version wired under another event. Returns the events it changed.
 */
function removeStrayHooks(settings: JsonObject): string[] {
  const hooks = settings.hooks;
  if (!isObject(hooks)) return [];
  const changed: string[] = [];
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const stray = (hook: unknown) => {
      const name = tmbHookName((hook as HookCommand | null)?.command);
      return name !== null && !TMB_HOOKS.some((wired) => wired.name === name && wired.hookEvent === event);
    };
    if (!groups.some((group) => hooksOf(group).some(stray))) continue;
    const kept = groups.flatMap((group) => {
      const all = hooksOf(group);
      if (!all.some(stray)) return [group];
      const remaining = all.filter((hook) => !stray(hook));
      return remaining.length > 0 ? [{ ...(group as JsonObject), hooks: remaining }] : [];
    });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
    changed.push(event);
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return changed;
}

/** `hooksAdded` and `hooksRemoved` name the Claude Code hook events tmb changed, in wiring order. */
export type SetupResult = { settingsFile: string; hooksAdded: string[]; hooksRemoved: string[]; serverEnabled: boolean; gitignoreChanged: boolean };

export function install(projectDir: string, tmbCommand: readonly string[]): SetupResult {
  const file = settingsPath(projectDir);
  const settings = readJsonObject(file);
  const enabled = enabledServers(settings, file);

  const hooksRemoved = removeStrayHooks(settings);
  const hooksAdded = TMB_HOOKS.filter((hook) => addHook(settings, hook, hookCommand(tmbCommand, hook.name))).map((hook) => hook.hookEvent);
  const serverEnabled = !enabled.includes(SERVER_KEY);
  if (serverEnabled) settings[ENABLED_SERVERS_KEY] = [...enabled, SERVER_KEY];
  if (hooksAdded.length > 0 || hooksRemoved.length > 0 || serverEnabled) writeJsonObject(file, settings);

  return { settingsFile: file, hooksAdded, hooksRemoved, serverEnabled, gitignoreChanged: ignoreInGit(projectDir, GITIGNORE_ENTRY) };
}

export type RemoveResult = { settingsFile: string; hooksRemoved: string[]; serverDisabled: boolean; fileDeleted: boolean };

export function remove(projectDir: string): RemoveResult {
  const file = settingsPath(projectDir);
  const unchanged: RemoveResult = { settingsFile: file, hooksRemoved: [], serverDisabled: false, fileDeleted: false };
  if (!existsSync(file)) return unchanged;

  const settings = readJsonObject(file);
  const enabled = enabledServers(settings, file);
  const stray = removeStrayHooks(settings);
  const hooksRemoved = [...new Set([...stray, ...TMB_HOOKS.filter((hook) => removeHook(settings, hook)).map((hook) => hook.hookEvent)])];
  const serverDisabled = enabled.includes(SERVER_KEY);
  if (serverDisabled) {
    const remaining = enabled.filter((name) => name !== SERVER_KEY);
    if (remaining.length > 0) settings[ENABLED_SERVERS_KEY] = remaining;
    else delete settings[ENABLED_SERVERS_KEY];
  }
  if (hooksRemoved.length === 0 && !serverDisabled) return unchanged;

  if (Object.keys(settings).length === 0) {
    deleteFile(file, projectDir);
    return { settingsFile: file, hooksRemoved, serverDisabled, fileDeleted: true };
  }
  writeJsonObject(file, settings);
  return { settingsFile: file, hooksRemoved, serverDisabled, fileDeleted: false };
}

/** What `tmb doctor` finds wrong with tmb's hooks and tool server in the settings file: one line each, none when init would change nothing. Never writes. */
export function settingsGaps(projectDir: string, tmbCommand: readonly string[]): string[] {
  const file = settingsPath(projectDir);
  const shown = SETTINGS_RELATIVE;
  try {
    const settings = readJsonObject(file);
    const gaps: string[] = [];
    const hooks = isObject(settings.hooks) ? settings.hooks : {};
    const missing = TMB_HOOKS.filter((hook) => {
      const groups = Array.isArray(hooks[hook.hookEvent]) ? (hooks[hook.hookEvent] as unknown[]) : [];
      return !isWired(groups, hook, hookCommand(tmbCommand, hook.name));
    }).map((hook) => hook.hookEvent);
    if (missing.length > 0) gaps.push(`${shown} lacks tmb's current ${missing.join(", ")} hook${missing.length === 1 ? "" : "s"}`);
    const stray = removeStrayHooks(structuredClone(settings));
    if (stray.length > 0) gaps.push(`${shown} holds tmb hooks this version no longer wires under ${stray.join(", ")}`);
    if (!enabledServers(settings, file).includes(SERVER_KEY)) gaps.push(`${shown} does not enable the tmb tool server`);
    return gaps;
  } catch (error) {
    return [`${shown} cannot be read: ${error instanceof Error ? error.message : String(error)}`];
  }
}
