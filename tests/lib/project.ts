// Projects the tests build: files written into a folder and committed as the test author.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "./git.ts";

/** The `.gitignore` line that keeps tmb's record out of git, as `tmb init` writes it. */
export const RECORD_IGNORE = ".tmb/\n";

/** Writes each file under `dir`, making its folders. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

/** Writes the files, commits everything in `dir` and returns the new commit. */
export function commitFiles(dir: string, files: Record<string, string>, message = "first"): string {
  writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** A new repo in `dir` on `branch`, with the files as its first commit; returns that commit. */
export function gitRepo(dir: string, files: Record<string, string>, branch = "main"): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  return commitFiles(dir, files);
}
