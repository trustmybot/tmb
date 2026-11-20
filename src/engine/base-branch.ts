// Suggests the base branch: the branch pull requests merge into.
import { spawnSync } from "node:child_process";

/** The fallback in a git work tree whose remote and current branch name none. */
export const FALLBACK_BASE_BRANCH = "main";

const ORIGIN_PREFIX = "refs/remotes/origin/";

/** A git command's trimmed output, or null when git is missing or the command fails. */
function gitOutput(projectDir: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) return null;
  const output = result.stdout.trim();
  return output === "" ? null : output;
}

/**
 * origin's default branch, else the current branch, else the fallback. Null outside a git
 * work tree, where there is nothing to suggest.
 */
export function detectBaseBranch(projectDir: string): string | null {
  if (gitOutput(projectDir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
  const originHead = gitOutput(projectDir, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (originHead?.startsWith(ORIGIN_PREFIX)) return originHead.slice(ORIGIN_PREFIX.length);
  return gitOutput(projectDir, ["symbolic-ref", "-q", "--short", "HEAD"]) ?? FALLBACK_BASE_BRANCH;
}

/** The base branch detectBaseBranch suggests, with where it came from; null outside a git work tree. */
export function detectBaseBranchWithEvidence(projectDir: string): { branch: string; from: string } | null {
  if (gitOutput(projectDir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
  const originHead = gitOutput(projectDir, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (originHead?.startsWith(ORIGIN_PREFIX)) return { branch: originHead.slice(ORIGIN_PREFIX.length), from: "origin's default branch" };
  const current = gitOutput(projectDir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  return current === null
    ? { branch: FALLBACK_BASE_BRANCH, from: "the fallback, as origin names no default branch and HEAD is detached" }
    : { branch: current, from: "the current branch, as origin names no default branch" };
}
