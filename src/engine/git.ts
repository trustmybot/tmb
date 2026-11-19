// Runs git for the engine's own steps: cutting task branches, adding worktrees and reading
// a worktree's state. The engine runs these itself so no agent has to follow a git procedure.
import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 60_000;

/** A git command's outcome: its trimmed output, and on failure what git said. */
export type GitResult = { ok: boolean; stdout: string; stderr: string };

export function runGit(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/** What a failed git command said, in one line. */
export function gitFailure(result: GitResult): string {
  const said = (result.stderr || result.stdout).replace(/\s+/g, " ").trim();
  return said === "" ? "git failed without saying why" : said;
}
