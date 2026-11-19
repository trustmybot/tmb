import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

function git(projectDir: string, args: string[]): number | null {
  const result = spawnSync("git", args, { cwd: projectDir, stdio: "ignore", timeout: 10_000 });
  return result.error ? null : result.status;
}

/**
 * Appends `entry` to .gitignore when the project is a git work tree that does not ignore
 * `probe` yet (`probe` is a file the entry covers, as check-ignore tests paths, not patterns).
 */
export function ignoreInGit(projectDir: string, entry: string, probe: string = entry): boolean {
  if (git(projectDir, ["rev-parse", "--is-inside-work-tree"]) !== 0) return false;
  // check-ignore exits 0 when the path is ignored, 1 when it is not.
  if (git(projectDir, ["check-ignore", "-q", "--no-index", probe]) !== 1) return false;

  const gitignore = path.join(projectDir, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(gitignore, `${separator}${entry}\n`);
  return true;
}
