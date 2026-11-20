// What every adapter's setup does first, for tmb init: make the project's record through the engine, kept
// out of git, and the helpers its report lines share.
import { existsSync } from "node:fs";
import path from "node:path";
import { openProjectStore, PROJECT_DIR_NAME, projectDbPath } from "../../engine/index.ts";
import { ignoreInGit } from "./git.ts";

/** The file's path as the Human sees it from the project. */
export function shown(projectDir: string, file: string): string {
  return path.relative(projectDir, file) || file;
}

/** "A", "A and B", "A, B and C". */
export function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Creates the project's record through the engine, or keeps the one already there. */
export function setUpRecord(projectDir: string): string[] {
  const dbFile = shown(projectDir, projectDbPath(projectDir));
  const existed = existsSync(projectDbPath(projectDir));
  const opened = openProjectStore(projectDir, { create: true });
  if (!opened.ok) throw new Error(`cannot set up the record: ${opened.error.message}`);
  opened.store.close();
  const lines = [existed ? `${dbFile} already holds the record; kept it.` : `Created the record at ${dbFile}.`];
  if (ignoreInGit(projectDir, `${PROJECT_DIR_NAME}/`, path.join(PROJECT_DIR_NAME, "trajectory.db"))) {
    lines.push(`Added ${PROJECT_DIR_NAME}/ to .gitignore.`);
  }
  return lines;
}

/** The record's line after remove: it is the Human's data, so it stays. */
export function keptRecordLine(projectDir: string): string[] {
  const dbFile = projectDbPath(projectDir);
  return existsSync(dbFile) ? [`Kept the record at ${shown(projectDir, dbFile)}: it is your data; delete it yourself if you no longer want it.`] : [];
}
