// Where a project's record lives: one database file inside the project's folder.
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { type OpenResult, openStore } from "./store/index.ts";

export const PROJECT_DIR_NAME = ".tmb";
const DB_FILE_NAME = "trajectory.db";

export function projectDbPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_DIR_NAME, DB_FILE_NAME);
}

function isFile(file: string): boolean {
  return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isDirectory(dir: string): boolean {
  return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// The project folder is checked first: stat throws ENOTDIR on a path through a file of that name.
function holdsRecord(dir: string): boolean {
  return isDirectory(path.join(dir, PROJECT_DIR_NAME)) && isFile(projectDbPath(dir));
}

/**
 * The project a folder belongs to: the nearest of it and its parents that holds a record,
 * so a session that moved into a subfolder still finds it. A stray project folder with no
 * database in it is passed over. With none found, the folder itself, which has no record.
 */
export function projectRootOf(start: string): string {
  const from = path.resolve(start);
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (holdsRecord(dir)) return dir;
    if (path.dirname(dir) === dir) return from;
  }
}

/** Opens the project's record; with `create`, makes the folder and the database when missing. */
export function openProjectStore(projectDir: string, options: { create: boolean }): OpenResult {
  const dbPath = projectDbPath(projectDir);
  if (options.create) mkdirSync(path.dirname(dbPath), { recursive: true });
  return openStore(dbPath, options);
}
