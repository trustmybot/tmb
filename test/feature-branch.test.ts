// Feature branches: feature_start cuts one from the base branch, and a task's close folds the
// task into it, rebasing and checking again when it moved, then pushes it to origin as a
// backup. Runs against real git repositories in a temporary folder.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  featureList,
  featureStart,
  HandlerError,
  issueCreate,
  type TaskCloseResult,
  taskClose,
  taskStart,
} from "../src/engine/handlers/index.ts";
import { adoptWorktree } from "../src/engine/handlers/adopt.ts";
import { moveFeature, retryKeptCheckouts } from "../src/engine/handlers/fold.ts";
import { sessionStartContext } from "../src/engine/session-start.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-a" };
const REVIEWER: Actor = { kind: "agent", role: "reviewer", host: "host-a" };
const FEATURE = "feat/goal";

let scratch: string;
let project: string;
let store: Store;
let issueId: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-feature-")));
  project = path.join(scratch, "project");
  mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  // The engine's rebase makes commits, so the repository needs an identity of its own.
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
  writeSetting(store, HUMAN, "checks", ["true"]);
  issueId = issueCreate(store, HUMAN, { title: "The goal" }).id;
});

afterEach(() => {
  store.close();
  rmSync(scratch, { recursive: true, force: true });
});

const context = () => ({ projectDir: project });

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

function startTask(files: string[], fields: Record<string, unknown> = {}) {
  return taskStart(store, PLANNER, { issue_id: issueId, kind: "code", intent: `Change ${files.join(", ")}`, files, criteria: ["SC1"], ...fields }, context());
}

/** Writes `text` to `file` in the worktree and commits it, as a worker would; returns the commit. */
function commitFile(worktree: string, file: string, text = `${file}\n`): string {
  mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  writeFileSync(path.join(worktree, file), text);
  git(worktree, "add", ".");
  git(worktree, "commit", "-q", "-m", `write ${file}`);
  return git(worktree, "rev-parse", "HEAD");
}

function tip(): string {
  return git(project, "rev-parse", FEATURE);
}

describe("feature_start", () => {
  test("cuts the branch from the base branch's latest commit, checks it out nowhere and records it", () => {
    git(project, "commit", "-q", "--allow-empty", "-m", "latest on main");
    const main = git(project, "rev-parse", "main");
    const started = featureStart(store, PLANNER, { name: FEATURE }, context());

    expect(started).toMatchObject({ name: FEATURE, baseBranch: "main", baseCommit: main, state: "open", tasks: [], repo: null });
    expect(tip()).toBe(main);
    expect(git(project, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(project, "worktree", "list", "--porcelain")).not.toContain(`refs/heads/${FEATURE}`);
    expect(store.findFeature(FEATURE)).toMatchObject({ id: started.id, baseBranch: "main", baseCommit: main, state: "open", createdBy: PLANNER });
    expect(store.history(started.id)).toMatchObject([{ recordKind: "feature", type: "created", actor: PLANNER }]);
  });

  test("refuses a name git rejects, one starting with -, and one in the task branches' space, writing nothing", () => {
    for (const name of ["bad..name", "has space", "ends.lock", "-x", "@{-1}", "tmb", "tmb/abc"]) {
      const error = refusal(() => featureStart(store, PLANNER, { name }, context()));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("is not a feature branch name");
    }
    expect(refusal(() => featureStart(store, PLANNER, { name: " " }, context())).code).toBe("invalid_input");
    expect(store.listFeatures()).toEqual([]);
    expect(branches()).toEqual(["main"]);
  });

  test("refuses a branch the record or git already has", () => {
    featureStart(store, PLANNER, { name: FEATURE }, context());
    const recorded = refusal(() => featureStart(store, PLANNER, { name: FEATURE }, context()));
    expect(recorded.message).toContain(`the record already holds a feature branch ${FEATURE}`);

    git(project, "branch", "feat/in-git");
    for (const name of ["feat/in-git", "main"]) {
      const error = refusal(() => featureStart(store, PLANNER, { name }, context()));
      expect(error.code).toBe("refused");
      expect(error.message).toContain(`the branch ${name} already exists in git`);
    }
    expect(store.listFeatures().map((feature) => feature.name)).toEqual([FEATURE]);
  });

  test("refuses a project with no base branch set, and the worker and the reviewer", () => {
    const fresh = openProjectStore(mkdtempSync(path.join(scratch, "fresh-")), { create: true });
    if (!fresh.ok) throw fresh.error;
    try {
      const error = refusal(() => featureStart(fresh.store, PLANNER, { name: FEATURE }, context()));
      expect(error.message).toContain("no base branch is set");
      expect(fresh.store.listFeatures()).toEqual([]);
    } finally {
      fresh.store.close();
    }
    expect(refusal(() => featureStart(store, WORKER, { name: FEATURE }, context())).message).toContain("for the planner");
    expect(refusal(() => featureStart(store, REVIEWER, { name: FEATURE }, context())).code).toBe("refused");
    expect(branches()).toEqual(["main"]);
  });

  test("a record that cannot be written deletes the branch again", () => {
    const create = store.createFeature.bind(store);
    store.createFeature = () => {
      throw new Error("disk full");
    };
    try {
      expect(() => featureStart(store, PLANNER, { name: FEATURE }, context())).toThrow("disk full");
    } finally {
      store.createFeature = create;
    }
    expect(branches()).toEqual(["main"]);
  });

  test("feature_list gives each feature branch with its base, state and tasks", () => {
    const first = featureStart(store, HUMAN, { name: FEATURE }, context());
    const second = featureStart(store, HUMAN, { name: "feat/other" }, context());
    const task = startTask(["src"], { feature: FEATURE });
    expect(featureList(store, REVIEWER, {})).toEqual([
      { id: first.id, name: FEATURE, baseBranch: "main", baseCommit: first.baseCommit, state: "open", tasks: [task.id], repo: null },
      { id: second.id, name: "feat/other", baseBranch: "main", baseCommit: second.baseCommit, state: "open", tasks: [], repo: null },
    ]);
    expect(refusal(() => featureList(store, HUMAN, { state: "open" })).code).toBe("invalid_input");
  });
});

describe("folding a closed task into its feature branch", () => {
  beforeEach(() => {
    featureStart(store, HUMAN, { name: FEATURE }, context());
  });

  test("with the feature unmoved, fast-forwards it to the task's commit and removes the task's branch and worktree", async () => {
    const before = tip();
    const started = startTask(["src/a"]);
    const head = commitFile(started.worktree, "src/a/one.ts");

    const closed = await taskClose(store, WORKER, { id: started.id }, context());
    expect(tip()).toBe(head);
    expect(closed.fold).toEqual({ feature: FEATURE, from: before, to: head, rebased: false });
    expect(closed.cleanupProblems).toEqual([]);
    expect(branches()).toEqual([FEATURE, "main"]);
    expect(existsSync(started.worktree)).toBe(false);
    expect(git(project, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(store.getTask(started.id)).toMatchObject({ state: "closed", commitSha: head, kind: "code", reviewMode: "agile" });
    expect(closed.brief).toMatchObject({ state: "closed", commitSha: head, feature: FEATURE, kind: "code", reviewMode: "agile" });
    expect(store.listCheckRuns(started.id).map((run) => [run.commitSha, run.result])).toEqual([[head, "passed"]]);
  });

  test("when the feature moved, rebases the task onto it, checks the rebased commit and folds it", async () => {
    const first = startTask(["src/a"]);
    const second = startTask(["src/b"]);
    const firstHead = commitFile(first.worktree, "src/a/one.ts");
    const secondHead = commitFile(second.worktree, "src/b/two.ts");
    await taskClose(store, WORKER, { id: first.id }, context());

    const closed = await taskClose(store, WORKER, { id: second.id }, context());
    const folded = tip();
    expect(folded).not.toBe(secondHead);
    expect(git(project, "rev-parse", `${folded}^`)).toBe(firstHead);
    expect(git(project, "show", "-s", "--format=%s", folded)).toBe("write src/b/two.ts");
    expect(closed.fold).toEqual({ feature: FEATURE, from: firstHead, to: folded, rebased: true });
    expect(store.getTask(second.id)).toMatchObject({ state: "closed", commitSha: folded });
    const runs = store.listCheckRuns(second.id);
    expect(runs.map((run) => [run.commitSha, run.result])).toEqual([
      [secondHead, "passed"],
      [folded, "passed"],
    ]);
    expect(closed.checkRunIds).toEqual(runs.map((run) => run.id));
    expect(closed.checkRunId).toBe(runs[1]!.id);
    expect(existsSync(second.worktree)).toBe(false);
    expect(branches()).toEqual([FEATURE, "main"]);
  });

  test("a check that fails on the rebased commit leaves the task open, the feature unmoved and the worktree as it was", async () => {
    const first = startTask(["src/a"]);
    const second = startTask(["src/b"], { checks: ["test ! -f src/a/one.ts"] });
    const firstHead = commitFile(first.worktree, "src/a/one.ts");
    const secondHead = commitFile(second.worktree, "src/b/two.ts");
    await taskClose(store, WORKER, { id: first.id }, context());

    const error = await asyncRefusal(() => taskClose(store, WORKER, { id: second.id }, context()));
    expect(error.message).toContain("`test ! -f src/a/one.ts` exited 1 on the task rebased onto the feature branch");
    expect(error.message).toContain(`The worktree is back at ${secondHead}, as it was.`);
    expect(tip()).toBe(firstHead);
    expect(store.getTask(second.id)).toMatchObject({ state: "open", commitSha: null, reviewMode: "agile" });
    expect(git(second.worktree, "rev-parse", "HEAD")).toBe(secondHead);
    expect(git(second.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(second.branch);
    expect(git(second.worktree, "status", "--porcelain")).toBe("");
    expect(store.listCheckRuns(second.id).map((run) => [run.commitSha === secondHead, run.result])).toEqual([
      [true, "passed"],
      [false, "failed"],
    ]);
  });

  // The second task holds the first's change again: as a commit of its own, which the rebase drops, or as the first's very commit.
  for (const rebased of [true, false]) {
    const how = rebased ? "the rebase drops its only commit" : "its HEAD is the feature's tip";
    test(`a task whose work is already on the feature branch is refused when ${how}, leaving it open, the feature unmoved and the worktree as it was`, async () => {
      const first = startTask(["src/a"]);
      const second = startTask(["src/b"]);
      const firstHead = commitFile(first.worktree, "src/a/one.ts", "same\n");
      await taskClose(store, WORKER, { id: first.id }, context());
      if (rebased) {
        // Another message keeps the commit distinct from the first's even when both land in the same second.
        mkdirSync(path.join(second.worktree, "src/a"), { recursive: true });
        writeFileSync(path.join(second.worktree, "src/a/one.ts"), "same\n");
        git(second.worktree, "add", ".");
        git(second.worktree, "commit", "-q", "-m", "the first's change again");
      } else {
        git(second.worktree, "merge", "-q", "--ff-only", firstHead);
      }
      const secondHead = git(second.worktree, "rev-parse", "HEAD");
      expect(secondHead === firstHead).toBe(!rebased);

      const error = await asyncRefusal(() => taskClose(store, WORKER, { id: second.id }, context()));
      expect(error.code).toBe("refused");
      expect(error.message).toContain(`the task's work is already on the feature branch ${FEATURE} at ${firstHead}`);
      expect(error.message).toContain(`task ${second.id} stays open`);
      if (rebased) expect(error.message).toContain(`The worktree is back at ${secondHead}, as it was.`);
      expect(tip()).toBe(firstHead);
      expect(store.getTask(second.id)).toMatchObject({ state: "open", commitSha: null, reviewMode: "agile" });
      expect(store.getTask(first.id)).toMatchObject({ state: "closed", commitSha: firstHead });
      expect(git(second.worktree, "rev-parse", "HEAD")).toBe(secondHead);
      expect(git(second.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(second.branch);
      expect(git(second.worktree, "status", "--porcelain")).toBe("");
      expect(store.listCheckRuns(second.id).map((run) => run.commitSha)).toEqual([secondHead]);
    });
  }

  test("a task whose earlier close moved the feature branch and stopped before recording it closes, finishing the fold", async () => {
    const task = startTask(["src/a"]);
    const head = commitFile(task.worktree, "src/a/one.ts");
    // What the earlier close left: the feature branch moved to the task's commit, the task still open.
    const from = tip();
    moveFeature(project, FEATURE, from, head, "a fold that stopped before it recorded the close");
    expect(store.getTask(task.id)).toMatchObject({ state: "open", commitSha: null });

    const result = await taskClose(store, WORKER, { id: task.id }, context());
    expect(result.fold).toEqual({ feature: FEATURE, from: head, to: head, rebased: false });
    expect(result.cleanupProblems).toEqual([]);
    expect(tip()).toBe(head);
    expect(store.getTask(task.id)).toMatchObject({ state: "closed", commitSha: head, reviewMode: "agile", pushResult: "skipped" });
    expect(existsSync(task.worktree)).toBe(false);
    expect(branches()).not.toContain(task.branch);
  });

  test("a rebase conflict is aborted and refused naming the paths, leaving the task open, the feature unmoved and the worktree as it was", async () => {
    const first = startTask(["src/a"]);
    const second = startTask(["src/b"]);
    const firstHead = commitFile(first.worktree, "README.md", "first's words\n");
    const secondHead = commitFile(second.worktree, "README.md", "second's words\n");
    await taskClose(store, WORKER, { id: first.id }, context());

    const error = await asyncRefusal(() => taskClose(store, WORKER, { id: second.id }, context()));
    expect(error.message).toContain(`rebasing the task onto the feature branch ${FEATURE} at ${firstHead} conflicts in:\nREADME.md`);
    expect(error.message).toContain("The rebase was undone");
    expect(tip()).toBe(firstHead);
    expect(store.getTask(second.id)!.state).toBe("open");
    expect(git(second.worktree, "rev-parse", "HEAD")).toBe(secondHead);
    expect(git(second.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(second.branch);
    expect(git(second.worktree, "status", "--porcelain")).toBe("");
    expect(existsSync(git(second.worktree, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"))).toBe(false);
    expect(store.listCheckRuns(second.id).map((run) => run.commitSha)).toEqual([secondHead]);
  });

  test("a feature branch checked out in a clean worktree is fast-forwarded there; a dirty one refuses the close", async () => {
    const checkout = path.join(scratch, "try-feature");
    git(project, "worktree", "add", "-q", checkout, FEATURE);

    const first = startTask(["src/a"]);
    const firstHead = commitFile(first.worktree, "src/a/one.ts");
    await taskClose(store, WORKER, { id: first.id }, context());
    expect(git(checkout, "rev-parse", "HEAD")).toBe(firstHead);
    expect(existsSync(path.join(checkout, "src/a/one.ts"))).toBe(true);
    expect(git(checkout, "status", "--porcelain")).toBe("");

    const second = startTask(["src/b"]);
    const secondHead = commitFile(second.worktree, "src/b/two.ts");
    writeFileSync(path.join(checkout, "README.md"), "edited by hand\n");
    const error = await asyncRefusal(() => taskClose(store, WORKER, { id: second.id }, context()));
    expect(error.message).toContain(`the feature branch ${FEATURE} is checked out at ${checkout} with changes that are not committed`);
    expect(tip()).toBe(firstHead);
    expect(store.getTask(second.id)!.state).toBe("open");
    expect(git(second.worktree, "rev-parse", "HEAD")).toBe(secondHead);
  });

  test("the feature branch moves only from the tip the close read, so a concurrent fold is not lost", () => {
    const before = tip();
    const elsewhere = git(project, "commit-tree", "-p", before, "-m", "a concurrent fold", `${before}^{tree}`);
    git(project, "update-ref", `refs/heads/${FEATURE}`, elsewhere);
    const mine = git(project, "commit-tree", "-p", before, "-m", "this close", `${before}^{tree}`);
    const error = refusal(() => moveFeature(project, FEATURE, before, mine, "test"));
    expect(error.message).toContain(`the feature branch ${FEATURE} moved from ${before}`);
    expect(tip()).toBe(elsewhere);
  });

  test("a cleanup that fails after the close is reported and the task stays closed", async () => {
    const started = startTask(["src/a"]);
    const head = commitFile(started.worktree, "src/a/one.ts");
    git(project, "worktree", "lock", started.worktree);

    const closed = await taskClose(store, WORKER, { id: started.id }, context());
    expect(store.getTask(started.id)).toMatchObject({ state: "closed", commitSha: head });
    expect(tip()).toBe(head);
    expect(closed.cleanupProblems).toEqual([
      `the worktree ${started.worktree} and the branch ${started.branch} were kept: the host locked the worktree, so it may still be in use; tmb tries again at a session start with no task open`,
    ]);
    expect(branches()).toContain(started.branch);
  });

  test("files git ignores, left by the checks, go with the worktree, and the close names them (#132)", async () => {
    writeSetting(store, HUMAN, "checks", ["mkdir -p dist && echo built > dist/app.js"]);
    const started = startTask(["src/a"]);
    writeFileSync(path.join(started.worktree, ".gitignore"), ".tmb/\ndist/\n");
    commitFile(started.worktree, "src/a/one.ts");

    const closed = await taskClose(store, WORKER, { id: started.id }, context());
    expect(closed.cleanupProblems).toEqual([]);
    expect(closed.cleanedUp).toEqual([`Removed the worktree ${started.worktree} with the files git ignores in it: dist/`]);
    expect(existsSync(started.worktree)).toBe(false);
    expect(branches()).toEqual([FEATURE, "main"]);
  });

  test("files git does not ignore keep the worktree and the branch, naming the files and the command (#132)", async () => {
    writeSetting(store, HUMAN, "checks", ["echo built > app.tsbuildinfo"]);
    const started = startTask(["src/a"]);
    commitFile(started.worktree, "src/a/one.ts");

    const closed = await taskClose(store, WORKER, { id: started.id }, context());
    expect(store.getTask(started.id)).toMatchObject({ state: "closed" });
    expect(closed.cleanupProblems).toHaveLength(1);
    expect(closed.cleanupProblems[0]).toContain(`the worktree ${started.worktree} and the branch ${started.branch} were kept: it holds files git does not ignore`);
    expect(closed.cleanupProblems[0]).toContain("app.tsbuildinfo");
    expect(closed.cleanupProblems[0]).toContain(`git worktree remove --force ${started.worktree} && git branch -D ${started.branch}`);
    expect(closed.cleanedUp).toEqual([]);
    expect(existsSync(path.join(started.worktree, "app.tsbuildinfo"))).toBe(true);
    expect(branches()).toContain(started.branch);

    // Once the project ignores the file, the next session start with no task open removes both.
    writeFileSync(path.join(git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude"), "*.tsbuildinfo\n");
    expect(retryKeptCheckouts(project, store.listTasks("closed"))).toEqual([`task ${started.id}: ${started.worktree} and ${started.branch}`]);
    expect(existsSync(started.worktree)).toBe(false);
    expect(branches()).toEqual([FEATURE, "main"]);
  });

  test("changes to tracked files keep the worktree and the branch, naming the files (#132)", async () => {
    writeSetting(store, HUMAN, "checks", ["echo changed >> README.md"]);
    const started = startTask(["src/a"]);
    commitFile(started.worktree, "src/a/one.ts");

    const closed = await taskClose(store, WORKER, { id: started.id }, context());
    expect(closed.cleanupProblems).toEqual([`the worktree ${started.worktree} and the branch ${started.branch} were kept: it has changes that are not committed: README.md`]);
    expect(existsSync(started.worktree)).toBe(true);
    // Retrying changes nothing while the change is there.
    expect(retryKeptCheckouts(project, store.listTasks("closed"))).toEqual([]);
    expect(existsSync(started.worktree)).toBe(true);
  });

  test("an adopted host worktree goes with its branch, and a locked one goes at the next session start once unlocked (#132)", async () => {
    const started = startTask(["src/a"]);
    const host = path.join(project, ".claude", "worktrees", "agent-1");
    git(project, "worktree", "add", "-q", "-b", "worktree-agent-1", host, tip());
    expect(adoptWorktree(store, WORKER, project, started.id, host).adopted).toBe(true);
    commitFile(host, "src/a/one.ts");
    git(project, "worktree", "lock", host);

    const closed = await taskClose(store, WORKER, { id: started.id }, context());
    expect(closed.cleanupProblems[0]).toContain(`the worktree ${host} and the branch ${started.branch} were kept: the host locked the worktree`);
    expect(retryKeptCheckouts(project, store.listTasks("closed"))).toEqual([]);

    git(project, "worktree", "unlock", host);
    expect(retryKeptCheckouts(project, store.listTasks("closed"))).toEqual([`task ${started.id}: ${host} and ${started.branch}`]);
    expect(existsSync(host)).toBe(false);
    expect(branches()).toEqual([FEATURE, "main"]);
    expect(git(project, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  test("a session start with no task open retries the cleanup; with a task open it waits (#132)", async () => {
    const started = startTask(["src/a"]);
    commitFile(started.worktree, "src/a/one.ts");
    git(project, "worktree", "lock", started.worktree);
    await taskClose(store, WORKER, { id: started.id }, context());
    git(project, "worktree", "unlock", started.worktree);

    const other = startTask(["src/b"]);
    sessionStartContext(project, false);
    expect(existsSync(started.worktree)).toBe(true);

    git(project, "worktree", "remove", other.worktree);
    store.updateTask(HUMAN, other.id, { state: "closed" });
    sessionStartContext(project, false);
    expect(existsSync(started.worktree)).toBe(false);
    expect(branches()).toEqual([FEATURE, "main"]);
  });

  test("a docs task takes the same checks and fold, committed by the planner", async () => {
    const started = startTask(["docs"], { kind: "docs", checks: ["test -f docs/guide.md"] });
    const head = commitFile(started.worktree, "docs/guide.md");
    const closed = await taskClose(store, PLANNER, { id: started.id }, context());
    expect(tip()).toBe(head);
    expect(closed.checks.map((check) => check.command)).toEqual(["true", "test -f docs/guide.md"]);
    expect(store.getTask(started.id)).toMatchObject({ state: "closed", kind: "docs", reviewMode: "agile", commitSha: head });
  });

  test("a task started before feature branches closes where it is, folding nothing", async () => {
    const worktree = path.join(scratch, "legacy");
    git(project, "worktree", "add", "-q", "-b", "tmb/legacy", worktree, "main");
    const base = git(worktree, "rev-parse", "HEAD");
    const id = store.appendTask(PLANNER, { issueId, title: "old", spec: "old", state: "open", branch: "tmb/legacy", worktree, baseCommit: base });
    const head = commitFile(worktree, "old.txt");
    const before = tip();

    const closed = await taskClose(store, WORKER, { id }, context());
    expect(closed).toMatchObject({ fold: null, push: null, cleanupProblems: [] });
    expect(store.getTask(id)).toMatchObject({ state: "closed", commitSha: head, reviewMode: "agile" });
    expect(tip()).toBe(before);
    expect(existsSync(worktree)).toBe(true);
  });
});

describe("pushing the feature branch as a backup", () => {
  beforeEach(() => {
    featureStart(store, HUMAN, { name: FEATURE }, context());
  });

  function addOrigin(): string {
    const origin = path.join(scratch, "origin.git");
    git(scratch, "init", "-q", "--bare", origin);
    git(project, "remote", "add", "origin", origin);
    return origin;
  }

  async function closeOne(file: string): Promise<{ closed: TaskCloseResult; id: string; head: string }> {
    const started = startTask([path.dirname(file)]);
    const head = commitFile(started.worktree, file);
    return { closed: await taskClose(store, WORKER, { id: started.id }, context()), id: started.id, head };
  }

  test("pushes the folded feature branch to origin, never forced, and records it", async () => {
    const origin = addOrigin();
    const { closed, id, head } = await closeOne("src/a/one.ts");
    expect(closed.push).toEqual({ result: "pushed", detail: `pushed ${FEATURE} to origin` });
    expect(git(origin, "rev-parse", `refs/heads/${FEATURE}`)).toBe(head);
    expect(store.getTask(id)).toMatchObject({ pushResult: "pushed", pushDetail: `pushed ${FEATURE} to origin` });
    expect(closed.brief.push).toEqual(closed.push);
  });

  test("with no origin, the push is skipped and recorded so", async () => {
    const { closed, id } = await closeOne("src/a/one.ts");
    expect(closed.push).toEqual({ result: "skipped", detail: "the repository has no remote named origin" });
    expect(store.getTask(id)).toMatchObject({ state: "closed", pushResult: "skipped" });
  });

  test("a rejected push is recorded as failed with git's message, and the task still closes", async () => {
    const origin = addOrigin();
    // origin holds an unrelated commit on the branch, so a push that is not forced is rejected.
    const unrelated = git(project, "commit-tree", "-m", "someone else's", `${tip()}^{tree}`);
    git(project, "push", "-q", "origin", `${unrelated}:refs/heads/${FEATURE}`);

    const { closed, id, head } = await closeOne("src/a/one.ts");
    expect(closed.push!.result).toBe("failed");
    expect(closed.push!.detail).toContain("rejected");
    expect(store.getTask(id)).toMatchObject({ state: "closed", commitSha: head, pushResult: "failed", pushDetail: closed.push!.detail });
    expect(tip()).toBe(head);
    expect(git(origin, "rev-parse", `refs/heads/${FEATURE}`)).toBe(unrelated);
  });
});
