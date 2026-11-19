// The task flow: the engine starts a task on its own branch and worktree, briefs whoever
// works on it, and closes it only after the checks pass on its committed work.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { type CheckCommandResult, CHECK_TIMEOUT_MS, overallResult, runChecks } from "../checks.ts";
import { gitFailure, runGit } from "../git.ts";
import { newId } from "../ids.ts";
import { PROJECT_DIR_NAME } from "../project.ts";
import { readSettings } from "../settings.ts";
import { type Actor, type Role, type Store, type Task, clip } from "../store/index.ts";
import { HandlerError } from "./errors.ts";
import { type InputSchema, NOT_BLANK, RECORD_ID, validateInput } from "./input.ts";

/** Where an operation runs: the project's folder, and how long each check may take. */
export type OperationContext = { projectDir: string; checkTimeoutMs?: number };

export const TASK_BRANCH_PREFIX = "tmb/";
export const WORKTREES_DIR = "worktrees";
const SHORT_ID_LENGTH = 8;
const DIRTY_LINES_SHOWN = 10;
const OPEN = "open";
const CLOSED = "closed";

/** What a task is to do. Paths are relative to the project, with `.` for the whole project. */
export type TaskSpec = { intent: string; files: string[]; checks: string[]; criteria: string[] };

export type TaskBrief = {
  id: string;
  issueId: string;
  state: string;
  title: string;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  commitSha: string | null;
  spec: TaskSpec;
  /** Every check that runs at close, the project's first, then the task's own. */
  checks: string[];
  /** The line a worker's start prompt carries so the gate lets it start. */
  startLine: string;
};

export type TaskSummary = {
  id: string;
  issueId: string;
  state: string;
  title: string;
  branch: string | null;
  worktree: string | null;
  /** The commit the task closed at; null while it is open. */
  commitSha: string | null;
  files: string[];
};

export type TaskCloseResult = { brief: TaskBrief; checkRunId: string; checks: CheckCommandResult[] };

/** The line that names a task to the gate when a worker starts on it. */
export function taskStartLine(id: string): string {
  return `task_id=${id}`;
}

/** The task id in a worker's start prompt, upper case, or null when it names none. */
export function taskIdInPrompt(prompt: string): string | null {
  const match = /(?<![0-9A-Za-z_])task_id=([0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25})(?![0-9A-Za-z])/u.exec(prompt);
  return match ? match[1]!.toUpperCase() : null;
}

/** The short form of a task id that names its branch and worktree: the id's random end, lower case. */
export function shortTaskId(id: string): string {
  return id.slice(-SHORT_ID_LENGTH).toLowerCase();
}

export function taskWorktreePath(projectDir: string, id: string): string {
  return path.join(projectDir, PROJECT_DIR_NAME, WORKTREES_DIR, shortTaskId(id));
}

function isDirectory(dir: string): boolean {
  return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** Whether the task is open and its worktree is on disk, so a worker can start on it. */
export function worktreeReady(task: Task): boolean {
  return task.state === OPEN && task.worktree !== null && isDirectory(task.worktree);
}

function requireRole(actor: Actor, operation: string, roles: readonly Role[]): void {
  if (actor.kind === "agent" && !roles.includes(actor.role)) {
    throw new HandlerError("refused", `${operation} is for the ${roles.join(" or ")}, not the ${actor.role}`);
  }
}

function requireTask(store: Store, id: string): Task {
  const task = store.getTask(id);
  if (!task) throw new HandlerError("not_found", `no task ${id} in the record`);
  return task;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The task's spec as task_start stored it; a task recorded another way reads as its text alone, holding no files. */
function specOf(task: Task): TaskSpec {
  let stored: unknown;
  try {
    stored = JSON.parse(task.spec);
  } catch {
    stored = null;
  }
  const fields = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    intent: typeof fields.intent === "string" ? fields.intent : task.spec,
    files: textList(fields.files),
    checks: textList(fields.checks),
    criteria: textList(fields.criteria),
  };
}

/**
 * A spec path as the overlap check compares it: relative to the project, with forward
 * slashes and no `.` parts; `.` stands for the whole project. Refuses a path that leaves it.
 */
export function normalizeSpecPath(raw: string): string {
  const text = raw.trim().replace(/\\/g, "/");
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) {
    throw new HandlerError("invalid_input", `files must be paths inside the project, relative to its root, got ${JSON.stringify(raw)}`);
  }
  const parts = text.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new HandlerError("invalid_input", `files must not leave the project with .., got ${JSON.stringify(raw)}`);
  return parts.length === 0 ? "." : parts.join("/");
}

/** Two spec paths overlap when one is the other or a folder holding it. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === "." || b === "." || a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Refuses files that an open task already holds, naming that task and the paths. */
function refuseOverlap(store: Store, files: readonly string[]): void {
  for (const task of store.listTasks(OPEN)) {
    for (const theirs of specOf(task).files) {
      const mine = files.find((file) => pathsOverlap(file, theirs));
      if (mine !== undefined) {
        throw new HandlerError(
          "refused",
          `${mine} overlaps ${theirs} of open task ${task.id} (${task.title}); two open tasks never share a file. Close that task first, or start this one on other files.`,
        );
      }
    }
  }
}

function requireOpenIssue(store: Store, issueId: string): void {
  const issue = store.getIssue(issueId);
  if (!issue) throw new HandlerError("not_found", `no issue ${issueId} in the record`);
  if (issue.state !== OPEN) throw new HandlerError("refused", `issue ${issueId} is closed; reopen it before starting a task on it`);
}

function projectChecks(store: Store): string[] {
  return readSettings(store).checks ?? [];
}

function briefOf(store: Store, task: Task): TaskBrief {
  const spec = specOf(task);
  return {
    id: task.id,
    issueId: task.issueId,
    state: task.state,
    title: task.title,
    branch: task.branch,
    worktree: task.worktree,
    baseCommit: task.baseCommit,
    commitSha: task.commitSha,
    spec,
    checks: [...projectChecks(store), ...spec.checks],
    startLine: taskStartLine(task.id),
  };
}

// --- task_start ---------------------------------------------------------------------------

const TEXT_ITEM = { type: "string", pattern: NOT_BLANK } as const;

export const taskStartSchema: InputSchema = {
  type: "object",
  properties: {
    issue_id: { type: "string", description: "The id of the open issue the task serves.", pattern: RECORD_ID },
    intent: { type: "string", description: "What the task is to change and why, in full.", pattern: NOT_BLANK },
    files: {
      type: "array",
      description: "The files and folders the task may touch, relative to the project root; no open task may hold any of them.",
      items: TEXT_ITEM,
      minItems: 1,
    },
    criteria: { type: "array", description: "The success criteria the work is judged against, one per item.", items: TEXT_ITEM, minItems: 1 },
    checks: {
      type: "array",
      description: "Shell commands this task adds to the project's checks; all must pass before it closes.",
      items: TEXT_ITEM,
    },
  },
  required: ["issue_id", "intent", "files", "criteria"],
  additionalProperties: false,
};

export type TaskStartResult = { id: string; branch: string; worktree: string; brief: TaskBrief };

/** Cuts the task's branch from `baseCommit` into a new worktree; on failure removes what it made and says why. */
function addWorktree(projectDir: string, branch: string, worktree: string, baseCommit: string): void {
  if (runGit(projectDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    throw new HandlerError("refused", `branch ${branch} already exists; remove it or start the task again for a new id`);
  }
  if (existsSync(worktree)) throw new HandlerError("refused", `${worktree} already exists; move it away and start the task again`);
  const added = runGit(projectDir, ["worktree", "add", "-b", branch, worktree, baseCommit]);
  if (!added.ok) {
    removeWorktree(projectDir, branch, worktree);
    throw new HandlerError("refused", `git could not add the task's worktree, so nothing was recorded: ${gitFailure(added)}`);
  }
}

/** Undoes addWorktree as far as it got. */
function removeWorktree(projectDir: string, branch: string, worktree: string): void {
  runGit(projectDir, ["worktree", "remove", "--force", worktree]);
  runGit(projectDir, ["worktree", "prune"]);
  runGit(projectDir, ["branch", "-D", branch]);
}

function baseCommitOf(projectDir: string, baseBranch: string): string {
  // A leading dash would reach git as an option, and no branch name starts with one.
  if (baseBranch.startsWith("-")) throw new HandlerError("refused", `the base branch ${baseBranch} is not a branch name; set another with \`tmb setup --base <branch>\``);
  const resolved = runGit(projectDir, ["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]);
  if (!resolved.ok) {
    const why = resolved.stderr === "" ? `it names no commit in the git repository at ${projectDir}` : gitFailure(resolved);
    throw new HandlerError("refused", `cannot cut a task branch from the base branch ${baseBranch}: ${why}`);
  }
  return resolved.stdout;
}

/** The title a task is listed under: the intent's first line, cut short. */
function titleOf(intent: string): string {
  return clip(intent.trim().split("\n")[0]!);
}

export function taskStart(store: Store, actor: Actor, input: unknown, context: OperationContext): TaskStartResult {
  const request = validateInput<{ issue_id: string; intent: string; files: string[]; criteria: string[]; checks?: string[] }>(
    "task_start",
    taskStartSchema,
    input,
  );
  requireRole(actor, "task_start", ["planner"]);
  const spec: TaskSpec = {
    intent: request.intent,
    files: [...new Set(request.files.map(normalizeSpecPath))],
    checks: (request.checks ?? []).map((check) => check.trim()),
    criteria: request.criteria,
  };
  requireOpenIssue(store, request.issue_id);
  const baseBranch = readSettings(store).base_branch;
  if (baseBranch === null) throw new HandlerError("refused", "no base branch is set, so setup has not run here; run `tmb setup` in the project first");
  refuseOverlap(store, spec.files);

  const id = newId();
  const branch = `${TASK_BRANCH_PREFIX}${shortTaskId(id)}`;
  const worktree = taskWorktreePath(context.projectDir, id);
  const baseCommit = baseCommitOf(context.projectDir, baseBranch);
  addWorktree(context.projectDir, branch, worktree, baseCommit);
  try {
    // Checked again inside the write, so two starts at once cannot both take the same files.
    store.transaction(() => {
      requireOpenIssue(store, request.issue_id);
      refuseOverlap(store, spec.files);
      store.appendTask(actor, {
        id,
        issueId: request.issue_id,
        title: titleOf(spec.intent),
        spec: JSON.stringify(spec),
        state: OPEN,
        branch,
        worktree,
        baseCommit,
      });
    });
  } catch (error) {
    removeWorktree(context.projectDir, branch, worktree);
    throw error;
  }
  return { id, branch, worktree, brief: briefOf(store, requireTask(store, id)) };
}

// --- task_brief ---------------------------------------------------------------------------

export const taskBriefSchema: InputSchema = {
  type: "object",
  properties: { id: { type: "string", description: "The task's id.", pattern: RECORD_ID } },
  required: ["id"],
  additionalProperties: false,
};

export function taskBrief(store: Store, _actor: Actor, input: unknown): TaskBrief {
  const { id } = validateInput<{ id: string }>("task_brief", taskBriefSchema, input);
  return briefOf(store, requireTask(store, id));
}

// --- task_list ----------------------------------------------------------------------------

export const TASK_LIST_STATES = [OPEN, CLOSED, "all"] as const;
export type TaskListState = (typeof TASK_LIST_STATES)[number];

export const taskListSchema: InputSchema = {
  type: "object",
  properties: {
    state: { type: "string", description: "Which tasks to list: open (the default), closed or all.", enum: TASK_LIST_STATES },
  },
  required: [],
  additionalProperties: false,
};

export function taskList(store: Store, _actor: Actor, input: unknown): TaskSummary[] {
  const { state = OPEN } = validateInput<{ state?: TaskListState }>("task_list", taskListSchema, input);
  return store.listTasks(state === "all" ? undefined : state).map((task) => ({
    id: task.id,
    issueId: task.issueId,
    state: task.state,
    title: task.title,
    branch: task.branch,
    worktree: task.worktree,
    commitSha: task.commitSha,
    files: specOf(task).files,
  }));
}

// --- task_close ---------------------------------------------------------------------------

export const taskCloseSchema: InputSchema = {
  type: "object",
  properties: { id: { type: "string", description: "The task's id.", pattern: RECORD_ID } },
  required: ["id"],
  additionalProperties: false,
};

function gitIn(worktree: string, args: readonly string[]): string {
  const result = runGit(worktree, args);
  if (!result.ok) throw new HandlerError("refused", `git could not read the worktree ${worktree}: ${gitFailure(result)}`);
  return result.stdout;
}

/** The worktree's HEAD, once the tree is clean and HEAD is at least one commit past the base it was cut from. */
function committedHead(task: Task): string {
  const worktree = task.worktree!;
  const changes = gitIn(worktree, ["status", "--porcelain"]);
  if (changes !== "") {
    const lines = changes.split("\n");
    const shown = lines.slice(0, DIRTY_LINES_SHOWN).join("\n");
    const more = lines.length > DIRTY_LINES_SHOWN ? `\n…and ${lines.length - DIRTY_LINES_SHOWN} more` : "";
    throw new HandlerError("refused", `the worktree has changes that are not committed; commit or remove them, then close again:\n${shown}${more}`);
  }
  const head = gitIn(worktree, ["rev-parse", "HEAD"]);
  const base = task.baseCommit;
  if (base === null) throw new HandlerError("refused", `task ${task.id} records no base commit, so tmb cannot tell its new work; start it again with task_start`);
  if (head === base) throw new HandlerError("refused", `the worktree has no commit past the base commit ${base}; commit the work, then close again`);
  if (!runGit(worktree, ["merge-base", "--is-ancestor", base, head]).ok) {
    throw new HandlerError("refused", `HEAD ${head} does not build on the task's base commit ${base}; the work must be committed on top of it`);
  }
  return head;
}

function failureMessage(task: Task, results: readonly CheckCommandResult[]): string {
  const failed = results.find((result) => result.status !== "passed");
  if (!failed) return `the checks did not pass, so task ${task.id} stays open`;
  const how = failed.exitCode !== null ? `exited ${failed.exitCode}` : (failed.reason ?? "did not pass");
  const tail = failed.outputTail.trimEnd();
  return `\`${failed.command}\` ${how}, so task ${task.id} stays open.${tail === "" ? " It printed nothing." : `\nThe end of its output:\n${tail}`}`;
}

export async function taskClose(store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<TaskCloseResult> {
  const { id } = validateInput<{ id: string }>("task_close", taskCloseSchema, input);
  requireRole(actor, "task_close", ["worker", "planner"]);
  const task = requireTask(store, id);
  if (task.state !== OPEN) throw new HandlerError("refused", `task ${id} is ${task.state}; only an open task closes`);
  if (!worktreeReady(task)) throw new HandlerError("refused", `task ${id}'s worktree ${task.worktree ?? "(none)"} is missing, so there is nothing to check`);

  const head = committedHead(task);
  const commands = briefOf(store, task).checks;
  if (commands.length === 0) {
    throw new HandlerError(
      "refused",
      "no checks are set, neither the project's nor the task's, and a task never closes unchecked; add the project's with `tmb setup --check <command>`",
    );
  }

  const checkRunId = store.appendCheckRun(actor, { taskId: id, commitSha: head });
  let results: CheckCommandResult[];
  try {
    results = await runChecks(commands, task.worktree!, context.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
  } catch (error) {
    const reason = `the checks could not run: ${error instanceof Error ? error.message : String(error)}`;
    store.endCheckRun(actor, checkRunId, { result: "not_run", commands: commands.map((command) => ({ command, status: "not_run", reason })) });
    throw error;
  }
  const result = overallResult(results);
  store.endCheckRun(actor, checkRunId, { result, commands: results });
  if (result !== "passed") throw new HandlerError("refused", failureMessage(task, results));

  store.transaction(() => {
    const current = requireTask(store, id);
    if (current.state !== OPEN) throw new HandlerError("refused", `task ${id} was closed while its checks ran`);
    const now = runGit(task.worktree!, ["rev-parse", "HEAD"]);
    if (!now.ok || now.stdout !== head) {
      throw new HandlerError("refused", `the worktree's HEAD moved from ${head} while the checks ran; close again to check the new commit`);
    }
    store.updateTask(actor, id, { state: CLOSED, commitSha: head });
  });
  return { brief: briefOf(store, requireTask(store, id)), checkRunId, checks: results };
}
