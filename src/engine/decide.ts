// The gate's answer to a host event. Every host raises the same tmb events, and every rule
// is written against them here. No rule denies yet; a record tmb cannot read denies, so
// nothing runs unguarded in a project whose record is broken.
import { openProjectStore } from "./project.ts";
import { type Actor, ROLES, type Role, type StoreOpenError } from "./store/index.ts";

export const TMB_EVENT_TYPES = ["session-start", "before-file-write", "before-command", "before-agent-start", "after-agent-stop"] as const;
export type TmbEventType = (typeof TMB_EVENT_TYPES)[number];

/** A host-neutral event: the same fields whatever host raised it. */
export type TmbEvent = {
  type: TmbEventType;
  projectDir: string;
  /** The host's id, as its adapter names it. */
  host: string;
  /** The planner, or the role of the subagent the event came from. */
  role: string;
  task?: string;
  /** What is about to happen: the file path, the command, or the role of the agent starting or stopping. */
  action: string;
};

/** A deny always says why; an allow may. */
export type Decision = { decision: "allow"; reason?: string } | { decision: "deny"; reason: string };

const NO_RULE_DENIES = "no rule denies it";

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

function unreadableRecord(error: StoreOpenError): Decision {
  const remedy = error.failure === "newer" ? "upgrade tmb to work in this project" : "repair or move the record so tmb can read it";
  return { decision: "deny", reason: `tmb cannot read the project's record, so it allows nothing: ${message(error)}. To go on, ${remedy}.` };
}

/**
 * The actor a decision is recorded under. A subagent that is not a tmb role works inside
 * the planner's session, so its decisions are the planner's; the recorded event keeps the
 * role the host named.
 */
function actorOf(event: TmbEvent): Actor {
  const role: Role = (ROLES as readonly string[]).includes(event.role) ? (event.role as Role) : "planner";
  return { kind: "agent", role, host: event.host };
}

function recordedEvent(event: TmbEvent): string {
  return JSON.stringify({ type: event.type, role: event.role, task: event.task, action: event.action });
}

/**
 * Allows or denies a host event. With no record in the project it allows and records
 * nothing; a record it cannot read, or one a newer tmb made, denies with the cause. With a
 * readable record each decision is recorded as a guard decision.
 */
export function decide(event: TmbEvent): Decision {
  const opened = openProjectStore(event.projectDir, { create: false });
  if (!opened.ok) return opened.error.failure === "missing" ? { decision: "allow" } : unreadableRecord(opened.error);
  try {
    const decision: Decision = { decision: "allow" };
    opened.store.appendGuardDecision(actorOf(event), {
      event: recordedEvent(event),
      decision: decision.decision,
      reason: decision.reason ?? NO_RULE_DENIES,
    });
    return decision;
  } catch (error) {
    return { decision: "deny", reason: `tmb could not record its decision in the project's record, so it allows nothing: ${message(error)}.` };
  } finally {
    opened.store.close();
  }
}
