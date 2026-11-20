// The git steps of a fold: bring a closing task onto its feature branch's tip, move the feature
// branch to the task's commit without losing a concurrent fold, clean up the task's branch and
// worktree, and push the feature branch to origin as a backup.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { gitFailure, runGit } from "../git.ts";
import type { Task } from "../store/index.ts";
import { DROPPED, TRUEST } from "./common.ts";
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

/** What cleaning up a closed task's checkout did: what it kept and why, and what it dropped. */
export type CheckoutCleanup = {
  /** What could not be removed and why, one line each; the task stays closed. */
  problems: string[];
  /** Files git ignores that went with a removed worktree, one line; empty when none did. */
  dropped: string[];
};

const FILES_NAMED = 5;

/** The files a worktree holds besides its commit, from `git status`, by what git makes of them. */
type WorktreeFiles = { changed: string[]; untracked: string[]; ignored: string[] };

function worktreeFiles(worktree: string): WorktreeFiles | null {
  // Version 2 starts every line with its kind, so trimming the output loses nothing.
  const status = runGit(worktree, ["status", "--porcelain=v2", "--ignored"]);
  if (!status.ok) return null;
  const files: WorktreeFiles = { changed: [], untracked: [], ignored: [] };
  for (const line of status.stdout.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(" ");
    if (line.startsWith("? ")) files.untracked.push(line.slice(2));
    else if (line.startsWith("! ")) files.ignored.push(line.slice(2));
    else if (line.startsWith("1 ")) files.changed.push(fields.slice(8).join(" "));
    else if (line.startsWith("2 ")) files.changed.push(fields.slice(9).join(" ").split("\t")[0]!);
    else if (line.startsWith("u ")) files.changed.push(fields.slice(10).join(" "));
  }
  return files;
}

function named(files: string[]): string {
  const more = files.length > FILES_NAMED ? ` and ${files.length - FILES_NAMED} more` : "";
  return `${files.slice(0, FILES_NAMED).join(", ")}${more}`;
}

function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** The worktrees git lists for the repository at `projectDir`, by real path, with whether the host locked each. */
export function listedWorktrees(projectDir: string): Map<string, { locked: boolean }> {
  const listed = new Map<string, { locked: boolean }>();
  const result = runGit(projectDir, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return listed;
  let current: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = realPath(line.slice("worktree ".length));
      listed.set(current, { locked: false });
    } else if (current !== null && (line === "locked" || line.startsWith("locked "))) {
      listed.get(current)!.locked = true;
    }
  }
  return listed;
}

/** Why the worktree stays, or how to remove it: with `force` when files git ignores are left in it. */
function keepOrRemove(projectDir: string, worktree: string, branch: string | null): { kept: string } | { force: boolean; ignored: string[] } {
  if (realPath(worktree) === realPath(projectDir)) return { kept: `the worktree ${worktree} is the project's main folder, which tmb never removes` };
  const listed = listedWorktrees(projectDir).get(realPath(worktree));
  if (listed === undefined) return { force: false, ignored: [] };
  const withBranch = branch === null ? "" : ` and the branch ${branch}`;
  if (listed.locked) return { kept: `the worktree ${worktree}${withBranch} were kept: the host locked the worktree, so it may still be in use; tmb tries again at a session start with no task open` };
  const files = worktreeFiles(worktree);
  if (files === null) return { force: false, ignored: [] };
  if (files.changed.length > 0) return { kept: `the worktree ${worktree}${withBranch} were kept: it has changes that are not committed: ${named(files.changed)}` };
  if (files.untracked.length > 0) {
    const command = `git worktree remove --force ${worktree}${branch === null ? "" : ` && git branch -D ${branch}`}`;
    return {
      kept: `the worktree ${worktree}${withBranch} were kept: it holds files git does not ignore, which may be work nobody committed: ${named(files.untracked)}. Commit or ignore them, or remove the worktree with: ${command}`,
    };
  }
  return { force: files.ignored.length > 0, ignored: files.ignored };
}

/**
 * Removes a closed task's worktree, then its branch unless `branch` is null (a truest task's branch
 * stays for its pull request). Keeps both when the worktree has uncommitted changes, holds files git
 * does not ignore, or its host locked it; drops files git ignores with the worktree and names them.
 */
export function removeTaskCheckout(projectDir: string, worktree: string, branch: string | null): CheckoutCleanup {
  const problems: string[] = [];
  const dropped: string[] = [];
  const decision = keepOrRemove(projectDir, worktree, branch);
  if ("kept" in decision) return { problems: [decision.kept], dropped };
  if (existsSync(worktree) || listedWorktrees(projectDir).has(realPath(worktree))) {
    const removed = runGit(projectDir, ["worktree", "remove", ...(decision.force ? ["--force"] : []), worktree]);
    if (!removed.ok) {
      const withBranch = branch === null ? "" : `; the branch ${branch} was kept with it`;
      return { problems: [`the worktree ${worktree} was not removed: ${gitFailure(removed)}${withBranch}`], dropped };
    }
    if (decision.ignored.length > 0) dropped.push(`Removed the worktree ${worktree} with the files git ignores in it: ${named(decision.ignored)}`);
  } else {
    // The folder is gone already: forget it, so the branch is free to delete.
    runGit(projectDir, ["worktree", "prune"]);
  }
  if (branch !== null && runGit(projectDir, ["rev-parse", "--verify", "--quiet", branchRef(branch)]).ok) {
    const deleted = runGit(projectDir, ["branch", "-D", branch]);
    if (!deleted.ok) problems.push(`the branch ${branch} was not deleted: ${gitFailure(deleted)}`);
  }
  return { problems, dropped };
}

/**
 * Tries again to remove what closed tasks kept: each worktree git still lists, and each agile task's
 * branch still here. Run at a session start with no task open; returns what it removed, one line each.
 */
export function retryKeptCheckouts(projectDir: string, tasks: readonly Task[]): string[] {
  const removed: string[] = [];
  for (const { task, worktree, branch } of keptCheckouts(projectDir, tasks)) {
    const cleanup = removeTaskCheckout(projectDir, worktree, branch);
    if (cleanup.problems.length === 0) removed.push(`task ${task.id}: ${[worktree, branch].filter((part) => part !== null).join(" and ")}`);
  }
  return removed;
}

/**
 * What closed tasks left on disk: each worktree git still lists, and each agile task's branch still
 * here, with the worktree to remove and the branch to delete (null for a truest task's, which stays
 * for its pull request). Reads only.
 */
export function keptCheckouts(projectDir: string, tasks: readonly Task[]): { task: Task; worktree: string; branch: string | null; listed: boolean }[] {
  const listed = listedWorktrees(projectDir);
  const refs = runGit(projectDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const branches = new Set(refs.ok ? refs.stdout.split("\n") : []);
  const kept: { task: Task; worktree: string; branch: string | null; listed: boolean }[] = [];
  for (const task of tasks) {
    if (task.worktree === null) continue;
    // A truest task's branch stays for its pull request, and a dropped task's while it holds commits; only the worktree goes.
    const keepBranch = task.state === DROPPED ? branchHoldsWork(projectDir, task) : task.reviewMode === TRUEST;
    const branch = keepBranch || task.branch === null || !branches.has(task.branch) ? null : task.branch;
    const isListed = listed.has(realPath(task.worktree));
    if (!isListed && branch === null) continue;
    kept.push({ task, worktree: task.worktree, branch, listed: isListed });
  }
  return kept;
}

/**
 * Whether a task's branch holds commits past the commit it was cut from: a dropped task's work,
 * which tmb keeps on its branch. A branch whose base tmb cannot tell is kept too.
 */
export function branchHoldsWork(projectDir: string, task: Task): boolean {
  if (task.branch === null) return false;
  const ref = branchRef(task.branch);
  if (!runGit(projectDir, ["rev-parse", "--verify", "--quiet", ref]).ok) return false;
  if (task.baseCommit === null) return true;
  const ahead = runGit(projectDir, ["rev-list", "--count", `${task.baseCommit}..${ref}`]);
  return !ahead.ok || ahead.stdout !== "0";
}

/** Pushes a branch (a feature branch as a backup, or a truest task's branch) to origin, never forced; with no origin, skips. */
export function pushFeature(projectDir: string, featureName: string): PushOutcome {
  if (!runGit(projectDir, ["remote", "get-url", ORIGIN]).ok) return { result: "skipped", detail: `the repository has no remote named ${ORIGIN}` };
  const ref = branchRef(featureName);
  // No terminal prompt: a push that needs credentials fails and says so instead of waiting.
  const pushed = runGit(projectDir, ["push", "--quiet", ORIGIN, `${ref}:${ref}`], { GIT_TERMINAL_PROMPT: "0" });
  return pushed.ok ? { result: "pushed", detail: `pushed ${featureName} to ${ORIGIN}` } : { result: "failed", detail: gitFailure(pushed) };
}
