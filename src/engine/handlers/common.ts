// What the feature and task operations share: where they run, who may call them, and the
// states and branch names they use.
import type { FeedbackEnv } from "../feedback/index.ts";
import type { Actor, Role } from "../store/index.ts";
import { HandlerError } from "./errors.ts";

/** Where an operation runs: the project's folder, and how long each check may take. */
/** `unattended` is true when no one can answer in the run the call comes from. */
/** `feedback` is the feedback program's environment, given by the door that runs the planner's tools. */
export type OperationContext = { projectDir: string; checkTimeoutMs?: number; unattended?: boolean; feedback?: FeedbackEnv };

export const OPEN = "open";
export const CLOSED = "closed";
/** A truest task whose checks passed at its commit and that waits for the reviewer, or for its pull request once passed. */
export const IN_REVIEW = "in_review";
/** A task the planner or the Human ended without its work, with the reason (trustmybot/tmb#170). */
export const DROPPED = "dropped";
/** A feature branch whose pull request is open; it still takes fix tasks (trustmybot/tmb#168). */
export const PR_OPEN = "pr_open";
/** A feature branch whose pull request merged: final (trustmybot/tmb#131). */
export const MERGED = "merged";
/** A feature branch whose pull request closed without a merge; a task or a new pull request reopens it (trustmybot/tmb#152). */
export const CLOSED_UNMERGED = CLOSED;
/**
 * A feature branch, or a truest task, in a repo with no remote whose review passed or was waived:
 * nothing was pushed and no pull request opened; the Human merges it locally (trustmybot/tmb#183).
 * It moves on once the local base branch holds its tip: a feature to merged, a task to closed.
 */
export const READY = "ready";
/** The commands the Human runs, in `dir`, to merge `branch` into `base` locally. */
export function localMergeCommand(base: string, branch: string): string {
  return `git switch ${base} && git merge --no-ff ${branch}`;
}
/** A ready branch the Human will merge locally (trustmybot/tmb#183), with how to end it when tmb cannot see that merge (trustmybot/tmb#214). */
export type LocalMerge = { dir: string; command: string; otherwise: string };
/**
 * What to do with a ready branch tmb does not record merged: tmb sees a merge, a squash or a
 * rebase by hand, but not one after which the base changed the same lines again.
 */
export function endReadyLine(kind: "feature" | "task", name: string): string {
  return `If its work reached the base branch another way and tmb still shows it ready, the planner ends ${name} with ${kind}_drop, its reason saying where the work went`;
}
export const TRUEST = "truest";
/** Task branches live under this prefix, so no feature branch may take it. */
export const TASK_BRANCH_PREFIX = "tmb/";
