import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Claude Code's per-user, per-project settings file: the Human's own, never shared.
const SETTINGS_RELATIVE = path.join(".claude", "settings.local.json");
const GITIGNORE_ENTRY = ".claude/settings.local.json";
const HOOK_ARGS = "hook session-start";
// The quoted path of a tmb executable followed by the session-start hook arguments.
const TMB_HOOK_COMMAND = /^"(?:[^"]*[\\/])?tmb(?:[^"\\/]*)"\s+hook\s+session-start$/i;

type JsonObject = Record<string, unknown>;
type HookCommand = { type?: unknown; command?: unknown } & JsonObject;
type HookGroup = { hooks?: unknown } & JsonObject;

export function settingsPath(projectDir: string): string {
  return path.join(projectDir, SETTINGS_RELATIVE);
}

export function hookCommand(executablePath: string): string {
  return `"${executablePath}" ${HOOK_ARGS}`;
}

function isTmbHook(hook: unknown): boolean {
  const command = (hook as HookCommand | null)?.command;
  return typeof command === "string" && TMB_HOOK_COMMAND.test(command);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(file: string): JsonObject {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error(`${file} does not hold a JSON object`);
  return parsed;
}

function writeSettings(file: string, settings: JsonObject): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
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

export type SetupResult = { settingsFile: string; settingsChanged: boolean; gitignoreChanged: boolean };

export function install(projectDir: string, executablePath: string): SetupResult {
  const file = settingsPath(projectDir);
  const settings = readSettings(file);
  const command = hookCommand(executablePath);

  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const alreadyWired = sessionStart.some((group) => {
    const groupHooks = (group as HookGroup | null)?.hooks;
    return Array.isArray(groupHooks) && groupHooks.some((hook) => (hook as HookCommand | null)?.command === command);
  });

  let settingsChanged = false;
  if (!alreadyWired) {
    // A tmb hook pointing at another executable path is stale: replace it.
    const groups = withoutTmbHooks(sessionStart);
    groups.push({ hooks: [{ type: "command", command }] });
    settings.hooks = { ...hooks, SessionStart: groups };
    writeSettings(file, settings);
    settingsChanged = true;
  }

  return { settingsFile: file, settingsChanged, gitignoreChanged: ignoreSettingsFile(projectDir) };
}

export type RemoveResult = { settingsFile: string; settingsChanged: boolean; fileDeleted: boolean };

export function remove(projectDir: string): RemoveResult {
  const file = settingsPath(projectDir);
  const unchanged = { settingsFile: file, settingsChanged: false, fileDeleted: false };
  if (!existsSync(file)) return unchanged;

  const settings = readSettings(file);
  const hooks = settings.hooks;
  const sessionStart = isObject(hooks) ? hooks.SessionStart : undefined;
  if (!isObject(hooks) || !Array.isArray(sessionStart)) return unchanged;

  const groups = withoutTmbHooks(sessionStart);
  if (groups.length === sessionStart.length && groups.every((group, i) => group === sessionStart[i])) {
    return unchanged;
  }

  if (groups.length > 0) hooks.SessionStart = groups;
  else delete hooks.SessionStart;
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  if (Object.keys(settings).length === 0) {
    rmSync(file);
    const dir = path.dirname(file);
    if (readdirSync(dir).length === 0) rmdirSync(dir);
    return { settingsFile: file, settingsChanged: true, fileDeleted: true };
  }
  writeSettings(file, settings);
  return { settingsFile: file, settingsChanged: true, fileDeleted: false };
}

function git(projectDir: string, args: string[]): number | null {
  const result = spawnSync("git", args, { cwd: projectDir, stdio: "ignore", timeout: 10_000 });
  return result.error ? null : result.status;
}

/** Appends the settings file to .gitignore when the project is a git work tree that does not ignore it yet. */
function ignoreSettingsFile(projectDir: string): boolean {
  if (git(projectDir, ["rev-parse", "--is-inside-work-tree"]) !== 0) return false;
  // check-ignore exits 0 when the path is ignored, 1 when it is not.
  if (git(projectDir, ["check-ignore", "-q", "--no-index", GITIGNORE_ENTRY]) !== 1) return false;

  const gitignore = path.join(projectDir, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(gitignore, `${separator}${GITIGNORE_ENTRY}\n`);
  return true;
}
