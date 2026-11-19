// Where a project's record lives: one database file inside the project's folder.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type OpenResult, openStore } from "./store/index.ts";

export const PROJECT_DIR_NAME = ".tmb";
const DB_FILE_NAME = "trajectory.db";

export function projectDbPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_DIR_NAME, DB_FILE_NAME);
}

/** Opens the project's record; with `create`, makes the folder and the database when missing. */
export function openProjectStore(projectDir: string, options: { create: boolean }): OpenResult {
  const dbPath = projectDbPath(projectDir);
  if (options.create) mkdirSync(path.dirname(dbPath), { recursive: true });
  return openStore(dbPath, options);
}
