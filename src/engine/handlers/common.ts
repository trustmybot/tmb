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
export const TRUEST = "truest";
/** Task branches live under this prefix, so no feature branch may take it. */
export const TASK_BRANCH_PREFIX = "tmb/";

/** Refuses an agent whose role is not one of `roles`; the Human may always call. */
export function requireRole(actor: Actor, operation: string, roles: readonly Role[]): void {
  if (actor.kind === "agent" && !roles.includes(actor.role)) {
    throw new HandlerError("refused", `${operation} is for the ${roles.join(" or ")}, not the ${actor.role}`);
  }
}
