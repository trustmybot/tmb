// The gate's answer to a host event. Every host raises the same tmb events, and every rule
// is written against them here. A worker starts only on an open task with its worktree
// ready, and once it names that task from a worktree its host made for it, tmb adopts that
// worktree as the task's; a worker's and a reviewer's start and stop are recorded as a run. A
// reviewer host's main agent writes nothing. tmb reads a shell command only for a step only the
// Human may take (trustmybot/tmb#179): git's pre-push hook holds every push, whatever was typed.
// A record tmb cannot read denies, so nothing runs unguarded in a project whose record is broken.
import { realpathSync } from "node:fs";
import { runningName } from "../program.ts";
import { adoptWorktree } from "./handlers/adopt.ts";
import { humanOnlyInShell, shellDenyReason } from "./human-only.ts";
import { taskIdInPrompt, taskStartLine, worktreeReady } from "./handlers/tasks.ts";
import { openProjectStore } from "./project.ts";
import { hostRole } from "./settings.ts";
import { FINISHED, STOPPED } from "./host-runs.ts";
import { OPEN } from "./handlers/common.ts";
import { runGit } from "./git.ts";
import { inGitWorkTree, repoDirOf } from "./repos.ts";
import { type Actor, type ModelUsage, ROLES, type Role, type Run, type Store, type StoreOpenError } from "./store/index.ts";

export const TMB_EVENT_TYPES = [
  "session-start",
  "before-file-write",
  "before-agent-start",
  "agent-start-failed",
  "after-agent-stop",
  "worker-in-folder",
  "before-shell-command",
] as const;
export type TmbEventType = (typeof TMB_EVENT_TYPES)[number];

/**
 * The role an adapter gives an event from the host's main agent, which is not a subagent. The
 * engine reads the host's role in the record for it: the planner, unless init or onboard named another.
 */
export const MAIN_AGENT = "main-agent";

/**
 * The role an adapter gives an agent starting when the host's input does not say which agent it
 * is. The start goes through, and its recorded decision says tmb could not tell, as a finding.
 */
export const UNNAMED_AGENT = "unnamed-agent";

/** A host-neutral event: the same fields whatever host raised it. */
export type TmbEvent = {
  type: TmbEventType;
  projectDir: string;
  /** The host's id, as its adapter names it. */
  host: string;
  /** The role of the agent starting or stopping; for any other event, MAIN_AGENT or the subagent the event came from. */
  role: string;
  task?: string;
  /**
   * For a worker starting, on a host that cuts the worker's own worktree from the folder the start
   * is made in: that folder. The worker starts only from inside its task's repo (trustmybot/tmb#285).
   */
  startFolder?: string;
  /** For an agent stopping: the tokens it used, per model, when its host gives them (trustmybot/tmb#133). */
  cost?: ModelUsage[] | null;
  /**
   * What is about to happen: the file path, the start prompt of an agent starting or of one whose
   * start failed, or the role of one stopping; for a worker naming its task, the folder it works in;
   * for a shell command, its text.
   */
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
const REVIEWER: Role = "reviewer";

function howToStart(): string {
  return `Start the task first with the task_start tool, or \`${runningName()} task start\` from the command line, then start the worker with the ${taskStartLine("<id>")} line from its brief in the start prompt.`;
}

/** A worker starts only when its start prompt names an open task whose worktree is ready; the start is recorded as a run. */
function workerStart(store: Store, event: TmbEvent): Decision {
  const deny = (why: string): Decision => ({
    decision: "deny",
    reason: `A worker starts only on an open task whose worktree is ready, named in its start prompt as ${taskStartLine("<id>")}. ${why} ${howToStart()}`,
  });
  const taskId = taskIdInPrompt(event.action);
  if (taskId === null) return deny("This start prompt names no task.");
  const task = store.getTask(taskId);
  if (!task) return deny(`No task ${taskId} is in the record.`);
  if (task.state !== "open") return deny(`Task ${taskId} is ${task.state}.`);
  if (!worktreeReady(task)) return deny(`Task ${taskId}'s worktree ${task.worktree ?? "(none)"} is missing.`);
  if (event.startFolder !== undefined) {
    const repoDir = repoDirOf(event.projectDir, task.repo);
    if (!sameFolder(gitTopOf(event.startFolder), repoDir)) {
      if (!inGitWorkTree(repoDir)) {
        return {
          decision: "deny",
          reason: `Task ${taskId} names no repo, and its folder ${repoDir} is no git repo, so the host cannot cut the worker's own worktree there. Start the worker on a task that names its repo.`,
        };
      }
      return {
        decision: "deny",
        reason:
          `Task ${taskId} works in ${task.repo === null ? "the project's repo" : `the repo ${task.repo}`} at ${repoDir}, but this start is made from ${event.startFolder}, ` +
          `which is not inside it, so the host cannot cut the worker's own worktree from that repo. Change into ${repoDir}, then start the worker again with the same prompt.`,
      };
    }
  }
  const runId = store.appendRun(actorOf(event), { taskId, role: WORKER });
  return { decision: "allow", reason: `worker run ${runId} started on open task ${taskId}` };
}

/** The top of the git work tree holding `folder`, or null when it is in none. */
function gitTopOf(folder: string): string | null {
  const result = runGit(folder, ["rev-parse", "--show-toplevel"]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

function sameFolder(a: string | null, b: string): boolean {
  if (a === null) return false;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * An agent's start failed after the gate allowed it (trustmybot/tmb#285): the host made no
 * subagent, so no stop will come. The run its allowed start opened ends as stopped with no cost:
 * the newest open run of the role this host started, on the task the start prompt names for a
 * worker. Never denies.
 */
function startFailed(store: Store, event: TmbEvent, role: Role): Decision {
  const taskId = role === WORKER ? taskIdInPrompt(event.action) : null;
  if (role === WORKER && taskId === null) return { decision: "allow", reason: "a worker start whose prompt names no task failed; it opened no run" };
  const open = store
    .openRuns(role, taskId ?? undefined)
    .filter((run) => run.createdBy.kind === "agent" && run.createdBy.host === event.host && (role !== REVIEWER || run.taskId === null));
  const run = open.at(-1);
  const which = taskId === null ? "" : ` on task ${taskId}`;
  if (run === undefined) return { decision: "allow", reason: `a ${role} start${which} failed, and no ${role} run${which} was open to end` };
  store.endRun(actorOf(event), run.id, { outcome: STOPPED, cost: null });
  return { decision: "allow", reason: `${role} run ${run.id} ended, stopped: its start failed, so no ${role} ran` };
}

/** The reviewer may start on any change; its start is recorded as a run, which a review needs. */
function reviewerStart(store: Store, event: TmbEvent): Decision {
  const runId = store.appendRun(actorOf(event), { role: REVIEWER });
  return { decision: "allow", reason: `reviewer run ${runId} started` };
}

/**
 * Ends a worker's or the reviewer's run. Without a task to match on, it ends a run only when
 * exactly one run of the role is open: guessing among several would record a false end, and a
 * start left without an end is shown as a finding instead.
 */
function runStop(store: Store, event: TmbEvent, role: Role): Decision {
  // A stop ends only a run its own host started: another host's run is not this host's to end.
  const open = store.openRuns(role, event.task).filter((run) => run.createdBy.kind === "agent" && run.createdBy.host === event.host);
  if (open.length !== 1) {
    const which = event.task === undefined ? "" : ` on task ${event.task}`;
    const reason =
      open.length === 0 ? `no open ${role} run${which} to end` : `${open.length} ${role} runs are open and the stop names no task, so none was ended`;
    return { decision: "allow", reason };
  }
  const run = open[0]!;
  const outcome = outcomeOf(store, run);
  store.endRun(actorOf(event), run.id, { outcome, cost: event.cost ?? null });
  return { decision: "allow", reason: `${role} run ${run.id} ended, ${outcome}` };
}

/**
 * How a run ended (trustmybot/tmb#133): a worker finished when its task left the open state during
 * the run, to in review or closed, since a worker starts only on an open task; a reviewer finished
 * when it recorded a verdict during the run. Any other end is a stop.
 */
function outcomeOf(store: Store, run: Run): string {
  if (run.role === WORKER) {
    const task = run.taskId === null ? null : store.getTask(run.taskId);
    return task !== null && task.state !== OPEN ? FINISHED : STOPPED;
  }
  return store.listRunReviews(run.id).length > 0 ? FINISHED : STOPPED;
}

function deny(reason: string): Decision {
  return { decision: "deny", reason };
}

// --- file writes --------------------------------------------------------------------------

/**
 * The reviewer never edits (trustmybot/tmb#185): a write by the reviewer is denied by role, whether
 * the reviewer is a subagent or a host's main agent set up as the reviewer. Its agent file also takes
 * its edit tools away where the host allows that; this rule holds wherever the host names the
 * reviewer on its tool calls. A worker starts in its own worktree, where its host keeps its edits.
 */
function fileWriteRule(event: TmbEvent): Decision | null {
  if (event.role === REVIEWER) return deny("The reviewer judges a change and never edits one: report what you found in your verdict instead.");
  return null;
}

/** A worker named its task from a folder: tmb adopts the folder as the task's worktree when its host made it for the worker. Never denies. */
function workerInFolder(store: Store, event: TmbEvent): Decision {
  if (event.task === undefined) return { decision: "allow", reason: "the worker named no task, so no worktree was adopted" };
  return { decision: "allow", reason: adoptWorktree(store, actorOf(event), event.projectDir, event.task, event.action).reason };
}

function rule(store: Store, event: TmbEvent): Decision {
  if (event.role === UNNAMED_AGENT && event.type === "before-agent-start") {
    return { decision: "allow", reason: "finding: the host did not say which agent is starting, so tmb could not apply a role's rules to its start" };
  }
  if (event.role === WORKER && event.type === "before-agent-start") return workerStart(store, event);
  if (event.role === REVIEWER && event.type === "before-agent-start") return reviewerStart(store, event);
  if ((event.role === WORKER || event.role === REVIEWER) && event.type === "after-agent-stop") return runStop(store, event, event.role);
  if ((event.role === WORKER || event.role === REVIEWER) && event.type === "agent-start-failed") return startFailed(store, event, event.role);
  if (event.type === "before-file-write") return fileWriteRule(event) ?? { decision: "allow" };
  if (event.role === WORKER && event.type === "worker-in-folder") return workerInFolder(store, event);
  return { decision: "allow" };
}

/**
 * An agent's shell command: denied when it runs a step only the Human may take, whatever the
 * agent and whether or not the project has a record; the deny is recorded when the record can be
 * read. Any other command is allowed and not recorded, as tmb reads no other shell command.
 */
function shellCommand(event: TmbEvent): Decision {
  const step = humanOnlyInShell(event.action);
  if (step === null) return { decision: "allow" };
  const decision: Decision = { decision: "deny", reason: shellDenyReason(step) };
  const opened = openProjectStore(event.projectDir, { create: false });
  if (!opened.ok) return decision;
  try {
    const role = event.role === MAIN_AGENT ? hostRole(opened.store, event.host) : event.role;
    const recorded = { ...event, role };
    opened.store.appendGuardDecision(actorOf(recorded), { event: recordedEvent(recorded), decision: decision.decision, reason: decision.reason });
  } catch {
    // The deny stands whether or not it could be recorded.
  } finally {
    opened.store.close();
  }
  return decision;
}

/**
 * Allows or denies a host event. With no record in the project it allows and records
 * nothing; a record it cannot read, or one a newer tmb made, denies with the cause. With a
 * readable record each decision is recorded as a guard decision, together with the run it
 * starts or ends.
 */
export function decide(event: TmbEvent): Decision {
  if (event.type === "before-shell-command") return shellCommand(event);
  const opened = openProjectStore(event.projectDir, { create: false });
  if (!opened.ok) return opened.error.failure === "missing" ? { decision: "allow" } : unreadableRecord(opened.error);
  const store = opened.store;
  try {
    return store.transaction(() => {
      if (event.role === MAIN_AGENT) event = { ...event, role: hostRole(store, event.host) };
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
