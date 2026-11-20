// Dropping a feature branch (trustmybot/tmb#214): the planner or the Human ends an open, closed or
// ready feature branch without a merge tmb saw, with the reason. One whose pull request is open is
// refused, and so is one with a task still open. The branch is kept. Runs against a real git repository.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { featureDrop, featureList, featurePr, featureStart, featureUpdate, HandlerError, issueCreate, OPERATIONS, taskStart } from "../src/engine/handlers/index.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

setDefaultTimeout(30_000);

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

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-feature-drop-")));
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

describe("feature_drop", () => {
  let featureId: string;
  beforeEach(() => {
    writeSetting(store, HUMAN, "review_mode", "agile");
    featureId = featureStart(store, HUMAN, { name: FEATURE }, context()).id;
  });

  test("the planner drops an open feature branch with its reason; the branch is kept and named with how to delete it", () => {
    const dropped = featureDrop(store, PLANNER, { feature: FEATURE, reason: "  nobody will merge it  " }, context());
    expect(dropped.feature).toMatchObject({ name: FEATURE, state: "dropped", dropReason: "nobody will merge it" });
    expect(dropped.keptBranch).toBe(`the branch ${FEATURE} was kept. Delete it once nothing there is needed: git branch -D ${FEATURE}`);
    expect(git(project, "branch", "--list", FEATURE)).toContain(FEATURE);
    const last = store.history(featureId).at(-1)!;
    expect(last.data).toEqual({ state: "dropped", drop_reason: "nobody will merge it" });
    expect(last.actor).toEqual(PLANNER);
    expect(featureList(store, HUMAN, {}, context()).find((f) => f.name === FEATURE)).toMatchObject({ state: "dropped", dropReason: "nobody will merge it" });
  });

  test("the Human may drop one; a worker and the reviewer are refused; a reason is required", () => {
    expect(refusal(() => featureDrop(store, WORKER, { feature: FEATURE, reason: "x" }, context())).message).toContain("feature_drop is for the planner");
    expect(refusal(() => featureDrop(store, REVIEWER, { feature: FEATURE, reason: "x" }, context())).code).toBe("refused");
    expect(refusal(() => featureDrop(store, PLANNER, { feature: FEATURE }, context())).code).toBe("invalid_input");
    expect(refusal(() => featureDrop(store, PLANNER, { feature: FEATURE, reason: "  " }, context())).code).toBe("invalid_input");
    expect(refusal(() => featureDrop(store, PLANNER, { feature: "feat/none", reason: "x" }, context())).code).toBe("not_found");
    expect(store.getFeature(featureId)!.state).toBe("open");
    expect(featureDrop(store, HUMAN, { feature: FEATURE, reason: "the Human squashed it" }, context()).feature.state).toBe("dropped");
  });

  test("an open pull request is refused, a closed or ready branch is dropped, and a merged or dropped one is refused", () => {
    store.updateFeature(HUMAN, featureId, { state: "pr_open" });
    expect(refusal(() => featureDrop(store, PLANNER, { feature: FEATURE, reason: "x" }, context())).message).toContain("close the pull request first");
    store.updateFeature(HUMAN, featureId, { state: "closed" });
    expect(featureDrop(store, PLANNER, { feature: FEATURE, reason: "closed for good" }, context()).feature.state).toBe("dropped");
    expect(refusal(() => featureDrop(store, PLANNER, { feature: FEATURE, reason: "again" }, context())).message).toContain(
      "is dropped; only an open one, a closed one or one ready for a local merge is dropped",
    );

    // A ready branch with no commit of its own is never taken as merged, even though the base holds its tip.
    const ready = featureStart(store, HUMAN, { name: "feat/ready" }, context()).id;
    store.updateFeature(HUMAN, ready, { state: "ready" });
    expect(featureList(store, HUMAN, {}, context()).find((f) => f.name === "feat/ready")).toMatchObject({ state: "ready" });
    expect(featureDrop(store, PLANNER, { feature: "feat/ready", reason: "nothing in it" }, context()).feature.state).toBe("dropped");

    const merged = featureStart(store, HUMAN, { name: "feat/merged" }, context()).id;
    store.updateFeature(HUMAN, merged, { state: "merged" });
    expect(refusal(() => featureDrop(store, PLANNER, { feature: "feat/merged", reason: "x" }, context())).message).toContain("is merged");
  });

  test("a branch with an open task is refused; a dropped branch takes no task, no base and no pull request", () => {
    const task = taskStart(store, PLANNER, { issue_id: issueId, kind: "code", feature: FEATURE, intent: "Add it", files: ["src/a"], criteria: ["SC1: x"] }, context());
    expect(refusal(() => featureDrop(store, PLANNER, { feature: FEATURE, reason: "x" }, context())).message).toContain(`tasks still open or in review (${task.id} open)`);
    store.updateTask(HUMAN, task.id, { state: "dropped" });

    featureDrop(store, PLANNER, { feature: FEATURE, reason: "the goal changed" }, context());
    const start = { issue_id: issueId, kind: "code", feature: FEATURE, intent: "More", files: ["src/a"], criteria: ["SC1: x"] };
    expect(refusal(() => taskStart(store, PLANNER, start, context())).message).toContain("is dropped");
    expect(refusal(() => featureUpdate(store, PLANNER, { feature: FEATURE }, context())).message).toContain("is dropped");
    expect(refusal(() => featurePr(store, PLANNER, { feature: FEATURE, title: "x" }, context())).message).toContain("is dropped");
  });

  test("is an operation of both doors", () => {
    expect(Object.keys(OPERATIONS)).toContain("feature_drop");
  });
});
