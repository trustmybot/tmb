// The project's shared folders, as Claude Code links them into every worktree it makes, a
// subagent's included: tmb's entries in the settings' worktree links list, beside the Human's own.
// A marker file records which entries tmb added, so tmb changes and removes only those.
import { existsSync } from "node:fs";
import path from "node:path";
import { deleteFile, isObject, type JsonObject, readJsonObject, writeJsonObject } from "../common/json-file.ts";
import { FILES, SYMLINK_DIRECTORIES_KEY, WORKTREE_KEY } from "./host.ts";

const SETTING = `${WORKTREE_KEY}.${SYMLINK_DIRECTORIES_KEY}`;

function strings(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${what} is not a list of folders`);
  return value as string[];
}

export class WorktreeLinks {
  private settingsPath(projectDir: string): string {
    return path.join(projectDir, FILES.settings);
  }

  private markerPath(projectDir: string): string {
    return path.join(projectDir, FILES.sharedFoldersMarker);
  }

  /** The entries tmb added, as its marker records them. */
  private ours(projectDir: string): string[] {
    return strings(readJsonObject(this.markerPath(projectDir)).folders, FILES.sharedFoldersMarker);
  }

  private listed(settings: JsonObject): string[] {
    const worktree = settings[WORKTREE_KEY];
    if (worktree === undefined) return [];
    if (!isObject(worktree)) throw new Error(`${WORKTREE_KEY} in ${FILES.settings} is not an object`);
    return strings(worktree[SYMLINK_DIRECTORIES_KEY], `${SETTING} in ${FILES.settings}`);
  }

  /**
   * Makes the settings list `folders` among the worktree links, keeping the Human's own entries,
   * and takes away tmb's entries the list no longer names; an empty list takes all of tmb's away.
   * Returns what changed, one line each.
   */
  set(projectDir: string, folders: readonly string[]): string[] {
    const file = this.settingsPath(projectDir);
    if (!existsSync(file) && folders.length === 0) return [];
    const settings = readJsonObject(file);
    const before = this.listed(settings);
    const ours = this.ours(projectDir);
    const human = before.filter((entry) => !ours.includes(entry));
    const added = folders.filter((folder) => !human.includes(folder));
    const after = [...human, ...added];
    const changed = after.length !== before.length || after.some((entry, i) => entry !== before[i]);
    if (changed) {
      const worktree: JsonObject = isObject(settings[WORKTREE_KEY]) ? { ...settings[WORKTREE_KEY] } : {};
      if (after.length > 0) worktree[SYMLINK_DIRECTORIES_KEY] = after;
      else delete worktree[SYMLINK_DIRECTORIES_KEY];
      if (Object.keys(worktree).length > 0) settings[WORKTREE_KEY] = worktree;
      else delete settings[WORKTREE_KEY];
      if (Object.keys(settings).length === 0) deleteFile(file, projectDir);
      else writeJsonObject(file, settings);
    }
    const marker = this.markerPath(projectDir);
    if (added.length > 0) writeJsonObject(marker, { folders: added });
    else if (existsSync(marker)) deleteFile(marker, projectDir);
    if (!changed) return [];
    return [added.length === 0 ? `Removed tmb's shared folders from ${SETTING} in ${FILES.settings}.` : `Set tmb's shared folders in ${SETTING} in ${FILES.settings}: ${added.join(", ")}.`];
  }

  /** What `tmb doctor` finds missing: one line when the settings do not link every shared folder. Never writes. */
  gaps(projectDir: string, folders: readonly string[]): string[] {
    if (folders.length === 0) return [];
    try {
      const listed = this.listed(readJsonObject(this.settingsPath(projectDir)));
      const missing = folders.filter((folder) => !listed.includes(folder));
      return missing.length === 0 ? [] : [`${FILES.settings} does not link the shared folder${missing.length === 1 ? "" : "s"} ${missing.join(", ")} in ${SETTING}`];
    } catch (error) {
      return [`${FILES.settings} cannot be read: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
}
