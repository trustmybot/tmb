// The task flow: start a task on its own branch and worktree, brief it, and close it only
// after the checks pass on its committed work. Runs against a real git repository.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  featureStart,
  HandlerError,
  issueCreate,
  issueUpdate,
  normalizeSpecPath,
  pathsOverlap,
  shortTaskId,
  taskBrief,
  taskClose,
  taskIdInPrompt,
  taskList,
  taskStart,
} from "../src/engine/handlers/index.ts";
import { runCheck, runChecks } from "../src/engine/checks.ts";
import { newId } from "../src/engine/ids.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-a" };
const REVIEWER: Actor = { kind: "agent", role: "reviewer", host: "host-a" };

let project: string;
let store: Store;
let issueId: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-tasks-")));
  git(project, "init", "-q", "-b", "main");
  // The close's rebase commits through tmb's own git calls, which a CI runner gives no global identity.
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
  writeSetting(store, HUMAN, "review_mode", "agile");
  writeSetting(store, HUMAN, "checks", ["echo project check"]);
  issueId = issueCreate(store, HUMAN, { title: "The goal" }).id;
  featureStart(store, HUMAN, { name: FEATURE }, context());
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const FEATURE = "feat/goal";
const context = () => ({ projectDir: project });

function spec(fields: Record<string, unknown> = {}) {
  return { issue_id: issueId, kind: "code", intent: "Add the feature\n\nIn detail.", files: ["src/a"], criteria: ["SC1: it works"], ...fields };
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

async function asyncRefusal(call: () => Promise<unknown>): Promise<HandlerError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a HandlerError, but the call succeeded");
}

function branches(): string[] {
  return git(project, "branch", "--format=%(refname:short)").split("\n").sort();
}

function worktreeFolders(): string[] {
  const dir = path.join(project, ".tmb", "worktrees");
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Nothing of a refused start is left: no task, no branch, no worktree. */
function expectNothingWritten(): void {
  expect(taskList(store, HUMAN, {})).toEqual([]);
  expect(store.listTasks("closed")).toEqual([]);
  expect(branches()).toEqual([FEATURE, "main"]);
  expect(worktreeFolders()).toEqual([]);
  expect(git(project, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
}

/** Commits a file in the task's worktree, as a worker would. */
function commitWork(worktree: string, file = "src/a/work.ts"): string {
  mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  writeFileSync(path.join(worktree, file), "export const work = 1;\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-q", "-m", "work");
  return git(worktree, "rev-parse", "HEAD");
}

describe("task_start", () => {
  test("cuts tmb/<short id> from the feature branch tip into .tmb/worktrees and records the task", () => {
    const tip = git(project, "rev-parse", FEATURE);
    // The base branch moves on; the task still comes from the feature branch.
    git(project, "commit", "-q", "--allow-empty", "-m", "later on main");
    expect(git(project, "rev-parse", "main")).not.toBe(tip);
    const started = taskStart(store, PLANNER, spec({ checks: ["echo task check"] }), context());

    const short = shortTaskId(started.id);
    expect(short).toMatch(/^[0-9a-z]{8}$/);
    expect(started.branch).toBe(`tmb/${short}`);
    expect(started.worktree).toBe(path.join(project, ".tmb", "worktrees", short));
    expect(git(project, "rev-parse", started.branch)).toBe(tip);
    expect(git(started.worktree, "rev-parse", "HEAD")).toBe(tip);
    expect(git(started.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(started.branch);

    expect(store.getTask(started.id)).toMatchObject({
      issueId,
      title: "Add the feature",
      state: "open",
      branch: started.branch,
      worktree: started.worktree,
      baseCommit: tip,
      commitSha: null,
      featureId: store.findFeature(FEATURE)!.id,
      kind: "code",
      reviewMode: "agile",
      createdBy: PLANNER,
    });
    expect(started.brief).toMatchObject({
      id: started.id,
      branch: started.branch,
      worktree: started.worktree,
      feature: FEATURE,
      kind: "code",
      spec: { intent: "Add the feature\n\nIn detail.", files: ["src/a"], criteria: ["SC1: it works"], checks: ["echo task check"] },
      checks: ["echo project check", "echo task check"],
      startLine: `task_id=${started.id}`,
    });
    expect(store.history(started.id)[0]!.actor).toEqual(PLANNER);
  });

  test("lets the Human start a task and normalizes the files", () => {
    const started = taskStart(store, HUMAN, spec({ files: ["./src//a/", "src\\b", "src/a"] }), context());
    expect(started.brief.spec.files).toEqual(["src/a", "src/b"]);
  });

  test("refuses with no base branch set, saying tmb init has not run, and writes nothing", () => {
    const opened = openProjectStore(mkdtempSync(path.join(project, "fresh-")), { create: true });
    if (!opened.ok) throw opened.error;
    try {
      const id = issueCreate(opened.store, HUMAN, { title: "x" }).id;
      const error = refusal(() => taskStart(opened.store, PLANNER, spec({ issue_id: id }), context()));
      expect(error.code).toBe("refused");
      expect(error.message).toContain("no base branch is set");
      expect(error.message).toContain("tmb init");
      expect(opened.store.listTasks("open")).toEqual([]);
    } finally {
      opened.store.close();
    }
    expectNothingWritten();
  });

  test("refuses a closed issue and a missing one", () => {
    issueUpdate(store, HUMAN, { id: issueId, state: "closed" });
    expect(refusal(() => taskStart(store, PLANNER, spec(), context())).message).toContain("is closed");
    expect(refusal(() => taskStart(store, PLANNER, spec({ issue_id: newId() }), context())).code).toBe("not_found");
    expectNothingWritten();
  });

  test("refuses an incomplete spec, naming what is missing", () => {
    expect(refusal(() => taskStart(store, PLANNER, spec({ intent: " " }), context())).message).toContain("intent must be text that is not blank");
    expect(refusal(() => taskStart(store, PLANNER, spec({ files: [] }), context())).message).toContain("files must be a list of at least 1");
    expect(refusal(() => taskStart(store, PLANNER, spec({ criteria: [""] }), context())).message).toContain("criteria must be a list");
    const { criteria: _criteria, ...noCriteria } = spec();
    expect(refusal(() => taskStart(store, PLANNER, noCriteria, context())).message).toContain("needs criteria");
    expect(refusal(() => taskStart(store, PLANNER, spec({ files: ["../outside"] }), context())).message).toContain("must not leave the project");
    expect(refusal(() => taskStart(store, PLANNER, spec({ files: ["/etc/passwd"] }), context())).message).toContain("relative to its root");
    expectNothingWritten();
  });

  test("two open tasks may share a file; the start names the open tasks it shares one with, as information", () => {
    const first = taskStart(store, PLANNER, spec({ files: ["src/a/one.ts"] }), context());
    expect(first.sharedFiles).toEqual([]);
    for (const [file, count] of [["src", 1], ["src/a/one.ts", 2], [".", 3]] as const) {
      const started = taskStart(store, PLANNER, spec({ files: [file] }), context());
      expect(started.sharedFiles).toHaveLength(count);
      expect(started.sharedFiles[0]).toEqual({ task: first.id, title: first.brief.title, file, theirs: "src/a/one.ts" });
    }
    expect(taskStart(store, PLANNER, spec({ files: ["src/a/one.tsx", "src/b"] }), context()).sharedFiles.map((shared) => shared.task)).not.toContain(first.id);
    expect(taskList(store, HUMAN, {})).toHaveLength(5);
  });

  test("refuses the worker and the reviewer", () => {
    expect(refusal(() => taskStart(store, WORKER, spec(), context())).message).toContain("for the planner");
    expect(refusal(() => taskStart(store, REVIEWER, spec(), context())).code).toBe("refused");
    expectNothingWritten();
  });

  test("needs a kind, code or docs, and records it", () => {
    const { kind: _kind, ...noKind } = spec();
    expect(refusal(() => taskStart(store, PLANNER, noKind, context())).message).toContain("needs kind");
    const wrong = refusal(() => taskStart(store, PLANNER, spec({ kind: "tests" }), context()));
    expect(wrong.code).toBe("invalid_input");
    expect(wrong.message).toContain("kind must be one of code, docs");
    expectNothingWritten();

    const docs = taskStart(store, PLANNER, spec({ kind: "docs", files: ["docs"] }), context());
    expect(store.getTask(docs.id)!.kind).toBe("docs");
    expect(docs.brief.kind).toBe("docs");
  });

  test("with no feature named, uses the only open one, and refuses none or several, naming the fix", () => {
    const fresh = openProjectStore(mkdtempSync(path.join(project, "fresh-")), { create: true });
    if (!fresh.ok) throw fresh.error;
    try {
      writeSetting(fresh.store, HUMAN, "base_branch", "main");
      writeSetting(fresh.store, HUMAN, "review_mode", "agile");
      const id = issueCreate(fresh.store, HUMAN, { title: "x" }).id;
      const none = refusal(() => taskStart(fresh.store, PLANNER, spec({ issue_id: id }), context()));
      expect(none.code).toBe("refused");
      expect(none.message).toContain("no feature branch is open");
      expect(none.message).toContain("feature_start");
      expect(fresh.store.listTasks()).toEqual([]);
    } finally {
      fresh.store.close();
    }
    expectNothingWritten();

    featureStart(store, HUMAN, { name: "feat/other" }, context());
    const several = refusal(() => taskStart(store, PLANNER, spec(), context()));
    expect(several.message).toContain(`2 feature branches are open (${FEATURE}, feat/other)`);
    expect(several.message).toContain("name the one this task belongs to with feature");
    const unknown = refusal(() => taskStart(store, PLANNER, spec({ feature: "feat/nope" }), context()));
    expect(unknown.code).toBe("not_found");
    expect(unknown.message).toContain(`the open ones are ${FEATURE}, feat/other`);
    expect(taskList(store, HUMAN, {})).toEqual([]);

    git(project, "update-ref", "refs/heads/feat/other", git(project, "commit-tree", "-p", "main", "-m", "on other", `${git(project, "rev-parse", "main")}^{tree}`));
    const named = taskStart(store, PLANNER, spec({ feature: "feat/other" }), context());
    expect(named.brief.feature).toBe("feat/other");
    expect(store.getTask(named.id)!.baseCommit).toBe(git(project, "rev-parse", "feat/other"));
    expect(git(named.worktree, "rev-parse", "HEAD")).toBe(git(project, "rev-parse", "feat/other"));
  });

  test("a git failure writes nothing and says why", () => {
    const tip = git(project, "rev-parse", FEATURE);
    git(project, "branch", "-D", FEATURE);
    const noFeature = refusal(() => taskStart(store, PLANNER, spec(), context()));
    expect(noFeature.message).toContain(`cannot read the feature branch ${FEATURE}`);
    git(project, "branch", FEATURE, tip);
    expectNothingWritten();

    mkdirSync(path.join(project, ".tmb"), { recursive: true });
    writeFileSync(path.join(project, ".tmb", "worktrees"), "a file where the worktrees folder goes");
    const noWorktree = refusal(() => taskStart(store, PLANNER, spec(), context()));
    expect(noWorktree.message).toContain("git could not add the task's worktree");
    rmSync(path.join(project, ".tmb", "worktrees"));
    expectNothingWritten();
  });

  test("outside a git repository it refuses and writes nothing", () => {
    const plain = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-plain-")));
    try {
      const error = refusal(() => taskStart(store, PLANNER, spec(), { projectDir: plain }));
      expect(error.message).toContain(`cannot read the feature branch ${FEATURE}`);
      expect(existsSync(path.join(plain, ".tmb"))).toBe(false);
      expect(taskList(store, HUMAN, {})).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("a record that cannot be written after git ran removes the branch and worktree again", () => {
    const append = store.appendTask.bind(store);
    store.appendTask = () => {
      throw new Error("disk full");
    };
    try {
      expect(() => taskStart(store, PLANNER, spec(), context())).toThrow("disk full");
    } finally {
      store.appendTask = append;
    }
    expectNothingWritten();
  });
});

describe("task_brief and task_list", () => {
  test("the brief gives the spec, worktree, branch and checks; the list gives open tasks only", () => {
    const started = taskStart(store, PLANNER, spec(), context());
    expect(taskBrief(store, REVIEWER, { id: started.id.toLowerCase() })).toEqual(started.brief);
    expect(taskList(store, WORKER, {})).toEqual([
      {
        id: started.id,
        issueId,
        state: "open",
        title: "Add the feature",
        feature: FEATURE,
        kind: "code",
        branch: started.branch,
        worktree: started.worktree,
        commitSha: null,
        files: ["src/a"],
        prUrl: null,
        dropReason: null,
        replaces: null,
        repo: null,
      },
    ]);
    expect(refusal(() => taskBrief(store, HUMAN, { id: "01KA0000000000000000000000" })).code).toBe("not_found");
  });

  test("the list takes a state: open by default, closed, or all oldest first; any other is refused", async () => {
    const done = taskStart(store, PLANNER, spec(), context());
    const head = commitWork(done.worktree);
    await taskClose(store, WORKER, { id: done.id }, context());
    const open = taskStart(store, PLANNER, spec({ files: ["src/b"] }), context());

    const ids = (state?: string) => taskList(store, HUMAN, state === undefined ? {} : { state }).map((task) => task.id);
    expect(ids()).toEqual([open.id]);
    expect(ids("open")).toEqual([open.id]);
    expect(ids("closed")).toEqual([done.id]);
    expect(ids("all")).toEqual([done.id, open.id]);
    expect(taskList(store, HUMAN, { state: "closed" })[0]).toMatchObject({ state: "closed", commitSha: head });
    expect(refusal(() => taskList(store, HUMAN, { state: "done" })).code).toBe("invalid_input");
  });

  test("a task recorded without a task_start spec reads as its text, holding no files", () => {
    const id = store.appendTask(HUMAN, { issueId, title: "by hand", spec: "## Goal", state: "open" });
    expect(taskBrief(store, HUMAN, { id }).spec).toEqual({ intent: "## Goal", files: [], checks: [], criteria: [] });
    expect(taskStart(store, PLANNER, spec(), context()).id).not.toBe(id);
  });
});

describe("task_close", () => {
  test("refuses a dirty tree, then a tree with no new commit, and keeps the task open", async () => {
    const started = taskStart(store, PLANNER, spec(), context());
    writeFileSync(path.join(started.worktree, "stray.txt"), "not committed");
    const dirty = await asyncRefusal(() => taskClose(store, WORKER, { id: started.id }, context()));
    expect(dirty.message).toContain("not committed");
    expect(dirty.message).toContain("stray.txt");

    rmSync(path.join(started.worktree, "stray.txt"));
    const noCommit = await asyncRefusal(() => taskClose(store, WORKER, { id: started.id }, context()));
    expect(noCommit.message).toContain("no commit past the base commit");
    expect(store.getTask(started.id)!.state).toBe("open");
    expect(store.listCheckRuns(started.id)).toEqual([]);
  });

  test("refuses when no checks are set at all, never closing unchecked", async () => {
    writeSetting(store, HUMAN, "checks", []);
    const started = taskStart(store, PLANNER, spec(), context());
    commitWork(started.worktree);
    const error = await asyncRefusal(() => taskClose(store, WORKER, { id: started.id }, context()));
    expect(error.message).toContain("no checks are set");
    expect(store.getTask(started.id)!.state).toBe("open");
    expect(store.listCheckRuns(started.id)).toEqual([]);
  });

  test("runs the project's checks then the task's in the worktree, and closes with the commit when all pass", async () => {
    writeSetting(store, HUMAN, "checks", ["pwd"]);
    const started = taskStart(store, PLANNER, spec({ checks: ["test -f src/a/work.ts"] }), context());
    const head = commitWork(started.worktree);

    const closed = await taskClose(store, WORKER, { id: started.id }, context());
    expect(closed.checks.map((check) => [check.command, check.status, check.exitCode])).toEqual([
      ["pwd", "passed", 0],
      ["test -f src/a/work.ts", "passed", 0],
    ]);
    // The project folder is a real path, so pwd in the worktree prints the worktree's path as recorded.
    expect(closed.checks[0]!.outputTail.trim()).toBe(started.worktree);
    expect(store.getTask(started.id)).toMatchObject({ state: "closed", commitSha: head });
    expect(closed.brief).toMatchObject({ state: "closed", commitSha: head });
    expect(taskList(store, HUMAN, {})).toEqual([]);

    const [checkRun] = store.listCheckRuns(started.id);
    expect(checkRun).toMatchObject({ commitSha: head, result: "passed", createdBy: WORKER });
    expect(checkRun!.startedAt).toBeString();
    expect(checkRun!.endedAt).toBeString();
    expect(checkRun!.commands).toEqual(closed.checks);
    for (const check of closed.checks) {
      expect(check.startedAt).toBeString();
      expect(check.endedAt).toBeString();
    }

    const again = await asyncRefusal(() => taskClose(store, WORKER, { id: started.id }, context()));
    expect(again.message).toContain("is closed");
  });

  test("a failing check refuses with the command and its output tail, keeps the task open and records the run", async () => {
    writeSetting(store, HUMAN, "checks", ["echo first; echo boom-output >&2; exit 3", "echo never"]);
    const started = taskStart(store, PLANNER, spec(), context());
    const head = commitWork(started.worktree);

    const error = await asyncRefusal(() => taskClose(store, WORKER, { id: started.id }, context()));
    expect(error.code).toBe("refused");
    expect(error.message).toContain("`echo first; echo boom-output >&2; exit 3` exited 3");
    expect(error.message).toContain("boom-output");
    expect(error.message).toContain("stays open");
    expect(store.getTask(started.id)).toMatchObject({ state: "open", commitSha: null });

    const [checkRun] = store.listCheckRuns(started.id);
    expect(checkRun).toMatchObject({ commitSha: head, result: "failed" });
    expect(checkRun!.endedAt).toBeString();
    expect(checkRun!.commands).toMatchObject([
      { command: "echo first; echo boom-output >&2; exit 3", status: "failed", exitCode: 3 },
      { command: "echo never", status: "not_run", exitCode: null, reason: expect.stringContaining("did not pass") },
    ]);

    writeSetting(store, HUMAN, "checks", ["true"]);
    await taskClose(store, PLANNER, { id: started.id }, context());
    expect(store.getTask(started.id)!.state).toBe("closed");
    expect(store.listCheckRuns(started.id).map((run) => run.result)).toEqual(["failed", "passed"]);
  });

  test("a check past its time limit fails the close", async () => {
    writeSetting(store, HUMAN, "checks", ["sleep 5"]);
    const started = taskStart(store, PLANNER, spec(), context());
    commitWork(started.worktree);
    const error = await asyncRefusal(() => taskClose(store, WORKER, { id: started.id }, { projectDir: project, checkTimeoutMs: 200 }));
    expect(error.message).toContain("time limit");
    expect(store.listCheckRuns(started.id)[0]).toMatchObject({ result: "failed" });
  });

  test("refuses the reviewer and a task whose worktree is gone", async () => {
    const started = taskStart(store, PLANNER, spec(), context());
    expect((await asyncRefusal(() => taskClose(store, REVIEWER, { id: started.id }, context()))).message).toContain("for the worker or planner");
    rmSync(started.worktree, { recursive: true, force: true });
    expect((await asyncRefusal(() => taskClose(store, WORKER, { id: started.id }, context()))).message).toContain("is missing");
  });
});

describe("running checks", () => {
  test("a check that cannot start is recorded as not run, with the reason", async () => {
    const gone = path.join(project, "no-such-folder");
    const result = await runCheck("true", gone, 5_000);
    expect(result).toMatchObject({ command: "true", status: "not_run", exitCode: null, startedAt: null });
    expect(result.reason).toContain("could not start");
    expect(result.endedAt).toBeString();
  });

  test("keeps only the end of a long output", async () => {
    const [result] = await runChecks(["yes line | head -n 5000; echo the-end"], project, 5_000);
    expect(result!.status).toBe("passed");
    expect(result!.outputTail.length).toBeLessThanOrEqual(2000);
    expect(result!.outputTail.trimEnd()).toEndWith("the-end");
  });
});

describe("spec paths and the start line", () => {
  test("paths overlap when one is the other or a folder holding it", () => {
    expect(pathsOverlap("src", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap(".", "docs")).toBe(true);
    expect(pathsOverlap("src/a", "src/ab")).toBe(false);
    expect(normalizeSpecPath("./")).toBe(".");
  });

  test("finds task_id=<id> in a prompt, in any case, and nothing else", () => {
    const id = "01KA0000000000000000000000";
    expect(taskIdInPrompt(`Work on it.\ntask_id=${id}\n`)).toBe(id);
    expect(taskIdInPrompt(`task_id=${id.toLowerCase()}`)).toBe(id);
    expect(taskIdInPrompt(`task_id=${id}9`)).toBeNull();
    expect(taskIdInPrompt(`my_task_id=${id}`)).toBeNull();
    expect(taskIdInPrompt("task_id=42")).toBeNull();
  });
});
