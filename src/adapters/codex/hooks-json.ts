// The project's .codex/hooks.json, where Codex finds project hooks. Its shape is Claude Code's:
// {"hooks": {Event: [{matcher?, hooks: [{type: "command", command}]}]}}. tmb adds one group per
// event it answers and never touches another hook.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ignoreInGit } from "../common/git.ts";
import { deleteFile, isObject, type JsonObject, readJsonObject, writeJsonObject } from "../common/json-file.ts";
import { CODEX_DIR, createdMarkerPath, HOST_ID, hooksJsonPath, originalHooksPath } from "./paths.ts";

/**
 * Each Codex hook tmb wires and the `tmb hook` name it runs. PreToolUse has no matcher, so every
 * tool call reaches tmb, which answers only the ones it guards: Codex's matcher syntax is not
 * documented, and a missed tool would be an unguarded one.
 */
export const TMB_HOOKS = [
  { hookEvent: "SessionStart", name: "session-start" },
  { hookEvent: "PreToolUse", name: "pre-tool-use" },
  { hookEvent: "SubagentStop", name: "subagent-stop" },
  { hookEvent: "SessionEnd", name: "session-end" },
] as const;

export type HookName = (typeof TMB_HOOKS)[number]["name"];

/**
 * The hooks an earlier version wired and this one no longer does. tmb still knows them as its own,
 * so init and remove take them out; a hook that moves to another event needs no entry here.
 */
export const RETIRED_HOOK_NAMES: readonly string[] = [];

const HOOK_NAMES = [...TMB_HOOKS.map((hook) => hook.name), ...RETIRED_HOOK_NAMES].join("|");
// tmb's hook: its quoted command (the executable, and the entry file when run from source), then the hook and the host.
const TMB_HOOK_COMMAND = new RegExp(String.raw`^(?:"[^"]*"\s+){1,2}hook\s+(${HOOK_NAMES})\s+--host\s+${HOST_ID}$`);

export function hookCommand(tmbCommand: readonly string[], name: HookName): string {
  return `${tmbCommand.map((part) => `"${part}"`).join(" ")} hook ${name} --host ${HOST_ID}`;
}

/** Whether the command is a tmb hook for Codex, and for the named hook when given. */
export function isTmbHookCommand(command: unknown, name?: HookName): boolean {
  if (typeof command !== "string") return false;
  const match = TMB_HOOK_COMMAND.exec(command.trim());
  return match !== null && (name === undefined || match[1] === name);
}

type Group = JsonObject & { hooks?: unknown };

function hooksOf(config: JsonObject, file: string): JsonObject {
  if (config.hooks === undefined) return {};
  if (!isObject(config.hooks)) throw new Error(`hooks in ${file} is not an object`);
  return config.hooks;
}

function groupsOf(hooks: JsonObject, event: string, file: string): Group[] {
  const groups = hooks[event];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new Error(`hooks.${event} in ${file} is not a list`);
  return groups as Group[];
}

/** The groups with every tmb hook taken out, and a group left empty by that dropped. */
function withoutTmb(groups: Group[]): Group[] {
  return groups.flatMap((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    const kept = group.hooks.filter((hook) => !(isObject(hook) && isTmbHookCommand(hook.command)));
    if (kept.length === group.hooks.length) return [group];
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
  });
}

/** The Human's part of a hooks config: every tmb hook out, and an emptied group, event or hooks key dropped. */
function humansPart(config: JsonObject, file: string): string {
  const hooks = hooksOf(config, file);
  const kept: JsonObject = {};
  for (const event of Object.keys(hooks)) {
    const groups = withoutTmb(groupsOf(hooks, event, file));
    if (groups.length > 0) kept[event] = groups;
  }
  const { hooks: _hooks, ...rest } = config;
  return JSON.stringify(Object.keys(kept).length > 0 ? { ...rest, hooks: kept } : rest);
}

export type InstallResult = { file: string; hooksAdded: string[]; hooksRemoved: string[]; created: boolean; gitignoreChanged: boolean };

export function installHooks(projectDir: string, tmbCommand: readonly string[]): InstallResult {
  const file = hooksJsonPath(projectDir);
  const created = !existsSync(file);
  const config = readJsonObject(file);
  const hooks = hooksOf(config, file);
  const hooksAdded: string[] = [];
  const hooksRemoved: string[] = [];
  for (const hook of TMB_HOOKS) {
    const groups = groupsOf(hooks, hook.hookEvent, file);
    const ours = { hooks: [{ type: "command", command: hookCommand(tmbCommand, hook.name) }] };
    const others = withoutTmb(groups);
    const wanted = [...others, ours];
    if (JSON.stringify(groups) === JSON.stringify(wanted)) continue;
    hooks[hook.hookEvent] = wanted;
    hooksAdded.push(hook.hookEvent);
  }
  // A tmb hook under an event no current hook uses is a retired one, or one an earlier version wired there.
  for (const event of Object.keys(hooks)) {
    if (TMB_HOOKS.some((hook) => hook.hookEvent === event)) continue;
    const groups = groupsOf(hooks, event, file);
    const kept = withoutTmb(groups);
    if (JSON.stringify(kept) === JSON.stringify(groups)) continue;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
    hooksRemoved.push(event);
  }
  if (hooksAdded.length > 0 || hooksRemoved.length > 0) {
    // Keep the Human's file as it was, the first time tmb changes it, so remove gives it back unchanged.
    const original = originalHooksPath(projectDir);
    if (!created && !existsSync(original)) writeJsonObject(original, { text: readFileSync(file, "utf8") });
    config.hooks = hooks;
    writeJsonObject(file, config);
    if (created) writeJsonObject(createdMarkerPath(projectDir, "hooks"), { created: path.join(CODEX_DIR, "hooks.json") });
  }
  // A hooks.json tmb made holds only a machine-specific path, so it stays out of git.
  const gitignoreChanged = existsSync(createdMarkerPath(projectDir, "hooks")) && ignoreInGit(projectDir, `${CODEX_DIR}/hooks.json`, path.join(CODEX_DIR, "hooks.json"));
  return { file, hooksAdded, hooksRemoved, created: created && hooksAdded.length > 0, gitignoreChanged };
}

export type RemoveResult = { file: string; hooksRemoved: string[]; fileDeleted: boolean };

function originalText(projectDir: string): string | null {
  const saved = readJsonObject(originalHooksPath(projectDir)).text;
  return typeof saved === "string" ? saved : null;
}

export function removeHooks(projectDir: string): RemoveResult {
  const file = hooksJsonPath(projectDir);
  const marker = createdMarkerPath(projectDir, "hooks");
  const tmbCreatedIt = existsSync(marker);
  const result: RemoveResult = { file, hooksRemoved: [], fileDeleted: false };
  if (existsSync(file)) {
    const config = readJsonObject(file);
    const hooks = hooksOf(config, file);
    for (const event of Object.keys(hooks)) {
      const groups = groupsOf(hooks, event, file);
      const kept = withoutTmb(groups);
      if (kept.length === groups.length && JSON.stringify(kept) === JSON.stringify(groups)) continue;
      result.hooksRemoved.push(event);
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (result.hooksRemoved.length > 0) {
      if (Object.keys(hooks).length === 0) delete config.hooks;
      else config.hooks = hooks;
      const original = originalText(projectDir);
      if (tmbCreatedIt && Object.keys(config).length === 0) {
        deleteFile(file, projectDir);
        result.fileDeleted = true;
      } else if (original !== null && humansPart(JSON.parse(original.trim() === "" ? "{}" : original), file) === humansPart(config, file)) {
        // Nothing of the Human's changed since init: their file comes back byte for byte.
        writeFileSync(file, original);
      } else {
        writeJsonObject(file, config);
      }
    }
  }
  if (tmbCreatedIt) deleteFile(marker, projectDir);
  if (existsSync(originalHooksPath(projectDir))) deleteFile(originalHooksPath(projectDir), projectDir);
  return result;
}

/** What `tmb doctor` finds wrong with tmb's hooks in .codex/hooks.json: one line each, none when init would change nothing. Never writes. */
export function hooksGaps(projectDir: string, tmbCommand: readonly string[]): string[] {
  const file = hooksJsonPath(projectDir);
  const shown = path.join(CODEX_DIR, "hooks.json");
  try {
    const hooks = hooksOf(readJsonObject(file), file);
    const gaps: string[] = [];
    const missing = TMB_HOOKS.filter((hook) => {
      const groups = groupsOf(hooks, hook.hookEvent, file);
      const ours = { hooks: [{ type: "command", command: hookCommand(tmbCommand, hook.name) }] };
      return JSON.stringify(groups) !== JSON.stringify([...withoutTmb(groups), ours]);
    }).map((hook) => hook.hookEvent);
    if (missing.length > 0) gaps.push(`${shown} lacks tmb's current ${missing.join(", ")} hook${missing.length === 1 ? "" : "s"}`);
    const stray = Object.keys(hooks).filter((event) => {
      if (TMB_HOOKS.some((hook) => hook.hookEvent === event)) return false;
      const groups = groupsOf(hooks, event, file);
      return JSON.stringify(withoutTmb(groups)) !== JSON.stringify(groups);
    });
    if (stray.length > 0) gaps.push(`${shown} holds tmb hooks this version no longer wires under ${stray.join(", ")}`);
    return gaps;
  } catch (error) {
    return [`${shown} cannot be read: ${error instanceof Error ? error.message : String(error)}`];
  }
}
