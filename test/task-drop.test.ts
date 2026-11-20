// Dropping a task (trustmybot/tmb#170): the planner or the Human ends a task without its work,
// with the reason; its worktree goes as a closed task's does unless it holds work, and a new
// task can name the one it replaces. Runs against a real git repository.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  featureBrief,
  featureStart,
  HandlerError,
  issueCreate,
  OPERATIONS,
  taskBrief,
  taskClose,
  taskDrop,
  taskList,
  taskStart,
} from "../src/engine/handlers/index.ts";
import { retryKeptCheckouts } from "../src/engine/handlers/fold.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import { sessionStartContext } from "../src/engine/session-start.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-a" };
const REVIEWER: Actor = { kind: "agent", role: "reviewer", host: "host-a" };
const FEATURE = "feat/goal";

let project: string;
let store: Store;
let issueId: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function setUp(mode: "agile" | "truest"): void {
  writeSetting(store, HUMAN, "review_mode", mode);
  if (mode === "agile") featureStart(store, HUMAN, { name: FEATURE }, context());
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-drop-")));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.name", "t");
  git(project, "config", "user.email", "t@example.com");
  writeFileSync(path.join(project, ".gitignore"), ".tmb/\n");
  writeFileSync(path.join(project, "README.md"), "hello\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "first");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  writeSetting(store, HUMAN, "base_branch", "main");
  writeSetting(store, HUMAN, "checks", ["echo project check"]);
  issueId = issueCreate(store, HUMAN, { title: "The goal" }).id;
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const context = () => ({ projectDir: project });

function spec(fields: Record<string, unknown> = {}) {
  return { issue_id: issueId, kind: "code", intent: "Add the feature", files: ["src/a"], criteria: ["SC1: it works"], ...fields };
}

function refusal(call: () => unknown): HandlerError {
  try {
    call();
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a HandlerError, but the call succeeded");
}

function branches(): string[] {
  return git(project, "branch", "--format=%(refname:short)").split("\n").sort();
}

function commitWork(worktree: string): string {
  mkdirSync(path.join(worktree, "src/a"), { recursive: true });
  writeFileSync(path.join(worktree, "src/a/work.ts"), "export const work = 1;\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-q", "-m", "work");
  return git(worktree, "rev-parse", "HEAD");
}

describe("task_drop", () => {
  beforeEach(() => setUp("agile"));

  test("the planner drops an open task with its reason; it is recorded as an event and its worktree and branch go", () => {
    const started = taskStart(store, PLANNER, spec(), context());
    const dropped = taskDrop(store, PLANNER, { id: started.id, reason: "  the approach is wrong  " }, context());

    expect(dropped.brief.state).toBe("dropped");
    expect(dropped.brief.dropReason).toBe("the approach is wrong");
    expect(dropped.cleanupProblems).toEqual([]);
    expect(dropped.keptBranch).toBeNull();
    expect(existsSync(started.worktree)).toBe(false);
    expect(branches()).toEqual([FEATURE, "main"]);
    // The main folder's copy from the task's start goes with it.
    expect(git(project, "for-each-ref", "--format=%(refname)", "refs/tmb")).toBe("");

    const last = store.history(started.id).at(-1)!;
    expect(last.type).toBe("updated");
    expect(last.data).toEqual({ state: "dropped", drop_reason: "the approach is wrong" });
    expect(last.actor).toEqual(PLANNER);
  });

  test("the Human may drop a task; a worker and the reviewer are refused", () => {
    const started = taskStart(store, PLANNER, spec(), context());
    expect(refusal(() => taskDrop(store, WORKER, { id: started.id, reason: "x" }, context())).message).toContain("task_drop is for the planner");
    expect(refusal(() => taskDrop(store, REVIEWER, { id: started.id, reason: "x" }, context())).code).toBe("refused");
    expect(store.getTask(started.id)!.state).toBe("open");
    expect(taskDrop(store, HUMAN, { id: started.id, reason: "nobody will finish it" }, context()).brief.state).toBe("dropped");
  });

  test("a reason is required, and only an open task or one in review is dropped", async () => {
    const started = taskStart(store, PLANNER, spec(), context());
    expect(refusal(() => taskDrop(store, PLANNER, { id: started.id }, context())).code).toBe("invalid_input");
    expect(refusal(() => taskDrop(store, PLANNER, { id: started.id, reason: "   " }, context())).code).toBe("invalid_input");
    expect(refusal(() => taskDrop(store, PLANNER, { id: "01KA0000000000000000000000", reason: "x" }, context())).code).toBe("not_found");

    taskDrop(store, PLANNER, { id: started.id, reason: "wrong" }, context());
    expect(refusal(() => taskDrop(store, PLANNER, { id: started.id, reason: "again" }, context())).message).toContain("is dropped; only an open task, one in review or a ready one is dropped");

    const closing = taskStart(store, PLANNER, spec(), context());
    commitWork(closing.worktree);
    await taskClose(store, WORKER, { id: closing.id }, context());
    expect(refusal(() => taskDrop(store, PLANNER, { id: closing.id, reason: "late" }, context())).message).toContain("is closed");
  });

  test("a branch that holds the task's commits is kept, and said so, while the worktree goes", () => {
    const started = taskStart(store, PLANNER, spec(), context());
    const commit = commitWork(started.worktree);
    const dropped = taskDrop(store, PLANNER, { id: started.id, reason: "wrong" }, context());

    expect(existsSync(started.worktree)).toBe(false);
    expect(git(project, "rev-parse", started.branch)).toBe(commit);
    expect(dropped.keptBranch).toContain(`git branch -D ${started.branch}`);
    // The feature branch does not take the dropped work.
    expect(git(project, "rev-parse", FEATURE)).not.toBe(commit);
  });

  test("a worktree holding work nobody committed is kept, by the rule for a closed task's", () => {
    const started = taskStart(store, PLANNER, spec(), context());
    writeFileSync(path.join(started.worktree, "notes.txt"), "half done\n");
    const dropped = taskDrop(store, PLANNER, { id: started.id, reason: "wrong" }, context());

    expect(dropped.brief.state).toBe("dropped");
    expect(existsSync(path.join(started.worktree, "notes.txt"))).toBe(true);
    expect(dropped.cleanupProblems[0]).toContain("holds files git does not ignore");

    // Once the file is gone, a session start with no task open removes what the dropped task kept.
    rmSync(path.join(started.worktree, "notes.txt"));
    sessionStartContext(project, false);
    expect(existsSync(started.worktree)).toBe(false);
    expect(branches()).toEqual([FEATURE, "main"]);
  });

  test("the retry at session start keeps a dropped task's branch while it holds commits", () => {
    const started = taskStart(store, PLANNER, spec(), context());
    commitWork(started.worktree);
    writeFileSync(path.join(started.worktree, "notes.txt"), "half done\n");
    taskDrop(store, PLANNER, { id: started.id, reason: "wrong" }, context());
    rmSync(path.join(started.worktree, "notes.txt"));

    expect(retryKeptCheckouts(project, store.listTasks("dropped"))).toEqual([`task ${started.id}: ${started.worktree}`]);
    expect(existsSync(started.worktree)).toBe(false);
    expect(branches()).toContain(started.branch);
  });

  test("a dropped task counts as ended: it is not open work, and the feature branch's review leaves it out", () => {
    const started = taskStart(store, PLANNER, spec(), context());
    commitWork(started.worktree);
    taskDrop(store, PLANNER, { id: started.id, reason: "wrong" }, context());

    expect(store.listTasks("open")).toEqual([]);
    expect(sessionStartContext(project, false)).not.toContain(started.id);
    const brief = featureBrief(store, HUMAN, { feature: FEATURE }, context());
    expect(brief.groups).toEqual([]);
  });

  test("the tool is published for the planner", () => {
    expect(OPERATIONS.task_drop.description).toContain("For the planner");
  });
});

describe("replaces", () => {
  beforeEach(() => setUp("agile"));

  test("a new task names the dropped task it replaces; both briefs show the link", () => {
    const old = taskStart(store, PLANNER, spec(), context());
    taskDrop(store, PLANNER, { id: old.id, reason: "the approach is wrong" }, context());
    const next = taskStart(store, PLANNER, spec({ replaces: old.id.toLowerCase() }), context());

    expect(next.brief.replaces).toBe(old.id);
    expect(taskBrief(store, HUMAN, { id: old.id }).replacedBy).toEqual([next.id]);
    expect(taskList(store, HUMAN, { state: "dropped" }).map((task) => [task.id, task.dropReason])).toEqual([[old.id, "the approach is wrong"]]);
    expect(taskList(store, HUMAN, {}).map((task) => [task.id, task.replaces])).toEqual([[next.id, old.id]]);
  });

  test("a task replaces only a dropped one, and nothing is started otherwise", () => {
    const open = taskStart(store, PLANNER, spec(), context());
    expect(refusal(() => taskStart(store, PLANNER, spec({ replaces: open.id }), context())).message).toContain(`task ${open.id} is open, not dropped`);
    expect(refusal(() => taskStart(store, PLANNER, spec({ replaces: "01KA0000000000000000000000" }), context())).code).toBe("not_found");
    expect(store.listTasks()).toHaveLength(1);
  });
});

describe("in truest mode", () => {
  beforeEach(() => setUp("truest"));

  test("a task in review is dropped; its worktree goes and its branch with the reviewed commit stays", async () => {
    const started = taskStart(store, PLANNER, spec(), context());
    const commit = commitWork(started.worktree);
    await taskClose(store, WORKER, { id: started.id }, context());
    expect(store.getTask(started.id)!.state).toBe("in_review");

    const dropped = taskDrop(store, PLANNER, { id: started.id, reason: "nobody will finish it" }, context());
    expect(dropped.brief.state).toBe("dropped");
    expect(existsSync(started.worktree)).toBe(false);
    expect(git(project, "rev-parse", started.branch)).toBe(commit);
    expect(store.listTasks("in_review")).toEqual([]);
  });
});
