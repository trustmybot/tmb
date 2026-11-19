// The gate's answer to a host event. Every host raises the same tmb events, and every rule
// is written against them here. A worker starts only on an open task with its worktree
// ready, and its start and stop are recorded as a run; a record tmb cannot read denies, so
// nothing runs unguarded in a project whose record is broken.
import { taskIdInPrompt, taskStartLine, worktreeReady } from "./handlers/tasks.ts";
import { openProjectStore } from "./project.ts";
import { type Actor, ROLES, type Role, type Store, type StoreOpenError } from "./store/index.ts";

export const TMB_EVENT_TYPES = ["session-start", "before-file-write", "before-command", "before-agent-start", "after-agent-stop"] as const;
export type TmbEventType = (typeof TMB_EVENT_TYPES)[number];

/** A host-neutral event: the same fields whatever host raised it. */
export type TmbEvent = {
  type: TmbEventType;
  projectDir: string;
  /** The host's id, as its adapter names it. */
  host: string;
  /** The role of the agent starting or stopping; for any other event, the planner or the subagent the event came from. */
  role: string;
  task?: string;
  /** What is about to happen: the file path, the command, the start prompt of an agent starting, or the role of one stopping. */
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

const WORKER: Role = "worker";
const HOW_TO_START = `Start the task first with the task_start tool, or \`tmb task start\` from the command line, then start the worker with the ${taskStartLine("<id>")} line from its brief in the start prompt.`;

/** A worker starts only when its start prompt names an open task whose worktree is ready; the start is recorded as a run. */
function workerStart(store: Store, event: TmbEvent): Decision {
  const deny = (why: string): Decision => ({
    decision: "deny",
    reason: `A worker starts only on an open task whose worktree is ready, named in its start prompt as ${taskStartLine("<id>")}. ${why} ${HOW_TO_START}`,
  });
  const taskId = taskIdInPrompt(event.action);
  if (taskId === null) return deny("This start prompt names no task.");
  const task = store.getTask(taskId);
  if (!task) return deny(`No task ${taskId} is in the record.`);
  if (task.state !== "open") return deny(`Task ${taskId} is ${task.state}.`);
  if (!worktreeReady(task)) return deny(`Task ${taskId}'s worktree ${task.worktree ?? "(none)"} is missing.`);
  const runId = store.appendRun(actorOf(event), { taskId, role: WORKER });
  return { decision: "allow", reason: `worker run ${runId} started on open task ${taskId}` };
}

/**
 * Ends the worker's run. Without a task to match on, it ends a run only when exactly one
 * worker run is open: guessing among several would record a false end, and a start left
 * without an end is shown as a finding instead.
 */
function workerStop(store: Store, event: TmbEvent): Decision {
  const open = store.openRuns(WORKER, event.task);
  if (open.length !== 1) {
    const which = event.task === undefined ? "" : ` on task ${event.task}`;
    const reason =
      open.length === 0 ? `no open worker run${which} to end` : `${open.length} worker runs are open and the stop names no task, so none was ended`;
    return { decision: "allow", reason };
  }
  store.endRun(actorOf(event), open[0]!.id, { outcome: "stopped" });
  return { decision: "allow", reason: `worker run ${open[0]!.id} ended` };
}

function rule(store: Store, event: TmbEvent): Decision {
  if (event.role === WORKER && event.type === "before-agent-start") return workerStart(store, event);
  if (event.role === WORKER && event.type === "after-agent-stop") return workerStop(store, event);
  return { decision: "allow" };
}

/**
 * Allows or denies a host event. With no record in the project it allows and records
 * nothing; a record it cannot read, or one a newer tmb made, denies with the cause. With a
 * readable record each decision is recorded as a guard decision, together with the run it
 * starts or ends.
 */
export function decide(event: TmbEvent): Decision {
  const opened = openProjectStore(event.projectDir, { create: false });
  if (!opened.ok) return opened.error.failure === "missing" ? { decision: "allow" } : unreadableRecord(opened.error);
  const store = opened.store;
  try {
    return store.transaction(() => {
      const decision = rule(store, event);
      store.appendGuardDecision(actorOf(event), {
        event: recordedEvent(event),
        decision: decision.decision,
        reason: decision.reason ?? NO_RULE_DENIES,
      });
      return decision;
    });
  } catch (error) {
    return { decision: "deny", reason: `tmb could not record its decision in the project's record, so it allows nothing: ${message(error)}.` };
  } finally {
    opened.store.close();
  }
}
