// The task flow: the engine starts a task on its own branch and worktree, cut from its feature
// branch, briefs whoever works on it, and closes it only after the checks pass on its committed
// work, folding it into the feature branch and pushing that as a backup.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { type CheckCommandResult, CHECK_TIMEOUT_MS, overallResult, runChecks } from "../checks.ts";
import { gitFailure, runGit } from "../git.ts";
import { newId } from "../ids.ts";
import { DOCS_EXTENSIONS, DOCS_FILENAMES, isDocsFile } from "../docs-files.ts";
import { languageOf } from "../linguist/index.ts";
import { PROJECT_DIR_NAME } from "../project.ts";
import { repoChecks, repoDirOf, repoOfRow, resolveRepo } from "../repos.ts";
import { NO_REVIEW_MODE, readSettings } from "../settings.ts";
import { type Actor, type Feature, type Store, type Task, clip } from "../store/index.ts";
import { CLOSED, CLOSED_UNMERGED, DROPPED, IN_REVIEW, OPEN, type OperationContext, READY, requireRole, TASK_BRANCH_PREFIX, TRUEST } from "./common.ts";
import { workElsewhere } from "./adopt.ts";
import { HandlerError } from "./errors.ts";
import { baseBranchTip, featureForTask, featureTip, noBaseBranch } from "./features.ts";
import { type PushOutcome, backupPush, branchHoldsWork, isAncestor, moveFeature, rebaseOnto, removeTaskCheckout, undoRebase } from "./fold.ts";
import { type InputSchema, NOT_BLANK, RECORD_ID, validateInput } from "./input.ts";
import { dropMainFolderSnapshot, type MainFolderReport, mainFolderNotes, mainFolderReport, snapshotMainFolder } from "./main-folder.ts";
import { refreshLocalMerges } from "../pull-request-state.ts";
import { truestBase, truestClose, type TruestReview, truestReviewOf } from "./truest.ts";

export { type OperationContext, TASK_BRANCH_PREFIX } from "./common.ts";

export const WORKTREES_DIR = "worktrees";
const SHORT_ID_LENGTH = 8;
const DIRTY_LINES_SHOWN = 10;
/** The review mode a close records when the project has none set: agile is the default. */
const DEFAULT_REVIEW_MODE = "agile";

/** Who writes a task: a worker writes code, the planner writes docs. The planner names it at start. */
export const TASK_KINDS = ["code", "docs"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** What a task is to do. Paths are relative to the project, with `.` for the whole project. */
export type TaskSpec = { intent: string; files: string[]; checks: string[]; criteria: string[] };

export type TaskBrief = {
  id: string;
  issueId: string;
  state: string;
  title: string;
  branch: string | null;
  worktree: string | null;
  /** The feature branch the task was cut from and folds into; null for a task started before feature branches. */
  feature: string | null;
  /** The repo the task was cut in, by its name in the workspace; null in a single-repo project. */
  repo: string | null;
  kind: string | null;
  baseCommit: string | null;
  /** The commit the task folded into its feature branch at close; null while it is open. */
  commitSha: string | null;
  /** The review mode fixed at close; null while it is open. */
  reviewMode: string | null;
  /** How the feature branch's backup push went at close; null while it is open. */
  push: PushOutcome | null;
  spec: TaskSpec;
  /** Every check that runs at close, its repo's first (the project's in a single-repo project), then the task's own. */
  checks: string[];
  /** The line a worker's start prompt carries so the gate lets it start. */
  startLine: string;
  /** A truest task's review: its reviews, waivers and whether its commit is covered; absent in agile mode. */
  review?: TruestReview;
  /** Why the task was dropped; null unless it is. */
  dropReason: string | null;
  /** The dropped task this one replaces; null when it replaces none. */
  replaces: string | null;
  /** The tasks started to replace this one, oldest first. */
  replacedBy: string[];
};

export type TaskSummary = {
  id: string;
  issueId: string;
  state: string;
  title: string;
  feature: string | null;
  /** The repo the task was cut in; null in a single-repo project. */
  repo: string | null;
  kind: string | null;
  branch: string | null;
  worktree: string | null;
  /** The commit the task closed at, or a truest task waits for review at; null while it is open. */
  commitSha: string | null;
  files: string[];
  /** The pull request a truest task opened; null until then. */
  prUrl: string | null;
  /** Why the task was dropped; null unless it is. */
  dropReason: string | null;
  /** The dropped task this one replaces; null when it replaces none. */
  replaces: string | null;
};

/** How the closed task reached its feature branch: fast-forwarded, or rebased onto a tip that moved and checked again. */
export type FoldResult = { feature: string; from: string; to: string; rebased: boolean };

export type TaskCloseResult = {
  brief: TaskBrief;
  /** The check run on the commit that closed, and its commands' results. */
  checkRunId: string;
  checks: CheckCommandResult[];
  /** Every check run this close recorded, oldest first: two when a rebase made the checks run again. */
  checkRunIds: string[];
  /** Null for a task started before feature branches, which closes where it is. */
  fold: FoldResult | null;
  push: PushOutcome | null;
  /** What could not be cleaned up after the close; the task stays closed. */
  cleanupProblems: string[];
  /** What the cleanup dropped with the task's worktree: files git ignores, one line. */
  cleanedUp: string[];
  /** In truest mode, what comes next: the task waits in review at its commit. */
  next?: string;
  /** Files the task's commit touched outside its declared files, from git; the spec stays as the planner wrote it. */
  outsideSpec: string[];
  /** The main folder's uncommitted changes that differ from the task's start, each with how to put it back. */
  mainFolder: MainFolderReport;
  /** What the close says about the two above, one line each; empty when there is nothing to say. */
  notes: string[];
};

/** What a close found beyond its checks; it reports both and refuses neither. */
export type CloseFindings = Pick<TaskCloseResult, "outsideSpec" | "mainFolder" | "notes">;

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

export function requireTask(store: Store, id: string): Task {
  const task = store.getTask(id);
  if (!task) throw new HandlerError("not_found", `no task ${id} in the record`);
  return task;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The task's spec as task_start stored it; a task recorded another way reads as its text alone, holding no files. */
export function specOf(task: Task): TaskSpec {
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

/** A file a starting task shares with another open task: information for the planner, never a refusal. */
export type SharedFile = { task: string; title: string; file: string; theirs: string };

/**
 * The open tasks that hold one of these files. Two tasks may share a file: each works on its
 * own branch, git merges changes to different lines, and a clash on the same lines stops the
 * later merge, which reopens that task to settle it.
 */
function sharedFiles(store: Store, files: readonly string[], repo: string | null): SharedFile[] {
  const shared: SharedFile[] = [];
  // Paths are relative to a repo, so only tasks in the same repo can share one.
  for (const task of [...store.listTasks(OPEN), ...store.listTasks(IN_REVIEW)].filter((other) => other.repo === repo)) {
    for (const theirs of specOf(task).files) {
      const mine = files.find((file) => pathsOverlap(file, theirs));
      if (mine !== undefined) shared.push({ task: task.id, title: task.title, file: mine, theirs });
    }
  }
  return shared;
}

function requireOpenIssue(store: Store, issueId: string): void {
  const issue = store.getIssue(issueId);
  if (!issue) throw new HandlerError("not_found", `no issue ${issueId} in the record`);
  if (issue.state !== OPEN) throw new HandlerError("refused", `issue ${issueId} is closed; reopen it before starting a task on it`);
}

/** Refuses a `replaces` that names no dropped task: a task replaces one only once that one is dropped, with its reason. */
function requireDropped(store: Store, id: string): void {
  const old = store.getTask(id);
  if (!old) throw new HandlerError("not_found", `no task ${id} in the record, so the new task cannot replace it`);
  if (old.state !== DROPPED) {
    throw new HandlerError("refused", `task ${id} is ${old.state}, not dropped; drop it with task_drop and the reason first, then start the task that replaces it`);
  }
}

/** The folder of the repo a task was cut in. */
export function taskDir(store: Store, projectDir: string, task: Task): string {
  return repoOfRow(store, projectDir, task).dir;
}

function featureName(store: Store, task: Task): string | null {
  return task.featureId === null ? null : (store.getFeature(task.featureId)?.name ?? null);
}

function pushOf(task: Task): PushOutcome | null {
  return task.pushResult === null ? null : ({ result: task.pushResult, detail: task.pushDetail ?? "" } as PushOutcome);
}

export function briefOf(store: Store, task: Task): TaskBrief {
  const spec = specOf(task);
  return {
    id: task.id,
    issueId: task.issueId,
    state: task.state,
    title: task.title,
    branch: task.branch,
    worktree: task.worktree,
    feature: featureName(store, task),
    repo: task.repo,
    kind: task.kind,
    baseCommit: task.baseCommit,
    commitSha: task.commitSha,
    reviewMode: task.reviewMode,
    push: pushOf(task),
    spec,
    checks: [...repoChecks(store, task.repo), ...spec.checks],
    startLine: taskStartLine(task.id),
    ...(task.reviewMode === TRUEST ? { review: truestReviewOf(store, task) } : {}),
    dropReason: task.dropReason,
    replaces: task.replaces,
    replacedBy: store.listTasks().filter((other) => other.replaces === task.id).map((other) => other.id),
  };
}

// --- task_start ---------------------------------------------------------------------------

const TEXT_ITEM = { type: "string", pattern: NOT_BLANK } as const;

export const taskStartSchema: InputSchema = {
  type: "object",
  properties: {
    issue_id: { type: "string", description: "The id of the open issue the task serves.", pattern: RECORD_ID },
    kind: {
      type: "string",
      description: "code when the change touches code, which a worker writes; docs when it changes only docs or prompts and no behaviour, which the planner writes itself.",
      enum: TASK_KINDS,
    },
    feature: {
      type: "string",
      description: "The open feature branch to cut the task from and fold it into. Omit it when exactly one is open, and always in truest mode, which has no feature branches.",
      pattern: NOT_BLANK,
    },
    repo: {
      type: "string",
      description:
        "In a workspace of several repos, the repo the task works in, by its name in the workspace (settings_get lists them). In agile mode the task works in its feature branch's repo, so it may be omitted. Omit it in a project of one repo.",
      pattern: NOT_BLANK,
    },
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
    replaces: {
      type: "string",
      description: "The id of the dropped task this one replaces, when it takes up that task's work another way. Drop the old task with task_drop first.",
      pattern: RECORD_ID,
    },
  },
  required: ["issue_id", "kind", "intent", "files", "criteria"],
  additionalProperties: false,
};

/** sharedFiles names the open tasks that already hold one of this task's files, as information. */
export type TaskStartResult = { id: string; branch: string; worktree: string; brief: TaskBrief; sharedFiles: SharedFile[] };

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

/** The title a task is listed under: the intent's first line, cut short. */
function titleOf(intent: string): string {
  return clip(intent.trim().split("\n")[0]!);
}

export function taskStart(store: Store, actor: Actor, input: unknown, context: OperationContext): TaskStartResult {
  const request = validateInput<{
    issue_id: string;
    kind: TaskKind;
    feature?: string;
    repo?: string;
    intent: string;
    files: string[];
    criteria: string[];
    checks?: string[];
    replaces?: string;
  }>("task_start", taskStartSchema, input);
  requireRole(actor, "task_start", ["planner"]);
  const spec: TaskSpec = {
    intent: request.intent,
    files: [...new Set(request.files.map(normalizeSpecPath))],
    checks: (request.checks ?? []).map((check) => check.trim()),
    criteria: request.criteria,
  };
  requireOpenIssue(store, request.issue_id);
  if (request.replaces !== undefined) requireDropped(store, request.replaces);
  const settings = readSettings(store);
  // The review mode decides how many tokens the project uses, so no task starts until the Human chose it.
  const truest = settings.review_mode === TRUEST;
  if (truest && request.feature !== undefined) {
    const base = resolveRepo(store, context.projectDir, request.repo).baseBranch ?? "base branch";
    throw new HandlerError(
      "refused",
      `the project is in truest mode, which has no feature branches: each task is cut from the base branch ${base} and reaches it through its own pull request. Start the task without feature.`,
    );
  }
  let feature: Feature | null = null;
  let repo;
  if (truest || settings.review_mode === null) {
    repo = resolveRepo(store, context.projectDir, request.repo);
  } else {
    // The repo named, when it is registered, narrows which open feature branch is meant.
    const named = request.repo === undefined ? undefined : resolveRepo(store, context.projectDir, request.repo).name ?? undefined;
    // A ready branch the Human already merged locally is merged, and takes no task (trustmybot/tmb#183).
    refreshLocalMerges(store, actor, context.projectDir);
    feature = featureForTask(store, request.feature, named);
    repo = repoOfRow(store, context.projectDir, feature);
    if (named !== undefined && feature.repo !== named) {
      throw new HandlerError("refused", `the feature branch ${feature.name} is in the repo ${feature.repo ?? "(the project folder)"}, not ${named}; a task works in its feature branch's repo`);
    }
  }
  const baseBranch = repo.baseBranch;
  if (baseBranch === null) throw new HandlerError("refused", noBaseBranch(repo.name));
  if (settings.review_mode === null) throw new HandlerError("refused", NO_REVIEW_MODE);
  const dir = repo.dir;

  const id = newId();
  const branch = `${TASK_BRANCH_PREFIX}${shortTaskId(id)}`;
  const worktree = taskWorktreePath(context.projectDir, id);
  const baseCommit = feature === null ? truestBase(dir, baseBranch, `task ${id}`) : featureTip(dir, feature);
  addWorktree(dir, branch, worktree, baseCommit);
  const mainSnapshot = snapshotMainFolder(dir, id);
  let shared: SharedFile[] = [];
  try {
    store.transaction(() => {
      requireOpenIssue(store, request.issue_id);
      if (request.replaces !== undefined) requireDropped(store, request.replaces);
      shared = sharedFiles(store, spec.files, repo.name);
      // Rework on a branch whose pull request closed reopens it, so review and a new pull request run as before (trustmybot/tmb#152).
      // So does a fix task on a branch ready for a local merge: its tip will move, so it is not ready until covered again (trustmybot/tmb#183).
      if (feature !== null && (feature.state === CLOSED_UNMERGED || feature.state === READY)) store.updateFeature(actor, feature.id, { state: OPEN });
      store.appendTask(actor, {
        id,
        issueId: request.issue_id,
        title: titleOf(spec.intent),
        spec: JSON.stringify(spec),
        state: OPEN,
        branch,
        worktree,
        baseCommit,
        featureId: feature?.id ?? null,
        kind: request.kind,
        mainSnapshot,
        repo: repo.name,
        replaces: request.replaces ?? null,
      });
      // A task keeps the mode of its start, so a mode change cannot strand it halfway.
      store.updateTask(actor, id, { reviewMode: truest ? TRUEST : DEFAULT_REVIEW_MODE });
    });
  } catch (error) {
    removeWorktree(dir, branch, worktree);
    dropMainFolderSnapshot(dir, id);
    throw error;
  }
  return { id, branch, worktree, brief: briefOf(store, requireTask(store, id)), sharedFiles: shared };
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

export const TASK_LIST_STATES = [OPEN, IN_REVIEW, READY, CLOSED, DROPPED, "all"] as const;
export type TaskListState = (typeof TASK_LIST_STATES)[number];

export const taskListSchema: InputSchema = {
  type: "object",
  properties: {
    state: { type: "string", description: "Which tasks to list: open (the default), in_review (truest tasks waiting for the reviewer or their pull request), ready (truest tasks in a repo with no remote, waiting for the Human to merge them locally), closed, dropped or all.", enum: TASK_LIST_STATES },
  },
  required: [],
  additionalProperties: false,
};

export function taskList(store: Store, actor: Actor, input: unknown, context?: OperationContext): TaskSummary[] {
  const { state = OPEN } = validateInput<{ state?: TaskListState }>("task_list", taskListSchema, input);
  // A ready task the Human merged locally moves on first (trustmybot/tmb#183).
  if (context !== undefined) refreshLocalMerges(store, actor, context.projectDir);
  return store.listTasks(state === "all" ? undefined : state).map((task) => ({
    id: task.id,
    issueId: task.issueId,
    state: task.state,
    title: task.title,
    feature: featureName(store, task),
    repo: task.repo,
    kind: task.kind,
    branch: task.branch,
    worktree: task.worktree,
    commitSha: task.commitSha,
    files: specOf(task).files,
    prUrl: task.prUrl,
    dropReason: task.dropReason,
    replaces: task.replaces,
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
export function committedHead(task: Task, store: Store): string {
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
  if (head === base) {
    // A worker that committed in its host's folder before naming its task left its work there, unadopted.
    const elsewhere = workElsewhere(store, task);
    const where =
      elsewhere.length === 0
        ? "commit the work, then close again"
        : `commits that build on it sit in ${elsewhere.join(", ")}, which tmb did not adopt as the task's worktree; bring them into ${worktree} (for example git cherry-pick ${base}..<that folder's HEAD>), then close again`;
    throw new HandlerError("refused", `the task's worktree ${worktree} has no commit past the base commit ${base}; ${where}`);
  }
  if (!runGit(worktree, ["merge-base", "--is-ancestor", base, head]).ok) {
    throw new HandlerError("refused", `HEAD ${head} does not build on the task's base commit ${base}; the work must be committed on top of it`);
  }
  if (task.kind === "docs") refuseNonDocsFiles(task, base, head);
  return head;
}

/**
 * A docs task changes no code: refuses its close, naming each file, when its change from the base
 * commit touches a file whose type is not on the docs list (trustmybot/tmb#185). A type the list
 * does not name counts as code. Linguist's name for the file, when it knows one, is shown beside it.
 * A code task is never checked this way.
 */
function refuseNonDocsFiles(task: Task, base: string, head: string): void {
  const touched = gitIn(task.worktree!, ["diff", "--name-only", "--no-renames", "-z", base, head]).split("\0").filter((file) => file !== "");
  const refused = touched.flatMap((file) => {
    if (isDocsFile(file)) return [];
    const match = languageOf(file);
    return [match === null ? file : `${file} (${match.languages.join(" or ")})`];
  });
  if (refused.length === 0) return;
  const shown = refused.slice(0, DIRTY_LINES_SHOWN).join("\n");
  const more = refused.length > DIRTY_LINES_SHOWN ? `\n…and ${refused.length - DIRTY_LINES_SHOWN} more` : "";
  throw new HandlerError(
    "refused",
    `task ${task.id} is a docs task, but its change touches files that are not prose, data or images, so it stays open. A docs task may change ${DOCS_EXTENSIONS.join(" ")} files and files named ${DOCS_FILENAMES.join(", ")}; move the rest to a code task:\n${shown}${more}`,
  );
}

/**
 * Where the project folder sits below its repo's top, as git names it: "" at the top, else a
 * relative path with forward slashes that ends in a slash. A project may be one package of a
 * monorepo (trustmybot/tmb#178), and a task's worktree checks out the whole repo.
 */
export function projectPrefix(repoDir: string): string {
  const prefix = runGit(repoDir, ["rev-parse", "--show-prefix"]);
  return prefix.ok ? prefix.stdout.trim() : "";
}

/** The project folder inside a task's worktree: the worktree itself unless the project is below its repo's top. */
export function projectInWorktree(task: Task, repoDir: string): string {
  const prefix = projectPrefix(repoDir);
  return prefix === "" ? task.worktree! : path.join(task.worktree!, ...prefix.split("/").filter((part) => part !== ""));
}

/** The files the task's work changed from its base commit that none of its declared files covers, relative to the project as the spec's are. */
function filesOutsideSpec(task: Task, base: string, head: string, repoDir: string): string[] {
  const declared = specOf(task).files;
  const prefix = projectPrefix(repoDir);
  const touched = gitIn(task.worktree!, ["diff", "--name-only", "--no-renames", "-z", base, head]).split("\0").filter((file) => file !== "");
  // git names files from the repo's top; a file outside the project folder keeps its way out, with .., and no spec path covers it.
  const ofProject = touched.map((file) => (prefix === "" ? file : path.posix.relative(prefix, file)));
  return ofProject.filter((file) => file.startsWith("../") || !declared.some((mine) => pathsOverlap(file, mine)));
}

/**
 * What a close checks beyond the checks, on the task's own commit before any rebase: the files it
 * touched outside its declared ones, and the main folder against the task's start. Neither refuses:
 * a task often has good reason to touch one more file, and a clash with another task is found by
 * git when the work is merged (trustmybot/tmb#98).
 */
export function closeFindings(task: Task, head: string, projectDir: string): CloseFindings {
  const outsideSpec = task.baseCommit === null ? [] : filesOutsideSpec(task, task.baseCommit, head, projectDir);
  const mainFolder = mainFolderReport(projectDir, task.mainSnapshot);
  const notes = [
    ...(outsideSpec.length === 0 ? [] : [`The commit changed files outside the task's declared files, for the planner or the reviewer to check: ${outsideSpec.join(", ")}.`]),
    ...mainFolderNotes(mainFolder),
  ];
  return { outsideSpec, mainFolder, notes };
}

/** Once the close is recorded: lets go of the main folder's copy. The spec stays as the planner wrote it. */
export function recordFindings(task: Task, projectDir: string): void {
  dropMainFolderSnapshot(projectDir, task.id);
}

/** `onWhat` names the commit the checks ran on when it is not the worktree's own. */
function failureMessage(task: Task, results: readonly CheckCommandResult[], onWhat: string): string {
  const failed = results.find((result) => result.status !== "passed");
  if (!failed) return `the checks did not pass${onWhat}, so task ${task.id} stays open`;
  const how = failed.exitCode !== null ? `exited ${failed.exitCode}` : (failed.reason ?? "did not pass");
  const tail = failed.outputTail.trimEnd();
  return `\`${failed.command}\` ${how}${onWhat}, so task ${task.id} stays open.${tail === "" ? " It printed nothing." : `\nThe end of its output:\n${tail}`}`;
}

export type CheckRunOutcome = { id: string; results: CheckCommandResult[] };

/** Runs the checks on `commit`, checked out in the task's worktree, and records the run; refuses naming the failing command. */
export async function checkCommit(
  store: Store,
  actor: Actor,
  task: Task,
  commit: string,
  commands: string[],
  context: OperationContext,
  onWhat = "",
): Promise<CheckRunOutcome> {
  const checkRunId = store.appendCheckRun(actor, { taskId: task.id, commitSha: commit });
  let results: CheckCommandResult[];
  try {
    // The checks run in the project folder, which may be below the top of the worktree's repo.
    results = await runChecks(commands, projectInWorktree(task, repoDirOf(context.projectDir, task.repo)), context.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
  } catch (error) {
    const reason = `the checks could not run: ${error instanceof Error ? error.message : String(error)}`;
    store.endCheckRun(actor, checkRunId, { result: "not_run", commands: commands.map((command) => ({ command, status: "not_run", reason })) });
    throw error;
  }
  const result = overallResult(results);
  store.endCheckRun(actor, checkRunId, { result, commands: results });
  if (result !== "passed") throw new HandlerError("refused", failureMessage(task, results, onWhat));
  return { id: checkRunId, results };
}

export function requireHeadAt(worktree: string, commit: string): void {
  const now = runGit(worktree, ["rev-parse", "HEAD"]);
  if (!now.ok || now.stdout !== commit) {
    throw new HandlerError("refused", `the worktree's HEAD moved from ${commit} while the checks ran; close again to check the new commit`);
  }
}

/** After a refused close that had rebased the worktree, puts it back at its own commit and says so in the refusal. */
export function undoRebaseAndRethrow(error: unknown, worktree: string, rebased: string, original: string): never {
  const problem = undoRebase(worktree, rebased, original);
  if (error instanceof HandlerError) {
    throw new HandlerError(error.code, `${error.message}\n${problem ?? `The worktree is back at ${original}, as it was.`}`);
  }
  throw error;
}

export function closeResult(
  store: Store,
  id: string,
  runs: CheckRunOutcome[],
  rest: Pick<TaskCloseResult, "fold" | "push" | "cleanupProblems"> & Partial<Pick<TaskCloseResult, "cleanedUp">> & CloseFindings,
): TaskCloseResult {
  const last = runs[runs.length - 1]!;
  return { brief: briefOf(store, requireTask(store, id)), checkRunId: last.id, checks: last.results, checkRunIds: runs.map((run) => run.id), cleanedUp: [], ...rest };
}

/** Every check a task's close runs; refuses when there is none, since a task never closes unchecked. */
export function closeChecks(store: Store, task: Task): string[] {
  const commands = briefOf(store, task).checks;
  if (commands.length === 0) {
    throw new HandlerError(
      "refused",
      task.repo === null
        ? "no checks are set, neither the project's nor the task's, and a task never closes unchecked; add the project's with `tmb onboard --check <command>`"
        : `no checks are set, neither the repo ${task.repo}'s nor the task's, and a task never closes unchecked; add the repo's with \`tmb onboard --repo ${task.repo} --check <command>\``,
    );
  }
  return commands;
}

/**
 * Closes a task whose commit the feature branch already holds at its tip, folded by an earlier close that
 * stopped before it recorded the task closed: records the close, then cleans up and pushes as a fold does.
 */
function finishFold(
  store: Store,
  actor: Actor,
  task: Task,
  head: string,
  reviewMode: string,
  featureName: string,
  runs: CheckRunOutcome[],
  findings: CloseFindings,
  context: OperationContext,
): TaskCloseResult {
  const id = task.id;
  const worktree = task.worktree!;
  store.transaction(() => {
    if (requireTask(store, id).state !== OPEN) throw new HandlerError("refused", `task ${id} was closed while its checks ran`);
    requireHeadAt(worktree, head);
    store.updateTask(actor, id, { state: CLOSED, commitSha: head, reviewMode });
  });
  const dir = taskDir(store, context.projectDir, task);
  recordFindings(task, dir);
  const cleanup = task.branch === null ? { problems: [], dropped: [] } : removeTaskCheckout(dir, worktree, task.branch);
  const push = backupPush(store, dir, featureName, actor);
  store.updateTask(actor, id, { pushResult: push.result, pushDetail: push.detail });
  return closeResult(store, id, runs, { fold: { feature: featureName, from: head, to: head, rebased: false }, push, cleanupProblems: cleanup.problems, cleanedUp: cleanup.dropped, ...findings });
}

export async function taskClose(store: Store, actor: Actor, input: unknown, context: OperationContext): Promise<TaskCloseResult> {
  const { id } = validateInput<{ id: string }>("task_close", taskCloseSchema, input);
  requireRole(actor, "task_close", ["worker", "planner"]);
  const task = requireTask(store, id);
  if (task.state !== OPEN) throw new HandlerError("refused", `task ${id} is ${task.state}; only an open task closes`);
  if (!worktreeReady(task)) throw new HandlerError("refused", `task ${id}'s worktree ${task.worktree ?? "(none)"} is missing, so there is nothing to check`);
  const worktree = task.worktree!;

  if (task.reviewMode === TRUEST) return truestClose(store, actor, task, context);

  const dir = taskDir(store, context.projectDir, task);
  const head = committedHead(task, store);
  const commands = closeChecks(store, task);
  const runs = [await checkCommit(store, actor, task, head, commands, context)];
  // Before the fold, which can move the main folder's branch, and on the task's own commit, before any rebase.
  const findings = closeFindings(task, head, dir);
  // A task with no mode recorded was started before tasks kept one, when agile was the only mode.
  const reviewMode = task.reviewMode ?? DEFAULT_REVIEW_MODE;

  const feature = task.featureId === null ? null : store.getFeature(task.featureId);
  if (feature === null) {
    // A task started before feature branches has nothing to fold into: it closes where it is.
    store.transaction(() => {
      if (requireTask(store, id).state !== OPEN) throw new HandlerError("refused", `task ${id} was closed while its checks ran`);
      requireHeadAt(worktree, head);
      store.updateTask(actor, id, { state: CLOSED, commitSha: head, reviewMode });
    });
    recordFindings(task, dir);
    return closeResult(store, id, runs, { fold: null, push: null, cleanupProblems: [], ...findings });
  }

  // Fold: fast-forward the feature branch to the task's commit, rebasing it and checking it again first when the feature moved.
  requireHeadAt(worktree, head);
  const from = featureTip(dir, feature);
  const rebased = !isAncestor(worktree, from, head);
  // A fold that adds no commit would record the feature's tip, another task's commit, as this task's.
  const alreadyOnFeature = () =>
    new HandlerError("refused", `the task's work is already on the feature branch ${feature.name} at ${from}, so folding it would add no commit of the task's own, and task ${id} stays open`);
  if (head === from) {
    // The tip is this task's own commit when an earlier close moved the feature branch and stopped before
    // it recorded the task closed. Only another task recording the commit makes it not the task's own.
    if (store.listTasks().some((other) => other.id !== id && other.commitSha === head)) throw alreadyOnFeature();
    return finishFold(store, actor, task, head, reviewMode, feature.name, runs, findings, context);
  }
  let folded = head;
  if (rebased) {
    folded = rebaseOnto(worktree, feature.name, from, id);
    try {
      // git drops a commit whose change the tip already holds, so the rebase can leave nothing of the task's own.
      if (folded === from) throw alreadyOnFeature();
      runs.push(await checkCommit(store, actor, task, folded, commands, context, ` on the task rebased onto the feature branch ${feature.name} at ${from}`));
    } catch (error) {
      undoRebaseAndRethrow(error, worktree, folded, head);
    }
  }

  const moved: { undo?: () => void } = {};
  try {
    store.transaction(() => {
      if (requireTask(store, id).state !== OPEN) throw new HandlerError("refused", `task ${id} was closed while its checks ran`);
      requireHeadAt(worktree, folded);
      store.updateTask(actor, id, { state: CLOSED, commitSha: folded, reviewMode });
      // Last, so a refused move rolls the close back; undone below if the close cannot be written.
      moved.undo = moveFeature(dir, feature.name, from, folded, `tmb: fold task ${id} into ${feature.name}`);
    });
  } catch (error) {
    moved.undo?.();
    if (rebased) undoRebaseAndRethrow(error, worktree, folded, head);
    throw error;
  }

  recordFindings(task, dir);
  const cleanup = task.branch === null ? { problems: [], dropped: [] } : removeTaskCheckout(dir, worktree, task.branch);
  const push = backupPush(store, dir, feature.name, actor);
  store.updateTask(actor, id, { pushResult: push.result, pushDetail: push.detail });
  return closeResult(store, id, runs, { fold: { feature: feature.name, from, to: folded, rebased }, push, cleanupProblems: cleanup.problems, cleanedUp: cleanup.dropped, ...findings });
}

// --- task_drop ----------------------------------------------------------------------------

export const taskDropSchema: InputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The task's id.", pattern: RECORD_ID },
    reason: { type: "string", description: "Why the task is dropped: the approach is wrong, or nobody will finish it.", pattern: NOT_BLANK },
  },
  required: ["id", "reason"],
  additionalProperties: false,
};

export type TaskDropResult = {
  brief: TaskBrief;
  /** What could not be cleaned up; the task stays dropped. */
  cleanupProblems: string[];
  /** What the cleanup dropped with the task's worktree: files git ignores, one line. */
  cleanedUp: string[];
  /** The branch kept because it holds the task's commits, with how to delete it; null when none was kept. */
  keptBranch: string | null;
};

/**
 * Ends an open task, or a truest task in review or ready, without its work, with the reason. The task's
 * worktree goes as a closed task's does, unless it holds work nobody committed; its branch stays
 * while it holds commits past the task's base, so nothing committed is lost.
 */
export function taskDrop(store: Store, actor: Actor, input: unknown, context: OperationContext): TaskDropResult {
  const { id, reason } = validateInput<{ id: string; reason: string }>("task_drop", taskDropSchema, input);
  requireRole(actor, "task_drop", ["planner"]);
  store.transaction(() => {
    const task = requireTask(store, id);
    // A ready task the Human will not merge as it is (a squash, say, which tmb cannot see) is ended here too (trustmybot/tmb#183).
    if (task.state !== OPEN && task.state !== IN_REVIEW && task.state !== READY) {
      throw new HandlerError("refused", `task ${id} is ${task.state}; only an open task, one in review or a ready one is dropped`);
    }
    store.updateTask(actor, id, { state: DROPPED, dropReason: reason.trim() });
  });
  const task = requireTask(store, id);
  const dir = taskDir(store, context.projectDir, task);
  dropMainFolderSnapshot(dir, id);
  const holdsWork = branchHoldsWork(dir, task);
  const keptBranch = holdsWork
    ? `the branch ${task.branch} was kept: it holds the dropped task's commits. Delete it once nothing there is needed: git branch -D ${task.branch}`
    : null;
  const cleanup = task.worktree === null ? { problems: [], dropped: [] } : removeTaskCheckout(dir, task.worktree, holdsWork ? null : task.branch);
  return { brief: briefOf(store, task), cleanupProblems: cleanup.problems, cleanedUp: cleanup.dropped, keptBranch };
}
