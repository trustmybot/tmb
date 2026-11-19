// Claude Code's per-user, per-project settings file: the Human's own, never shared. tmb adds
// its SessionStart hook and enables its tool server from the project's .mcp.json.
import { existsSync } from "node:fs";
import path from "node:path";
import { ignoreInGit } from "./git.ts";
import { deleteFile, isObject, type JsonObject, readJsonObject, writeJsonObject } from "./json-file.ts";
import { SERVER_KEY } from "./mcp-json.ts";

const SETTINGS_RELATIVE = path.join(".claude", "settings.local.json");
const GITIGNORE_ENTRY = ".claude/settings.local.json";
const ENABLED_SERVERS_KEY = "enabledMcpjsonServers";
const HOOK_ARGS = "hook session-start";
// The hook a compiled tmb writes: its quoted executable, named tmb, then the hook arguments.
const BINARY_HOOK_COMMAND = /^"(?:[^"]*[\\/])?tmb(?:[^"\\/]*)"\s+hook\s+session-start$/i;
// The hook a source run writes: quoted Bun, then tmb's src/cli.ts, quoted or not, then the arguments.
const SOURCE_HOOK_COMMAND = /^"[^"]*"\s+(?:"[^"]*[\\/]src[\\/]cli\.ts"|[^"\s]*[\\/]src[\\/]cli\.ts)\s+hook\s+session-start$/i;

type HookCommand = { type?: unknown; command?: unknown } & JsonObject;
type HookGroup = { hooks?: unknown } & JsonObject;

export function settingsPath(projectDir: string): string {
  return path.join(projectDir, SETTINGS_RELATIVE);
}

/** The hook's shell command: each part of the tmb command quoted, then the hook arguments. */
export function hookCommand(tmbCommand: readonly string[]): string {
  return `${tmbCommand.map((part) => `"${part}"`).join(" ")} ${HOOK_ARGS}`;
}

export function isTmbHookCommand(command: unknown): boolean {
  return typeof command === "string" && (BINARY_HOOK_COMMAND.test(command) || SOURCE_HOOK_COMMAND.test(command));
}

function isTmbHook(hook: unknown): boolean {
  return isTmbHookCommand((hook as HookCommand | null)?.command);
}

/** Removes tmb's session-start hooks from the groups, dropping groups left empty. */
function withoutTmbHooks(groups: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const group of groups) {
    const hooks = (group as HookGroup | null)?.hooks;
    if (!isObject(group) || !Array.isArray(hooks) || !hooks.some(isTmbHook)) {
      kept.push(group);
      continue;
    }
    const remaining = hooks.filter((hook) => !isTmbHook(hook));
    if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
  }
  return kept;
}

function enabledServers(settings: JsonObject, file: string): unknown[] {
  const enabled = settings[ENABLED_SERVERS_KEY];
  if (enabled === undefined) return [];
  if (!Array.isArray(enabled)) throw new Error(`${ENABLED_SERVERS_KEY} in ${file} is not a list`);
  return enabled;
}

/** Adds the hook unless it is there already; a tmb hook pointing at another tmb is stale and replaced. */
function addHook(settings: JsonObject, command: string): boolean {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const alreadyWired = sessionStart.some((group) => {
    const groupHooks = (group as HookGroup | null)?.hooks;
    return Array.isArray(groupHooks) && groupHooks.some((hook) => (hook as HookCommand | null)?.command === command);
  });
  if (alreadyWired) return false;
  const groups = withoutTmbHooks(sessionStart);
  groups.push({ hooks: [{ type: "command", command }] });
  settings.hooks = { ...hooks, SessionStart: groups };
  return true;
}

function removeHook(settings: JsonObject): boolean {
  const hooks = settings.hooks;
  const sessionStart = isObject(hooks) ? hooks.SessionStart : undefined;
  if (!isObject(hooks) || !Array.isArray(sessionStart)) return false;
  const groups = withoutTmbHooks(sessionStart);
  if (groups.length === sessionStart.length && groups.every((group, i) => group === sessionStart[i])) return false;
  if (groups.length > 0) hooks.SessionStart = groups;
  else delete hooks.SessionStart;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return true;
}

export type SetupResult = { settingsFile: string; hookAdded: boolean; serverEnabled: boolean; gitignoreChanged: boolean };

export function install(projectDir: string, tmbCommand: readonly string[]): SetupResult {
  const file = settingsPath(projectDir);
  const settings = readJsonObject(file);
  const enabled = enabledServers(settings, file);

  const hookAdded = addHook(settings, hookCommand(tmbCommand));
  const serverEnabled = !enabled.includes(SERVER_KEY);
  if (serverEnabled) settings[ENABLED_SERVERS_KEY] = [...enabled, SERVER_KEY];
  if (hookAdded || serverEnabled) writeJsonObject(file, settings);

  return { settingsFile: file, hookAdded, serverEnabled, gitignoreChanged: ignoreInGit(projectDir, GITIGNORE_ENTRY) };
}

export type RemoveResult = { settingsFile: string; hookRemoved: boolean; serverDisabled: boolean; fileDeleted: boolean };

export function remove(projectDir: string): RemoveResult {
  const file = settingsPath(projectDir);
  const unchanged = { settingsFile: file, hookRemoved: false, serverDisabled: false, fileDeleted: false };
  if (!existsSync(file)) return unchanged;

  const settings = readJsonObject(file);
  const enabled = enabledServers(settings, file);
  const hookRemoved = removeHook(settings);
  const serverDisabled = enabled.includes(SERVER_KEY);
  if (serverDisabled) {
    const remaining = enabled.filter((name) => name !== SERVER_KEY);
    if (remaining.length > 0) settings[ENABLED_SERVERS_KEY] = remaining;
    else delete settings[ENABLED_SERVERS_KEY];
  }
  if (!hookRemoved && !serverDisabled) return unchanged;

  if (Object.keys(settings).length === 0) {
    deleteFile(file, projectDir);
    return { settingsFile: file, hookRemoved, serverDisabled, fileDeleted: true };
  }
  writeJsonObject(file, settings);
  return { settingsFile: file, hookRemoved, serverDisabled, fileDeleted: false };
}
