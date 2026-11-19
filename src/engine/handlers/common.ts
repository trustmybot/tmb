// What the feature and task operations share: where they run, who may call them, and the
// states and branch names they use.
import type { Actor, Role } from "../store/index.ts";
import { HandlerError } from "./errors.ts";

/** Where an operation runs: the project's folder, and how long each check may take. */
export type OperationContext = { projectDir: string; checkTimeoutMs?: number };

export const OPEN = "open";
export const CLOSED = "closed";
/** Task branches live under this prefix, so no feature branch may take it. */
export const TASK_BRANCH_PREFIX = "tmb/";

/** Refuses an agent whose role is not one of `roles`; the Human may always call. */
export function requireRole(actor: Actor, operation: string, roles: readonly Role[]): void {
  if (actor.kind === "agent" && !roles.includes(actor.role)) {
    throw new HandlerError("refused", `${operation} is for the ${roles.join(" or ")}, not the ${actor.role}`);
  }
}
