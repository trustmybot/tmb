// The git steps of a fold: bring a closing task onto its feature branch's tip, move the feature
// branch to the task's commit without losing a concurrent fold, clean up the task's branch and
// worktree, and push the feature branch to origin as a backup.
import { gitFailure, runGit } from "../git.ts";
import { pushActorEnv } from "../push-actor.ts";
import type { Actor } from "../store/index.ts";
import { HandlerError } from "./errors.ts";

export const PUSH_RESULTS = ["pushed", "failed", "skipped"] as const;
export type PushResult = (typeof PUSH_RESULTS)[number];
export type PushOutcome = { result: PushResult; detail: string };

const ORIGIN = "origin";

export function branchRef(name: string): string {
  return `refs/heads/${name}`;
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

/**
 * Rebases the branch checked out in `worktree` onto `tip` of `featureName` (named in refusals as `what`) and returns the rebased HEAD. On a
 * conflict or any other failure the rebase is aborted, so the worktree is as it was, and the
 * refusal names the conflicting paths or what git said.
 */
export function rebaseOnto(worktree: string, featureName: string, tip: string, taskId: string, what = `the feature branch ${featureName}`): string {
  const rebased = runGit(worktree, ["rebase", "--quiet", tip], { GIT_EDITOR: "true" });
  if (!rebased.ok) {
    const conflicted = runGit(worktree, ["diff", "--name-only", "--diff-filter=U"]).stdout;
    runGit(worktree, ["rebase", "--abort"]);
    const undone = `The rebase was undone, so the worktree is as it was, and task ${taskId} stays open.`;
    if (conflicted !== "") {
      throw new HandlerError(
        "refused",
        `rebasing the task onto ${what} at ${tip} conflicts in:\n${conflicted}\n${undone} Bring ${featureName} into the worktree (git rebase ${featureName}), resolve the conflicts, commit, then close again.`,
      );
    }
    throw new HandlerError("refused", `git could not rebase the task onto ${what} at ${tip}: ${gitFailure(rebased)}. ${undone}`);
  }
  const head = runGit(worktree, ["rev-parse", "HEAD"]);
  if (!head.ok) throw new HandlerError("refused", `git could not read the rebased commit in ${worktree}: ${gitFailure(head)}`);
  return head.stdout;
}

/**
 * Puts the worktree's branch back at `original` after a rebase to `rebased`, so a refused close
 * leaves the worktree as it was. Touches nothing when HEAD moved past `rebased` since, and
 * returns a note saying so.
 */
export function undoRebase(worktree: string, rebased: string, original: string): string | null {
  if (rebased === original) return null;
  const head = runGit(worktree, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout !== rebased) return `The worktree's HEAD moved after the rebase, so it was left at ${head.stdout || "an unreadable commit"}.`;
  const reset = runGit(worktree, ["reset", "--quiet", "--keep", original]);
  return reset.ok ? null : `The worktree could not be put back at ${original}: ${gitFailure(reset)}.`;
}

/** The worktree that has `ref` checked out, or null when none has. */
function checkoutOf(projectDir: string, ref: string): string | null {
  const listed = runGit(projectDir, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new HandlerError("refused", `git could not list the worktrees: ${gitFailure(listed)}`);
  let current: string | null = null;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch ${ref}` && current !== null) return current;
  }
  return null;
}

/**
 * Moves the feature branch from `from` to `to`, refusing when it is no longer at `from`, so a
 * concurrent fold is never lost. A checkout of the branch is fast-forwarded in place when clean
 * and refused when dirty, so no checkout is left out of sync. Returns the step that undoes it.
 */
export function moveFeature(projectDir: string, featureName: string, from: string, to: string, why: string): () => void {
  const ref = branchRef(featureName);
  const moved = `the feature branch ${featureName} moved from ${from} while the task closed; close again to fold onto its new tip`;
  const holder = checkoutOf(projectDir, ref);
  if (holder === null) {
    const updated = runGit(projectDir, ["update-ref", "-m", why, ref, to, from]);
    if (!updated.ok) throw new HandlerError("refused", `${moved} (${gitFailure(updated)})`);
    return () => void runGit(projectDir, ["update-ref", "-m", `${why}, undone`, ref, from, to]);
  }

  const status = runGit(holder, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok) throw new HandlerError("refused", `git could not read the checkout of ${featureName} at ${holder}: ${gitFailure(status)}`);
  if (status.stdout !== "") {
    throw new HandlerError(
      "refused",
      `the feature branch ${featureName} is checked out at ${holder} with changes that are not committed, and folding would leave that checkout out of sync; commit or remove them there, then close again`,
    );
  }
  const at = runGit(holder, ["rev-parse", "HEAD"]);
  if (!at.ok || at.stdout !== from) throw new HandlerError("refused", moved);
  const merged = runGit(holder, ["merge", "--ff-only", "--quiet", to]);
  if (!merged.ok) throw new HandlerError("refused", `git could not fast-forward the checkout of ${featureName} at ${holder}: ${gitFailure(merged)}`);
  return () => void runGit(holder, ["reset", "--quiet", "--keep", from]);
}

/** Removes a closed task's worktree and branch; returns what could not be removed. */
export function removeTaskCheckout(projectDir: string, worktree: string, branch: string): string[] {
  const problems: string[] = [];
  const removed = runGit(projectDir, ["worktree", "remove", worktree]);
  if (!removed.ok) problems.push(`the worktree ${worktree} was not removed: ${gitFailure(removed)}`);
  const deleted = runGit(projectDir, ["branch", "-D", branch]);
  if (!deleted.ok) problems.push(`the branch ${branch} was not deleted: ${gitFailure(deleted)}`);
  return problems;
}

/**
 * Pushes a branch (a feature branch as a backup, or a truest task's branch) to origin, never forced; with no origin, skips.
 * The push names `actor` to git's pre-push hook, so the push gate records it as theirs.
 */
export function pushFeature(projectDir: string, featureName: string, actor: Actor): PushOutcome {
  if (!runGit(projectDir, ["remote", "get-url", ORIGIN]).ok) return { result: "skipped", detail: `the repository has no remote named ${ORIGIN}` };
  const ref = branchRef(featureName);
  // No terminal prompt: a push that needs credentials fails and says so instead of waiting.
  const pushed = runGit(projectDir, ["push", "--quiet", ORIGIN, `${ref}:${ref}`], { GIT_TERMINAL_PROMPT: "0", ...pushActorEnv(actor) });
  return pushed.ok ? { result: "pushed", detail: `pushed ${featureName} to ${ORIGIN}` } : { result: "failed", detail: gitFailure(pushed) };
}
