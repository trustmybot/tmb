// The builds a program keeps beside its installed file, and the sessions that use them
// (trustmybot/tmb#159, #160). Each kept build lives in its own folder under the program's state
// folder, named by its version; each running session's entry names the build it started with. An
// old build stays until the Human says yes to deleting it in `tmb doctor --fix`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { version } from "../engine/index.ts";
import type { Updater } from "./updater.ts";

/** Where a program keeps its old builds, one folder per version. */
export const BUILDS_DIR = "builds";
/** Where a program keeps one entry per running session, named by its process id. */
export const SESSIONS_DIR = "sessions";

/** A session's entry: its process, its project, and the build it started with when it says. */
export type SessionEntry = { file: string; pid: number; project: string; startedAt: string | null; build: string | null };

/** A kept build: its version, its folder, its size and the running sessions that still use it. */
export type KeptBuild = { version: string; dir: string; bytes: number; usedBy: SessionEntry[] };

const VERSION_NAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function buildsDir(stateDir: string): string {
  return path.join(stateDir, BUILDS_DIR);
}

export function sessionsDir(stateDir: string): string {
  return path.join(stateDir, SESSIONS_DIR);
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Every session entry that can be read, alive or not. */
export function sessionEntries(stateDir: string): SessionEntry[] {
  const dir = sessionsDir(stateDir);
  const entries: SessionEntry[] = [];
  for (const name of readdirSafe(dir).filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(dir, name);
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof entry.pid !== "number" || typeof entry.project !== "string") continue;
      entries.push({
        file,
        pid: entry.pid,
        project: entry.project,
        startedAt: typeof entry.startedAt === "string" ? entry.startedAt : null,
        build: typeof entry.build === "string" ? entry.build : null,
      });
    } catch {
      // An entry being written, or one that is not tmb's: not a session to count.
    }
  }
  return entries;
}

/** The size of a file or folder, in bytes; what cannot be read counts as nothing. */
export function sizeOf(target: string): number {
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSafe(target).reduce((total, name) => total + sizeOf(path.join(target, name)), 0);
}

/** Every build kept on disk, oldest version name first, with the running sessions that use it. */
export function keptBuilds(stateDir: string, isRunning: (pid: number) => boolean): KeptBuild[] {
  const live = sessionEntries(stateDir).filter((entry) => isRunning(entry.pid));
  return readdirSafe(buildsDir(stateDir))
    .filter((name) => VERSION_NAME.test(name) && (statSync(path.join(buildsDir(stateDir), name), { throwIfNoEntry: false })?.isDirectory() ?? false))
    .map((version) => {
      const dir = path.join(buildsDir(stateDir), version);
      return { version, dir, bytes: sizeOf(dir), usedBy: live.filter((entry) => entry.build === version) };
    });
}

/** The kept builds no running session uses: what `tmb doctor --fix` offers to delete. */
export function removableBuilds(stateDir: string, isRunning: (pid: number) => boolean): KeptBuild[] {
  return keptBuilds(stateDir, isRunning).filter((build) => build.usedBy.length === 0);
}

/** A size as a person reads it: 512 B, 3.4 KB, 120 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Whether a process is alive; EPERM means it is, and belongs to someone else. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Builds kept for sessions that no running session uses any more, as one line; null when there are none. */
export function unusedBuildsLine(updater: Updater): string | null {
  const unused = updater.keptBuilds().filter((build) => build.usedBy.length === 0 && build.version !== version);
  if (unused.length === 0) return null;
  const size = formatBytes(unused.reduce((sum, build) => sum + build.bytes, 0));
  return `${unused.length} old ${updater.program.name} build${unused.length === 1 ? "" : "s"} (${size}) no running session uses can be removed with \`${updater.program.name} doctor --fix\`.`;
}
