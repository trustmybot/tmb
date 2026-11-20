// Runs git for the engine's own steps: cutting feature and task branches, adding worktrees,
// reading a worktree's state, folding a task into its feature branch and pushing it. The
// engine runs these itself so no agent has to follow a git procedure.
import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 60_000;

/** A git command's outcome: its trimmed output, and on failure what git said. */
export type GitResult = { ok: boolean; stdout: string; stderr: string; /** git's exit code; null when it did not run or was stopped. */ status?: number | null };

/** Runs git in `cwd`; `env` adds variables to the inherited environment. */
export function runGit(cwd: string, args: readonly string[], env?: Record<string, string>): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: env === undefined ? undefined : { ...process.env, ...env } });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message, status: null };
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

/** What a failed git command said, in one line. */
export function gitFailure(result: GitResult): string {
  const said = (result.stderr || result.stdout).replace(/\s+/g, " ").trim();
  return said === "" ? "git failed without saying why" : said;
}
