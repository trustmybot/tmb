// Truest mode: every task is reviewed before its push. A task is cut from the base branch, and
// its close runs the checks and leaves it in review at that commit, with its worktree kept. The
// reviewer passes or fails that exact commit; a fail reopens the task for rework. Once a pass or
// a Human waiver covers the commit, the engine pushes the task's branch and opens its own pull
// request into the base branch. When the base branch moved since the task was cut, the engine
// rebases the reviewed commit first: an unchanged patch keeps its review once the checks pass
// again, a changed one needs a new review, and a conflict reopens the task.
import { spawnSync } from "node:child_process";
import { gitFailure, runGit } from "../git.ts";
import { readSettings } from "../settings.ts";
import type { Actor, Review, Store, Task } from "../store/index.ts";
import { CLOSED, IN_REVIEW, OPEN, type OperationContext, requireRole, TRUEST } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { baseBranchTip } from "./features.ts";
import { isAncestor, pushFeature, rebaseOnto, undoRebase } from "./fold.ts";
import { type InputSchema, NOT_BLANK, RECORD_ID, validateInput } from "./input.ts";
import { existingPullRequest, type Finding, openPullRequest, type ReviewSummary, summaryOf, type Verdict } from "./reviews.ts";
import {
  type CheckRunOutcome,
  checkCommit,
  closeChecks,
  closeResult,
  committedHead,
  requireHeadAt,
  requireTask,
  type TaskCloseResult,
  worktreeReady,
} from "./tasks.ts";

/** What an audit entry of a Human waiver of one task's review is about. */
export const TASK_WAIVER = "task_waiver";
/** What an audit entry is about when a rebase that left the patch unchanged carried a task's review to the rebased commit. */
export const REVIEW_CARRY = "review_carry";

const ORIGIN = "origin";
const PATCH_ID_TIMEOUT_MS = 60_000;
/** How many carries coverage follows back; a real task has a handful at most. */
const CARRY_DEPTH_MAX = 50;

export type TaskWaiver = { id: string; task: string; commit: string; reason: string; at: string };
/** A rebase that kept the patch, so the review of `from` holds for `to`. */
export type ReviewCarry = { id: string; task: string; from: string; to: string; at: string };

export type TruestReview = {
  /** The diff to review: from the commit the task was cut from to the task's commit. */
  from: string | null;
  to: string | null;
  reviews: ReviewSummary[];
  waivers: TaskWaiver[];
  carries: ReviewCarry[];
  /** Whether a pass or a waiver covers the task's commit, so its pull request may open. */
  covered: boolean;
  coveredBy: "review" | "waiver" | null;
  prUrl: string | null;
  /** The line a reviewer's start prompt carries for this task. */
  reviewLine: string;
};

/** The line that names a truest task to the reviewer. */
export function taskReviewLine(id: string): string {
  return `review_task=${id}`;
}

function allTaskWaivers(store: Store): TaskWaiver[] {
  return store.listAuditAbout(TASK_WAIVER).map((entry) => {
    const detail = JSON.parse(entry.detail) as { task_id: string; commit: string; reason: string };
    return { id: entry.id, task: detail.task_id, commit: detail.commit, reason: detail.reason, at: entry.createdAt };
  });
}

function allCarries(store: Store): ReviewCarry[] {
  return store.listAuditAbout(REVIEW_CARRY).map((entry) => {
    const detail = JSON.parse(entry.detail) as { task_id: string; from: string; to: string };
    return { id: entry.id, task: detail.task_id, from: detail.from, to: detail.to, at: entry.createdAt };
  });
}

type TaskCoverage = { reviews: Review[]; waivers: TaskWaiver[]; carries: ReviewCarry[] };

/** Every waiver and carry in the record, read once for many tasks. */
type AuditCoverage = { waivers: TaskWaiver[]; carries: ReviewCarry[] };

function auditCoverage(store: Store): AuditCoverage {
  return { waivers: allTaskWaivers(store), carries: allCarries(store) };
}

function coverageRecords(store: Store, taskId: string, audits: AuditCoverage = auditCoverage(store)): TaskCoverage {
  return {
    reviews: store.listTaskReviews(taskId),
    waivers: audits.waivers.filter((waiver) => waiver.task === taskId),
    carries: audits.carries.filter((carry) => carry.task === taskId),
  };
}

/**
 * What lets one task's `commit` through: a Human waiver on it, the newest review on it being a
 * pass, or a carry from a commit that is itself covered. A waiver is the Human's call, so a later
 * fail does not undo it; a fail on a commit undoes a pass carried to it.
 */
function coverageAt(records: TaskCoverage, commit: string, depth = 0): "review" | "waiver" | null {
  if (records.waivers.some((waiver) => waiver.commit === commit)) return "waiver";
  const newest = records.reviews.filter((review) => review.commitSha === commit).at(-1);
  if (newest !== undefined) return newest.verdict === "pass" ? "review" : null;
  if (depth >= CARRY_DEPTH_MAX) return null;
  for (const carry of records.carries.filter((each) => each.to === commit).reverse()) {
    const carried = coverageAt(records, carry.from, depth + 1);
    if (carried !== null) return carried;
  }
  return null;
}

export function truestReviewOf(store: Store, task: Task): TruestReview {
  const records = coverageRecords(store, task.id);
  const coveredBy = task.commitSha === null || task.state === OPEN ? null : coverageAt(records, task.commitSha);
  return {
    from: task.baseCommit,
    to: task.state === OPEN ? null : task.commitSha,
    reviews: records.reviews.map(summaryOf),
    waivers: records.waivers,
    carries: records.carries,
    covered: coveredBy !== null,
    coveredBy,
    prUrl: task.prUrl,
    reviewLine: taskReviewLine(task.id),
  };
}

/** Every commit of a truest task that a pass, a waiver or a carried pass covers: the push gate lets these through. */
export function truestCoveredCommits(store: Store): string[] {
  const commits = new Set<string>();
  const audits = auditCoverage(store);
  for (const task of store.listTasks()) {
    if (task.reviewMode !== TRUEST) continue;
    const records = coverageRecords(store, task.id, audits);
    const candidates = new Set([
      ...records.reviews.map((review) => review.commitSha).filter((sha): sha is string => sha !== null),
      ...records.waivers.map((waiver) => waiver.commit),
      ...records.carries.map((carry) => carry.to),
    ]);
    for (const commit of candidates) if (coverageAt(records, commit) !== null) commits.add(commit);
  }
  return [...commits];
}

/**
 * Every commit that is a truest task's work: from the commit the task was cut from to its
 * branch and to each commit of it the record names (a rebase leaves the reviewed one behind).
 * The push gate holds these to review on any branch; a commit of no task it lets through.
 */
export function truestTaskCommits(store: Store, projectDir: string): Set<string> {
  const commits = new Set<string>();
  const audits = auditCoverage(store);
  for (const task of store.listTasks()) {
    // A closed task's branch is on origin with its pull request, its commits covered, so only live tasks are listed.
    if (task.reviewMode !== TRUEST || task.baseCommit === null || task.state === CLOSED) continue;
    const records = coverageRecords(store, task.id, audits);
    const tips = [
      task.branch === null ? null : `refs/heads/${task.branch}`,
      task.commitSha,
      ...records.reviews.map((review) => review.commitSha),
      ...records.waivers.map((waiver) => waiver.commit),
      ...records.carries.flatMap((carry) => [carry.from, carry.to]),
    ].filter((tip): tip is string => tip !== null && runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${tip}^{commit}`]).ok);
    if (tips.length === 0) continue;
    const listed = runGit(projectDir, ["rev-list", "--no-merges", ...new Set(tips), "--not", task.baseCommit]);
    if (listed.ok) for (const sha of listed.stdout.split("\n")) if (sha !== "") commits.add(sha);
  }
  return commits;
}

/**
 * The commit a truest task is cut from: the base branch as origin holds it, fetched first, so
 * the task's pull request carries only the task's own work. The local base branch when there is
 * no origin, or origin does not have it.
 */
export function truestBase(projectDir: string, baseBranch: string, cutting: string): string {
  if (baseBranch.startsWith("-")) return baseBranchTip(projectDir, baseBranch, cutting);
  if (runGit(projectDir, ["remote", "get-url", ORIGIN]).ok) {
    const remoteRef = `refs/remotes/${ORIGIN}/${baseBranch}`;
    // A failed fetch, offline say, leaves the copy as it was; the engine works with no network.
    runGit(projectDir, ["fetch", "--quiet", ORIGIN, `+refs/heads/${baseBranch}:${remoteRef}`], { GIT_TERMINAL_PROMPT: "0" });
    const remote = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`]);
    if (remote.ok) return remote.stdout;
  }
  return baseBranchTip(projectDir, baseBranch, cutting);
}

// --- task_close in truest mode ------------------------------------------------------------

/** Runs the checks on the task's commit; on a pass the task waits for the reviewer at that commit, its worktree kept. */
export async function truestClose(store: Store, actor: Actor, task: Task, context: OperationContext): Promise<TaskCloseResult> {
  const worktree = task.worktree!;
  const head = committedHead(task);
  const commands = closeChecks(store, task);
  const runs: CheckRunOutcome[] = [await checkCommit(store, actor, task, head, commands, context)];
  const baseCommit = movedBase(store, task, head, context.projectDir);
  store.transaction(() => {
    if (requireTask(store, task.id).state !== OPEN) throw new HandlerError("refused", `task ${task.id} was closed while its checks ran`);
    requireHeadAt(worktree, head);
    store.updateTask(actor, task.id, { state: IN_REVIEW, commitSha: head, ...(baseCommit === null ? {} : { baseCommit }) });
  });
  const next = `task ${task.id} is in review at ${head}: start the reviewer with the ${taskReviewLine(task.id)} line in its prompt; once it passes, open the pull request with task_pr`;
  return { ...closeResult(store, task.id, runs, { fold: null, push: null, cleanupProblems: [] }), next };
}

/**
 * The newer base a worker rebased the task onto, so the reviewer's diff holds the task's own work
 * only: where the task's commit leaves the base branch's newest commit, when that is past the
 * commit the task was cut from. Null when the task still leaves the base where it was cut.
 */
function movedBase(store: Store, task: Task, head: string, projectDir: string): string | null {
  const baseBranch = readSettings(store).base_branch;
  if (baseBranch === null || task.baseCommit === null) return null;
  const tip = truestBase(projectDir, baseBranch, `task ${task.id}`);
  const meet = runGit(projectDir, ["merge-base", head, tip]);
  if (!meet.ok || meet.stdout === task.baseCommit) return null;
  return isAncestor(projectDir, task.baseCommit, meet.stdout) ? meet.stdout : null;
}

function requireInReview(store: Store, id: string, doing: string): Task {
  const task = requireTask(store, id);
  if (task.reviewMode !== TRUEST) {
    throw new HandlerError("refused", `task ${id} was started in agile mode, so it is reviewed with its feature branch, not on its own`);
  }
  if (task.state !== IN_REVIEW) {
    const why = task.state === OPEN ? "its work is not closed yet: task_close runs its checks first" : `it is ${task.state}`;
    throw new HandlerError("refused", `task ${id} is not in review, so ${doing}: ${why}`);
  }
  return task;
}

// --- task_review --------------------------------------------------------------------------

const FINDING_ITEM = { type: "string", pattern: NOT_BLANK } as const;

export const taskReviewSchema: InputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The id of the task you reviewed, from the review_task=<id> line of your prompt.", pattern: RECORD_ID },
    commit: {
      type: "string",
      description: "The commit you reviewed the task at: the one its brief shows. A review counts only for that commit.",
      pattern: "^[0-9a-fA-F]{7,64}$",
    },
    verdict: { type: "string", description: "pass when no finding blocks, fail when one does.", enum: ["pass", "fail"] },
    blocking: {
      type: "array",
      description: "Each blocking finding: file and line and the concrete failure scenario. A fail names at least one; a pass names none.",
      items: FINDING_ITEM,
    },
    notes: { type: "array", description: "Each finding that does not block, or that was already on the base, in the same form.", items: FINDING_ITEM },
  },
  required: ["id", "commit", "verdict"],
  additionalProperties: false,
};

export type TaskReviewResult = { review: ReviewSummary; task: string; state: string; covered: boolean; next: string };

type TaskReviewInput = { id: string; commit: string; verdict: Verdict; blocking?: string[]; notes?: string[] };

export function taskReview(store: Store, actor: Actor, input: unknown, context: OperationContext): TaskReviewResult {
  const given = validateInput<TaskReviewInput>("task_review", taskReviewSchema, input);
  if (actor.kind === "human") {
    throw new HandlerError("refused", "only the reviewer records a review; the Human waives one instead, with `tmb task waive <id> --reason <text>`");
  }
  requireRole(actor, "task_review", ["reviewer"]);
  if (store.openRuns("reviewer").length === 0) {
    throw new HandlerError("refused", "no reviewer run is open: a review is recorded only by a reviewer the host started as a subagent, and tmb records that start");
  }
  const blocking = given.blocking ?? [];
  const notes = given.notes ?? [];
  if (given.verdict === "pass" && blocking.length > 0) throw new HandlerError("invalid_input", "a pass names no blocking finding; with one, the verdict is fail");
  if (given.verdict === "fail" && blocking.length === 0) throw new HandlerError("invalid_input", "a fail names at least one blocking finding");

  const task = requireInReview(store, given.id, "it takes no review");
  const resolved = runGit(context.projectDir, ["rev-parse", "--verify", "--quiet", `${given.commit}^{commit}`]);
  if (!resolved.ok || resolved.stdout !== task.commitSha) {
    throw new HandlerError(
      "refused",
      `task ${task.id} is in review at ${task.commitSha}, not at the commit reviewed (${given.commit}); read task_brief again and review the task at that commit`,
    );
  }
  const findings: Finding[] = [...blocking.map((text) => ({ text, blocking: true })), ...notes.map((text) => ({ text, blocking: false }))];
  const reviewId = store.transaction(() => {
    const id = store.appendReview(actor, { target: { kind: "commit", ref: task.id }, verdict: given.verdict, findings, commitSha: task.commitSha });
    // A fail sends the work back: the task reopens in the same worktree for its worker.
    if (given.verdict === "fail") store.updateTask(actor, task.id, { state: OPEN });
    return id;
  });
  const review = summaryOf(store.listTaskReviews(task.id).find((each) => each.id === reviewId)!);
  const covered = given.verdict === "pass";
  const next = covered
    ? `the pull request may open: the planner calls task_pr for task ${task.id}`
    : `task ${task.id} is open again: the planner starts a worker on it with the task_id=${task.id} line to rework each blocking finding, and its close sends it back to review`;
  return { review, task: task.id, state: covered ? IN_REVIEW : OPEN, covered, next };
}

// --- task_waive ---------------------------------------------------------------------------

export const taskWaiveSchema: InputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The task's id.", pattern: RECORD_ID },
    reason: { type: "string", description: "Why the review is waived, kept in the record.", pattern: NOT_BLANK },
  },
  required: ["id", "reason"],
  additionalProperties: false,
};

export function taskWaive(store: Store, actor: Actor, input: unknown): TaskWaiver {
  const given = validateInput<{ id: string; reason: string }>("task_waive", taskWaiveSchema, input);
  if (actor.kind !== "human") throw new HandlerError("refused", `only the Human waives a review, from the command line; the ${actor.role} cannot`);
  const task = requireInReview(store, given.id, "there is no review to waive");
  const detail = { task_id: task.id, commit: task.commitSha, reason: given.reason.trim() };
  const id = store.recordAudit(actor, { what: TASK_WAIVER, detail: JSON.stringify(detail) });
  return allTaskWaivers(store).find((waiver) => waiver.id === id)!;
}

// --- task_pr ------------------------------------------------------------------------------

export const taskPrSchema: InputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The task's id.", pattern: RECORD_ID },
    title: { type: "string", description: "The pull request's title.", pattern: NOT_BLANK },
    body: { type: "string", description: "The pull request's description; tmb adds how the review went." },
  },
  required: ["id", "title"],
  additionalProperties: false,
};

export type TaskPrResult = {
  task: string;
  url: string;
  base: string;
  branch: string;
  commit: string;
  coveredBy: "review" | "waiver";
  /** Set when the base branch had moved: the commit the task was rebased onto, with its review carried over. */
  rebasedOnto: string | null;
  push: string;
  cleanupProblems: string[];
};

/** The stable patch id of the change from `from` to `to`, which a rebase that only moves the change keeps. */
function patchId(cwd: string, from: string, to: string): string | null {
  const diff = runGit(cwd, ["diff", "--binary", "--no-color", from, to]);
  if (!diff.ok) return null;
  if (diff.stdout === "") return "";
  const result = spawnSync("git", ["patch-id", "--stable"], { cwd, input: `${diff.stdout}\n`, encoding: "utf8", timeout: PATCH_ID_TIMEOUT_MS });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim().split(/\s+/)[0] ?? null;
}

/** Reopens the task for its worker and refuses with `why`, saying so. */
function reopenAndRefuse(store: Store, actor: Actor, task: Task, why: string): never {
  store.updateTask(actor, task.id, { state: OPEN });
  throw new HandlerError("refused", `${why}\nTask ${task.id} is open again for its worker; its close sends it back to review.`);
}

/**
 * Brings the reviewed commit onto the base branch's newest commit when it moved. Returns the
 * commit to push and the base it was rebased onto, or null when no rebase was needed. Refuses,
 * recording why, when the rebase conflicts or its checks fail (the task reopens) or the patch
 * changed (the task stays in review at the rebased commit).
 */
async function rebaseIfBaseMoved(
  store: Store,
  actor: Actor,
  task: Task,
  baseBranch: string,
  context: OperationContext,
): Promise<{ commit: string; onto: string | null }> {
  const worktree = task.worktree!;
  const reviewed = task.commitSha!;
  const tip = truestBase(context.projectDir, baseBranch, `task ${task.id}`);
  if (isAncestor(worktree, tip, reviewed)) return { commit: reviewed, onto: null };
  requireHeadAt(worktree, reviewed);
  const what = `the base branch ${baseBranch}`;
  let rebased: string;
  try {
    // Name the commit itself: a truest base comes from origin, which the local base branch may lag.
    rebased = rebaseOnto(worktree, tip, tip, task.id, what);
  } catch (error) {
    if (error instanceof HandlerError) reopenAndRefuse(store, actor, task, error.message);
    throw error;
  }
  const undo = (): string => undoRebase(worktree, rebased, reviewed) ?? `The worktree is back at ${reviewed}, as it was.`;
  if (rebased === tip) {
    // Nothing is left to bring: the task is done without a pull request, and its files are free again.
    undo();
    store.updateTask(actor, task.id, { state: CLOSED });
    const removed = runGit(context.projectDir, ["worktree", "remove", worktree]);
    const kept = removed.ok ? "" : ` Its worktree ${worktree} was not removed: ${gitFailure(removed)}.`;
    throw new HandlerError(
      "refused",
      `the base branch ${baseBranch} at ${tip} already holds the change of task ${task.id}, so its pull request would add nothing. The task is closed with no pull request; its branch ${task.branch} is kept.${kept}`,
    );
  }
  try {
    await checkCommit(store, actor, task, rebased, closeChecks(store, task), context, ` on the task rebased onto ${what} at ${tip}`);
  } catch (error) {
    if (error instanceof HandlerError) {
      const back = undo();
      reopenAndRefuse(store, actor, task, `${error.message}\n${back} Rebase it onto ${tip} in its worktree and make the checks pass there.`);
    }
    throw error;
  }
  const before = patchId(worktree, task.baseCommit!, reviewed);
  const after = patchId(worktree, tip, rebased);
  const stillReviewed = (): void => {
    const now = requireTask(store, task.id);
    if (now.state !== IN_REVIEW || now.commitSha !== reviewed) {
      const back = undo();
      throw new HandlerError("refused", `task ${task.id} changed while task_pr rebased it (it is ${now.state} at ${now.commitSha}), so nothing was recorded. ${back ?? ""}`.trim());
    }
  };
  if (before === null || after === null || before !== after) {
    // The reviewed change is not what would be pushed, so the review does not carry over.
    store.transaction(() => {
      stillReviewed();
      store.updateTask(actor, task.id, { commitSha: rebased, baseCommit: tip });
    });
    throw new HandlerError(
      "refused",
      `rebasing task ${task.id} onto ${what} at ${tip} changed its patch, so the review of ${reviewed} does not carry over. The task stays in review at ${rebased}: start the reviewer again with the ${taskReviewLine(task.id)} line in its prompt.`,
    );
  }
  store.transaction(() => {
    stillReviewed();
    store.recordAudit(actor, { what: REVIEW_CARRY, detail: JSON.stringify({ task_id: task.id, from: reviewed, to: rebased, onto: tip }) });
    store.updateTask(actor, task.id, { commitSha: rebased, baseCommit: tip });
  });
  return { commit: rebased, onto: tip };
}

export async function taskPr(store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<TaskPrResult> {
  const given = validateInput<{ id: string; title: string; body?: string }>("task_pr", taskPrSchema, input);
  requireRole(actor, "task_pr", ["planner"]);
  let task = requireInReview(store, given.id, "its pull request does not open");
  const baseBranch = readSettings(store).base_branch;
  if (baseBranch === null) throw new HandlerError("refused", "no base branch is set: the planner sets it with settings_set, or the Human with `tmb onboard --base <branch>`; in a project where `tmb init` has not run, run it first");
  if (!worktreeReady({ ...task, state: OPEN }) || task.branch === null) {
    throw new HandlerError("refused", `task ${task.id}'s worktree ${task.worktree ?? "(none)"} is missing, so tmb cannot bring it onto the base branch`);
  }
  const review = truestReviewOf(store, task);
  if (review.coveredBy === null) {
    const newest = review.reviews.at(-1);
    const why =
      newest === undefined
        ? "no reviewer has reviewed it"
        : newest.commit !== task.commitSha
          ? `its newest review was at ${newest.commit}, and the task has moved to ${task.commitSha} since`
          : `its newest review at ${task.commitSha} is a ${newest.verdict}`;
    throw new HandlerError(
      "refused",
      `the pull request of task ${task.id} opens only after the reviewer passes it at ${task.commitSha}, or the Human waives the review: ${why}. Start the reviewer with the ${taskReviewLine(task.id)} line in its prompt, or ask the Human to run \`tmb task waive ${task.id} --reason <text>\`.`,
    );
  }
  if (!runGit(context.projectDir, ["remote", "get-url", ORIGIN]).ok) {
    throw new HandlerError("refused", `the repository has no remote named ${ORIGIN}, so task ${task.id} has nowhere to push and no pull request to open`);
  }

  // A branch already on origin is never rebased, so a retry after a pull request that did not open pushes the same commit again.
  const { commit, onto } = task.pushResult === "pushed" ? { commit: task.commitSha!, onto: null } : await rebaseIfBaseMoved(store, actor, task, baseBranch, context);
  task = requireTask(store, task.id);
  const coveredBy = truestReviewOf(store, task).coveredBy;
  if (coveredBy === null) throw new HandlerError("refused", `task ${task.id} at ${commit} is no longer covered by a pass or a waiver; review it again`);

  // git's pre-push hook judges this push like any other, so the record must already cover the commit.
  const push = pushFeature(context.projectDir, task.branch!);
  store.updateTask(actor, task.id, { pushResult: push.result, pushDetail: push.detail });
  if (push.result !== "pushed") throw new HandlerError("refused", `the pull request of task ${task.id} needs its branch on origin, and the push did not happen: ${push.detail}`);
  const how =
    coveredBy === "review"
      ? `Reviewed by the tmb reviewer: pass at ${review.to}${onto === null ? "" : `, carried to ${commit} by a rebase onto ${onto} that kept the patch`}.`
      : `Review waived by the Human at ${review.to}: ${review.waivers.filter((waiver) => waiver.commit === review.to).at(-1)?.reason ?? ""}`;
  const body = [given.body?.trim() ?? "", how].filter((part) => part !== "").join("\n\n");
  let opened = openPullRequest(context.projectDir, ["--base", baseBranch, "--head", task.branch!, "--title", given.title, "--body", body]);
  if (!opened.ok) {
    // An earlier task_pr may have opened it before failing: that pull request is this task's.
    const existing = existingPullRequest(context.projectDir, task.branch!);
    if (existing !== null) opened = { ok: true, url: existing };
  }
  if (!opened.ok) throw new HandlerError("refused", `${task.branch} was pushed to origin, but its pull request did not open: ${opened.why}`);
  store.updateTask(actor, task.id, { state: CLOSED, prUrl: opened.url });

  // The branch stays, on origin and here, for the pull request; only the worktree goes.
  const removed = runGit(context.projectDir, ["worktree", "remove", task.worktree!]);
  const cleanupProblems = removed.ok ? [] : [`the worktree ${task.worktree} was not removed: ${gitFailure(removed)}`];
  return { task: task.id, url: opened.url, base: baseBranch, branch: task.branch!, commit, coveredBy, rebasedOnto: onto, push: push.detail, cleanupProblems };
}
