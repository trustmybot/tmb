// Truest mode's rules on the record, against a real git repository: the mode is fixed when a task
// starts, a task is cut from the base branch, its close waits for review, and what covers its
// commit for the push gate. The whole flow with origin and the push hook is in tests/workflow.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  featureStart,
  HandlerError,
  issueCreate,
  taskBrief,
  taskClose,
  taskPr,
  taskReview,
  taskStart,
  taskWaive,
  truestCoveredCommits,
} from "../src/engine/handlers/index.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-a" };
const REVIEWER: Actor = { kind: "agent", role: "reviewer", host: "host-a" };

let project: string;
let store: Store;
let issueId: string;
const context = () => ({ projectDir: project });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `write ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

async function refusal(call: () => unknown): Promise<HandlerError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a HandlerError, but the call succeeded");
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-truest-")));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.name", "t");
  git(project, "config", "user.email", "t@example.com");
  writeFileSync(path.join(project, ".gitignore"), ".tmb/\n");
  commit(project, "README.md", "hello\n");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  writeSetting(store, HUMAN, "base_branch", "main");
  writeSetting(store, HUMAN, "checks", ["true"]);
  writeSetting(store, HUMAN, "review_mode", "truest");
  issueId = issueCreate(store, HUMAN, { title: "The goal" }).id;
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const spec = (files = ["src"]) => ({ issue_id: issueId, kind: "code", intent: "Do it", files, criteria: ["SC1: it works"] });

/** A truest task closed into review at its commit. */
async function inReview(file = "a.txt") {
  const started = taskStart(store, PLANNER, spec([file]), context());
  const sha = commit(started.worktree, file, "work\n");
  await taskClose(store, WORKER, { id: started.id }, context());
  return { ...started, sha };
}

function review(id: string, sha: string, verdict: "pass" | "fail") {
  const run = store.appendRun(REVIEWER, { role: "reviewer" });
  try {
    return taskReview(store, REVIEWER, { id, commit: sha, verdict, ...(verdict === "fail" ? { blocking: ["a.txt:1 wrong"] } : {}) }, context());
  } finally {
    store.endRun(REVIEWER, run);
  }
}

describe("truest mode", () => {
  test("a task is cut from the base branch, and no feature branch exists", async () => {
    const main = git(project, "rev-parse", "main");
    expect((await refusal(() => featureStart(store, HUMAN, { name: "feat/x" }, context()))).message).toContain("truest");
    expect((await refusal(() => taskStart(store, PLANNER, { ...spec(), feature: "feat/x" }, context()))).message).toContain("truest");
    const started = taskStart(store, PLANNER, spec(), context());
    expect(store.getTask(started.id)).toMatchObject({ reviewMode: "truest", featureId: null, baseCommit: main });
  });

  test("close runs the checks and leaves the task in review with its worktree; nothing is folded", async () => {
    const task = await inReview();
    expect(store.getTask(task.id)).toMatchObject({ state: "in_review", commitSha: task.sha, worktree: task.worktree });
    expect(git(project, "rev-parse", "main")).not.toBe(task.sha);
    expect(taskBrief(store, PLANNER, { id: task.id }).review).toMatchObject({ to: task.sha, covered: false, reviewLine: `review_task=${task.id}` });
  });

  test("a fail reopens the task, and a later pass covers only the commit it names", async () => {
    const task = await inReview();
    expect(review(task.id, task.sha, "fail")).toMatchObject({ state: "open", covered: false });
    expect(truestCoveredCommits(store)).toEqual([]);
    const rework = commit(task.worktree, "a.txt", "better\n");
    await taskClose(store, WORKER, { id: task.id }, context());
    expect((await refusal(() => review(task.id, task.sha, "pass"))).message).toContain(`in review at ${rework}`);
    expect(review(task.id, rework, "pass")).toMatchObject({ state: "in_review", covered: true });
    expect(truestCoveredCommits(store)).toEqual([rework]);
  });

  test("only the reviewer reviews and only the Human waives; a waiver covers the commit", async () => {
    const task = await inReview();
    expect((await refusal(() => taskReview(store, HUMAN, { id: task.id, commit: task.sha, verdict: "pass" }, context()))).message).toContain(
      "tmb task waive",
    );
    expect((await refusal(() => taskReview(store, REVIEWER, { id: task.id, commit: task.sha, verdict: "pass" }, context()))).message).toContain(
      "no reviewer run is open",
    );
    expect((await refusal(() => taskWaive(store, PLANNER, { id: task.id, reason: "small" }, context()))).message).toContain("only the Human waives");
    expect(taskWaive(store, HUMAN, { id: task.id, reason: "small" }, context())).toMatchObject({ task: task.id, commit: task.sha, reason: "small" });
    expect(taskBrief(store, PLANNER, { id: task.id }).review).toMatchObject({ covered: true, coveredBy: "waiver" });
    expect(truestCoveredCommits(store)).toEqual([task.sha]);
  });

  test("task_pr is the planner's, and is refused without a review or without origin", async () => {
    const task = await inReview();
    expect((await refusal(() => taskPr(store, WORKER, { id: task.id, title: "x" }, context()))).message).toContain("for the planner");
    expect((await refusal(() => taskPr(store, PLANNER, { id: task.id, title: "x" }, context()))).message).toContain("no reviewer has reviewed it");
    review(task.id, task.sha, "pass");
    expect((await refusal(() => taskPr(store, PLANNER, { id: task.id, title: "x" }, context()))).message).toContain("no remote named origin");
  });

  test("the mode is fixed at the task's start: an agile task stays agile when the mode changes", async () => {
    writeSetting(store, HUMAN, "review_mode", "agile");
    featureStart(store, HUMAN, { name: "feat/a" }, context());
    const agile = taskStart(store, PLANNER, spec(["b.txt"]), context());
    writeSetting(store, HUMAN, "review_mode", "truest");
    commit(agile.worktree, "b.txt", "b\n");
    await taskClose(store, WORKER, { id: agile.id }, context());
    expect(store.getTask(agile.id)?.state).toBe("closed");
    expect((await refusal(() => taskWaive(store, HUMAN, { id: agile.id, reason: "x" }, context()))).message).toContain("agile mode");
  });
});
