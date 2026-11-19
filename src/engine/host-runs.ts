// A host set up as the reviewer reviews in its main agent, so no subagent start or stop marks
// its run. Its run opens at the host's session start, or when it next reads a brief after a
// verdict, and ends with the verdict it records or, failing that, with the session.
import { hostRole } from "./settings.ts";
import type { Actor, Run, Store } from "./store/index.ts";

/** The outcome of a reviewer host's run whose session ended before a verdict. */
export const NO_VERDICT = "session ended with no verdict";

/** Whether the host's main agent is the project's reviewer. */
export function isReviewerHost(store: Store, host: string): boolean {
  return hostRole(store, host) === "reviewer";
}

function reviewerActor(host: string): Actor {
  return { kind: "agent", role: "reviewer", host };
}

/** The host's open reviewer runs, oldest first. */
function openRunsOf(store: Store, host: string): Run[] {
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
