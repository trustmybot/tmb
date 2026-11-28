// The mark on GitHub: when tmb records a review's verdict or a Human waiver, it sets a commit
// status on that exact commit, so the repo's own branch protection can require it before a merge.
// A mark that could not be sent is recorded as not sent and sent at the next occasion (a review,
// a waiver or a pull request); it never fails the review. Only the newest mark of a commit is
// ever sent, so an old one never overwrites a newer verdict. tmb only reads branch protection.
import { githubRepoOf, requiresStatusCheck, setCommitStatus } from "../github.ts";
import type { Actor, ReviewMark, Store } from "../store/index.ts";

/** The status check's name, the one the Human requires in the base branch's protection. */
export const MARK_CONTEXT = "tmb/review";
export type MarkKind = "pass" | "fail" | "waiver";
export type MarkState = "success" | "failure";
/** What a mark is for: one task's commit, or a feature branch's. */
export type MarkParent = { taskId: string } | { featureId: string };

/** What became of a mark: set on GitHub or not, or skipped because origin is no GitHub repository. */
export type MarkResult = { commit: string; state: MarkState; description: string; sent: boolean; why?: string } | { skipped: string };

const NOT_GITHUB = "origin is not a GitHub repository";

function blockingCount(count: number): string {
  return `${count} blocking finding${count === 1 ? "" : "s"}`;
}

/** Who waived a review, as a mark or a pull request names them: the Human, or the role that waived it. */
export function waivedBy(by: Actor): string {
  if (by.kind === "human") return "the Human";
  return by.kind === "agent" ? `the ${by.role}` : "tmb";
}

/** The pull request's line for a review waived at `commit`, naming who waived it. */
export function waivedLine(commit: string, waiver: { reason: string; by: Actor } | undefined): string {
  return `Review waived by ${waiver === undefined ? "the Human" : waivedBy(waiver.by)} at ${commit}: ${waiver?.reason ?? ""}`;
}

/** The mark's state and text for a verdict or a waiver. */
function markOf(kind: MarkKind, reason: string | number | undefined, by: Actor): { state: MarkState; description: string } {
  if (kind === "pass") return { state: "success", description: "Passed tmb's review" };
  if (kind === "fail") return { state: "failure", description: `Failed tmb's review: ${blockingCount(typeof reason === "number" ? reason : 0)}` };
  return { state: "success", description: `Passed: review waived by ${waivedBy(by)}: ${String(reason ?? "").trim()}` };
}

/**
 * Sets the mark for a verdict or a waiver on `commit` of `parent` and records it. `detail` is the
 * number of blocking findings for a fail and the reason for a waiver. Never throws: a mark that
 * could not be sent is recorded as such and sent at the next occasion. `waiver` is who waived the
 * review when it is not `actor`, as for a waiver carried over a rebase.
 */
export function markReviewed(store: Store, actor: Actor, projectDir: string, parent: MarkParent, commit: string, kind: MarkKind, detail?: string | number, waiver?: Actor): MarkResult {
  try {
    const repo = githubRepoOf(projectDir);
    if (repo === null) return { skipped: NOT_GITHUB };
    sendPendingMarks(store, actor, projectDir, commit);
    const { state, description } = markOf(kind, detail, waiver ?? actor);
    const sent = setCommitStatus(projectDir, repo, commit, MARK_CONTEXT, state, description);
    store.recordReviewMark(actor, {
      ...parent,
      commitSha: commit,
      kind,
      state,
      sentAt: sent.ok ? new Date().toISOString() : null,
      description,
      ...(sent.ok ? {} : { detail: { why: sent.why } }),
    });
    return sent.ok ? { commit, state, description, sent: true } : { commit, state, description, sent: false, why: sent.why };
  } catch (error) {
    return { skipped: `the mark was not set: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** GitHub's answer for a commit it does not have: one not pushed yet, or one a rebase left behind. */
function commitNotOnGithub(why: string): boolean {
  return /\b422\b|No commit found/i.test(why);
}

/**
 * Sends each commit's newest mark that is still not sent. An older mark of a commit with a newer
 * one is never sent. `except` names a commit whose new mark is about to be set anyway. A commit
 * GitHub does not have yet is passed over and its mark waits; any other failure stops the sending,
 * since GitHub is then most likely out of reach.
 */
export function sendPendingMarks(store: Store, actor: Actor, projectDir: string, except?: string): { sent: number; pending: number } {
  const repo = githubRepoOf(projectDir);
  const newest = new Map<string, ReviewMark>();
  for (const mark of store.listReviewMarks()) newest.set(mark.commitSha, mark);
  const unsent = [...newest.values()].filter((mark) => mark.sentAt === null && mark.commitSha !== except);
  if (repo === null) return { sent: 0, pending: unsent.length };
  let sent = 0;
  for (const mark of unsent) {
    const result = setCommitStatus(projectDir, repo, mark.commitSha, MARK_CONTEXT, mark.state as MarkState, mark.description);
    if (!result.ok) {
      if (commitNotOnGithub(result.why)) continue;
      break;
    }
    store.markSent(actor, mark.id, new Date().toISOString());
    sent += 1;
  }
  return { sent, pending: unsent.length - sent };
}

/** Like sendPendingMarks, but never throws: a pull request does not wait on GitHub's statuses. */
export function trySendPendingMarks(store: Store, actor: Actor, projectDir: string): void {
  try {
    sendPendingMarks(store, actor, projectDir);
  } catch {
    // The marks stay recorded as not sent, for the next occasion.
  }
}

/** Whether `branch`'s protection requires the mark: null when origin is no GitHub repository, else GitHub's answer or why it gave none. */
export function requiredMarkOn(projectDir: string, branch: string): { required: boolean } | { unknown: string } | null {
  const repo = githubRepoOf(projectDir);
  return repo === null ? null : requiresStatusCheck(projectDir, repo, branch, MARK_CONTEXT);
}

/** Whether `branch` requires the mark, as a pull request's result carries it: null when not known. */
export function markRequiredOn(projectDir: string, branch: string): boolean | null {
  try {
    const answer = requiredMarkOn(projectDir, branch);
    return answer !== null && "required" in answer ? answer.required : null;
  } catch {
    return null;
  }
}

/** The line saying what became of a mark; null when origin is no GitHub repository. */
export function markLine(mark: MarkResult): string | null {
  if ("skipped" in mark) return mark.skipped === NOT_GITHUB ? null : `No mark was set on GitHub: ${mark.skipped}.`;
  if (mark.sent) return `Marked ${MARK_CONTEXT} ${mark.state} on ${mark.commit.slice(0, 12)} on GitHub.`;
  if (commitNotOnGithub(mark.why ?? "")) return `GitHub does not have ${mark.commit.slice(0, 12)} yet; tmb sends its mark ${MARK_CONTEXT} ${mark.state} once it pushes the commit.`;
  return `The mark on GitHub was not sent (${mark.why ?? "no reason given"}); tmb sends it on the next review, waiver or pull request.`;
}

/** How to make `branch`'s protection require the mark. tmb never changes that setting itself. */
export function requireMarkHowTo(branch: string): string {
  return (
    `Branch protection on ${branch} does not require ${MARK_CONTEXT}; to require it, turn on 'Require status checks to pass' for ${branch} on GitHub and add ${MARK_CONTEXT}. ` +
    "tmb never changes this setting."
  );
}

/** The line saying whether `branch` requires the mark; null when not known. */
export function markRequiredLine(branch: string, required: boolean | null): string | null {
  if (required === null) return null;
  return required ? `Branch protection on ${branch} requires ${MARK_CONTEXT}.` : requireMarkHowTo(branch);
}
