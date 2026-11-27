// A host set up as the reviewer reviews in its main agent, so no subagent start or stop marks
// its run. Its run opens at the host's session start, or when it next reads a brief after a
// verdict, and ends with the verdict it records or, failing that, with the session.
import { hostRole } from "./settings.ts";
import type { Actor, Role, Run, Store } from "./store/index.ts";

/** A run that did what it was started for: a worker's task left the open state, a reviewer recorded its verdict (trustmybot/tmb#133). */
export const FINISHED = "finished";
/** A run that ended any other way. */
export const STOPPED = "stopped";
/** The outcome of a reviewer host's run whose session ended before a verdict. */
export const NO_VERDICT = STOPPED;

/** Whether the host's main agent is the project's reviewer. */
export function isReviewerHost(store: Store, host: string): boolean {
  return hostRole(store, host) === "reviewer";
}

function reviewerActor(host: string): Actor {
  return { kind: "agent", role: "reviewer", host };
}

/** The host's open reviewer runs, oldest first; the oldest is the one a verdict from that host is written by. */
export function openRunsOf(store: Store, host: string): Run[] {
  return store.openRuns("reviewer").filter((run) => run.createdBy.kind === "agent" && run.createdBy.host === host);
}

/** Opens a run for the reviewer host's main agent; returns its id. */
export function openHostReviewerRun(store: Store, host: string): string {
  return store.appendRun(reviewerActor(host), { role: "reviewer" });
}

/** Opens a run for the reviewer host unless one is open already. */
export function ensureHostReviewerRun(store: Store, host: string): void {
  if (isReviewerHost(store, host) && openRunsOf(store, host).length === 0) openHostReviewerRun(store, host);
}

/** Ends the reviewer host's oldest open run with the outcome; returns its id, or null when none was open. */
export function endHostReviewerRun(store: Store, host: string, outcome: string): string | null {
  const run = openRunsOf(store, host)[0];
  if (!run) return null;
  store.endRun(reviewerActor(host), run.id, { outcome });
  return run.id;
}

/**
 * Opens a run of `role` on a task; returns its id. The task's earlier open runs of that role end
 * as stopped first (trustmybot/tmb#459): a new start on the task means the old agent is gone, and
 * a stop that names no task could never end it.
 */
export function startTaskRun(store: Store, actor: Actor, taskId: string, role: Role): string {
  return store.transaction(() => {
    for (const run of store.openRuns(role, taskId)) store.endRun(actor, run.id, { outcome: STOPPED, cost: null });
    return store.appendRun(actor, { taskId, role });
  });
}
