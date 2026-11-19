// The gate's answer to a host event. Every host raises the same tmb events, and every rule
// is written against them here. A worker starts only on an open task with its worktree
// ready; a worker's and a reviewer's start and stop are recorded as a run. No agent turns
// git's pre-push hook off or opens a pull request by hand, a worker and the reviewer never
// push, a worker writes only in an open task's worktree and the reviewer writes nothing. A
// record tmb cannot read denies, so nothing runs unguarded in a project whose record is broken.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { toolCalls } from "./commands.ts";
import { OPEN } from "./handlers/common.ts";
import { taskIdInPrompt, taskStartLine, worktreeReady } from "./handlers/tasks.ts";
import { openProjectStore } from "./project.ts";
import { hostRole } from "./settings.ts";
import { type Actor, ROLES, type Role, type Store, type StoreOpenError } from "./store/index.ts";

export const TMB_EVENT_TYPES = ["session-start", "before-file-write", "before-command", "before-agent-start", "after-agent-stop"] as const;
export type TmbEventType = (typeof TMB_EVENT_TYPES)[number];

/**
 * The role an adapter gives an event from the host's main agent, which is not a subagent. The
 * engine reads the host's role in the record for it: the planner, unless setup named another.
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
const REVIEWER: Role = "reviewer";
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
  store.endRun(actorOf(event), open[0]!.id, { outcome: "stopped" });
  return { decision: "allow", reason: `${role} run ${open[0]!.id} ended` };
}

// --- commands -----------------------------------------------------------------------------

const PUSH_GATE = "git's pre-push hook is the push gate";

function deny(reason: string): Decision {
  return { decision: "deny", reason };
}

/** A command that turns git's hooks off, keeps a push from asking the gate, pushes from a subagent, or opens a pull request by hand. */
function commandRule(event: TmbEvent): Decision | null {
  const calls = toolCalls(event.action);
  // Only a command that runs git can change where git looks for its hooks; a search or a note that names the setting can run.
  if (calls.some((call) => call.tool === "git") && /core\.hookspath/i.test(event.action)) {
    return deny(`This command names core.hooksPath, and ${PUSH_GATE}: no agent changes where git looks for its hooks. Run the command without it.`);
  }
  for (const call of calls) {
    // An alias would run push (or push --no-verify) under a name the rules below do not read.
    if (call.tool === "git" && (call.config.some((value) => /^alias\./i.test(value)) || (call.subcommand === "config" && call.args.some((arg) => /^alias\./i.test(arg))))) {
      return deny("No agent defines a git alias: tmb reads each git command by its own name. Run the command it stands for instead.");
    }
    if (call.subcommand === null) {
      return deny(`tmb cannot tell which ${call.tool} subcommand this runs, because it is not written as plain text. Write the subcommand out, such as \`${call.tool} ${call.tool === "git" ? "status" : "pr view"}\`.`);
    }
    if (call.tool === "git" && call.subcommand === "push") {
      if (event.role === WORKER || event.role === REVIEWER) {
        return deny(`A ${event.role} never pushes: tmb pushes a task's work itself when the task closes (task_close).`);
      }
      if (call.args.includes("--no-verify")) return deny(`git push --no-verify skips the pre-push hook, and ${PUSH_GATE}. Push without --no-verify.`);
    }
    if (call.tool === "gh" && (call.subcommand === "pr create" || call.subcommand === "pr merge")) {
      return deny(
        call.subcommand === "pr create"
          ? "tmb opens a feature branch's pull request itself once the reviewer passed it or the Human waived the review: call feature_pr instead of gh pr create."
          : "The Human merges pull requests; no agent runs gh pr merge.",
      );
    }
  }
  return null;
}

// --- file writes --------------------------------------------------------------------------

/** The path with every link in its existing part resolved, so /tmp and /private/tmp compare equal. */
function canonical(file: string): string {
  let existing = path.resolve(file);
  const rest: string[] = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try {
    return path.join(realpathSync(existing), ...rest);
  } catch {
    return path.resolve(file);
  }
}

function inside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The reviewer writes nothing; a worker writes in the project only inside an open task's worktree. */
function fileWriteRule(store: Store, event: TmbEvent): Decision | null {
  if (event.role === REVIEWER) return deny("The reviewer judges a change and never edits one: report what you found in your verdict instead.");
  if (event.role !== WORKER) return null;
  const projectDir = canonical(event.projectDir);
  const file = canonical(path.resolve(event.projectDir, event.action));
  if (!inside(file, projectDir)) return null;
  const worktrees = store
    .listTasks(OPEN)
    .map((task) => task.worktree)
    .filter((worktree): worktree is string => worktree !== null)
    .map(canonical);
  if (worktrees.some((worktree) => inside(file, worktree))) return null;
  return deny(`A worker writes only inside its task's worktree, and ${event.action} is in no open task's worktree. Read the worktree from task_brief and write there.`);
}

function rule(store: Store, event: TmbEvent): Decision {
  if (event.role === UNNAMED_AGENT && event.type === "before-agent-start") {
    return { decision: "allow", reason: "finding: the host did not say which agent is starting, so tmb could not apply a role's rules to its start" };
  }
  if (event.role === WORKER && event.type === "before-agent-start") return workerStart(store, event);
  if (event.role === REVIEWER && event.type === "before-agent-start") return reviewerStart(store, event);
  if ((event.role === WORKER || event.role === REVIEWER) && event.type === "after-agent-stop") return runStop(store, event, event.role);
  if (event.type === "before-command") return commandRule(event) ?? { decision: "allow" };
  if (event.type === "before-file-write") return fileWriteRule(store, event) ?? { decision: "allow" };
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
