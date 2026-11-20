// The mark on GitHub: when tmb records a review's verdict or a Human waiver, it sets a commit
// status on that exact commit, so the repo's own branch protection can require it before a merge.
// A mark that could not be sent is recorded as not sent and sent at the next occasion (a review,
// a waiver or a pull request); it never fails the review. Only the newest mark of a commit is
// ever sent, so an old one never overwrites a newer verdict. tmb only reads branch protection.
import { githubRepoOf, requiresStatusCheck, setCommitStatus } from "../github.ts";
import type { Actor, Store } from "../store/index.ts";

/** The status check's name, the one the Human requires in the base branch's protection. */
export const MARK_CONTEXT = "tmb/review";
/** What an audit entry of a mark is about. */
export const REVIEW_MARK = "review_mark";
/** What an audit entry is about when a mark recorded as not sent was sent later. */
export const REVIEW_MARK_SENT = "review_mark_sent";

export type MarkKind = "pass" | "fail" | "waiver";
export type MarkState = "success" | "failure";

/** What became of a mark: set on GitHub or not, or skipped because origin is no GitHub repository. */
export type MarkResult = { commit: string; state: MarkState; description: string; sent: boolean; why?: string } | { skipped: string };

type MarkDetail = { commit: string; state: MarkState; description: string; sent: boolean; why?: string };

const NOT_GITHUB = "origin is not a GitHub repository";

function blockingCount(count: number): string {
  return `${count} blocking finding${count === 1 ? "" : "s"}`;
}

/** The mark's state and text for a verdict or a waiver. */
function markOf(kind: MarkKind, reason: string | number | undefined): { state: MarkState; description: string } {
  if (kind === "pass") return { state: "success", description: "Passed tmb's review" };
  if (kind === "fail") return { state: "failure", description: `Failed tmb's review: ${blockingCount(typeof reason === "number" ? reason : 0)}` };
  return { state: "success", description: `Passed: review waived by the Human: ${String(reason ?? "").trim()}` };
}

/**
 * Sets the mark for a verdict or a waiver on `commit` and records it. `detail` is the number of
 * blocking findings for a fail and the reason for a waiver. Never throws: a mark that could not be
 * sent is recorded as such and sent at the next occasion.
 */
export function markReviewed(store: Store, actor: Actor, projectDir: string, commit: string, kind: MarkKind, detail?: string | number): MarkResult {
  try {
    const repo = githubRepoOf(projectDir);
    if (repo === null) return { skipped: NOT_GITHUB };
    sendPendingMarks(store, actor, projectDir, commit);
    const { state, description } = markOf(kind, detail);
    const sent = setCommitStatus(projectDir, repo, commit, MARK_CONTEXT, state, description);
    const mark: MarkDetail = sent.ok ? { commit, state, description, sent: true } : { commit, state, description, sent: false, why: sent.why };
    store.recordAudit(actor, { what: REVIEW_MARK, detail: JSON.stringify(mark) });
    return mark;
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
  const delivered = new Set(store.listAuditAbout(REVIEW_MARK_SENT).map((entry) => (JSON.parse(entry.detail) as { mark_id: string }).mark_id));
  const newest = new Map<string, { id: string; mark: MarkDetail }>();
  for (const entry of store.listAuditAbout(REVIEW_MARK)) {
    const mark = JSON.parse(entry.detail) as MarkDetail;
    newest.set(mark.commit, { id: entry.id, mark });
  }
  const unsent = [...newest.values()].filter(({ id, mark }) => !mark.sent && !delivered.has(id) && mark.commit !== except);
  if (repo === null) return { sent: 0, pending: unsent.length };
  let sent = 0;
  for (const { id, mark } of unsent) {
    const result = setCommitStatus(projectDir, repo, mark.commit, MARK_CONTEXT, mark.state, mark.description);
    if (!result.ok) {
      if (commitNotOnGithub(result.why)) continue;
      break;
    }
    store.recordAudit(actor, { what: REVIEW_MARK_SENT, detail: JSON.stringify({ mark_id: id }) });
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
