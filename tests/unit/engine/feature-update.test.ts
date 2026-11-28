// A feature branch starts from a fetched base, and takes the base in before its review
// (trustmybot/tmb#169): feature_start cuts from origin's copy of the base branch unless the local
// one is ahead, and feature_update merges the base into the branch, never rewriting it; a conflict
// changes nothing and names the files. Runs against real git repositories in a temporary folder.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  featureBrief,
  featureStart,
  featureUpdate,
  HandlerError,
  issueCreate,
  taskClose,
  taskStart,
} from "../../../src/engine/handlers/index.ts";
import { openProjectStore, writeSetting } from "../../../src/engine/index.ts";
import type { Actor, Store } from "../../../src/engine/store/index.ts";
import { git } from "../../lib/git.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-a" };
const REVIEWER: Actor = { kind: "agent", role: "reviewer", host: "host-a" };
const FEATURE = "feat/goal";

// Each test fetches and pushes through real repositories, several times.
setDefaultTimeout(30_000);

let scratch: string;
let project: string;
let origin: string;
/** A second clone of origin, where someone else moves the base branch. */
let other: string;
let store: Store;
let issueId: string;

function identity(dir: string): void {
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.com");
}

/** Writes `text` to `file` and commits it on whatever `dir` has checked out; returns the commit. */
function commitFile(dir: string, file: string, text = `${file}\n`): string {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `write ${file}`);
  return git(dir, "rev-parse", "HEAD");
}

/** Someone else lands `file` on main on origin; returns the new commit. */
function moveOriginMain(file: string, text?: string): string {
  git(other, "pull", "-q", "--ff-only", "origin", "main");
  const commit = commitFile(other, file, text);
  git(other, "push", "-q", "origin", "main");
  return commit;
}

const context = () => ({ projectDir: project });
const tip = () => git(project, "rev-parse", FEATURE);

function refusal(call: () => unknown): HandlerError {
  try {
    call();
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a HandlerError, but the call succeeded");
}

/** Starts a task on the feature, commits `file` in its worktree and closes it, folding it in; returns the folded commit. */
async function landTask(file: string, text?: string): Promise<{ id: string; commit: string }> {
  const started = taskStart(store, PLANNER, { issue_id: issueId, kind: "code", intent: `Write ${file}`, files: [path.dirname(file)], criteria: ["SC1"] }, context());
  commitFile(started.worktree, file, text);
  const closed = await taskClose(store, WORKER, { id: started.id }, context());
  return { id: started.id, commit: closed.fold!.to };
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-feature-update-")));
  project = path.join(scratch, "project");
  origin = path.join(scratch, "origin.git");
  other = path.join(scratch, "other");
  mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  identity(project);
  writeFileSync(path.join(project, ".gitignore"), ".tmb/\n");
  writeFileSync(path.join(project, "README.md"), "hello\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "first");
  git(scratch, "init", "-q", "--bare", "-b", "main", origin);
  git(project, "remote", "add", "origin", origin);
  git(project, "push", "-q", "-u", "origin", "main");
  git(scratch, "clone", "-q", origin, other);
  identity(other);
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

describe("feature_start cuts from a fetched base", () => {
  test("fetches origin first and cuts from origin's base when the local one is behind it", () => {
    const landed = moveOriginMain("src/theirs.ts");
    const local = git(project, "rev-parse", "main");
    const started = featureStart(store, PLANNER, { name: FEATURE }, context());
    expect(started.baseCommit).toBe(landed);
    expect(tip()).toBe(landed);
    // The local base branch is left as it was: tmb moves no branch of the Human's.
    expect(git(project, "rev-parse", "main")).toBe(local);
  });

  test("cuts from the local base when it holds a commit origin lacks", () => {
    const ahead = commitFile(project, "src/mine.ts");
    expect(featureStart(store, PLANNER, { name: FEATURE }, context()).baseCommit).toBe(ahead);
  });

  test("with no origin, or origin out of reach, cuts from what git holds", () => {
    git(project, "remote", "set-url", "origin", path.join(scratch, "gone.git"));
    const local = git(project, "rev-parse", "main");
    expect(featureStart(store, PLANNER, { name: FEATURE }, context()).baseCommit).toBe(local);
    git(project, "remote", "remove", "origin");
    expect(featureStart(store, PLANNER, { name: "feat/two" }, context()).baseCommit).toBe(local);
  });
});

describe("feature_update brings the base branch in", () => {
  test("merges the moved base into the branch with a merge commit, pushes it as a backup and records it", async () => {
    featureStart(store, PLANNER, { name: FEATURE }, context());
    const own = await landTask("src/mine/one.ts");
    const landed = moveOriginMain("src/theirs.ts");

    const updated = featureUpdate(store, PLANNER, { feature: FEATURE }, context());
    expect(updated).toMatchObject({ feature: FEATURE, baseBranch: "main", base: landed, from: own.commit, how: "merged" });
    expect(updated.push).toEqual({ result: "pushed", detail: `pushed ${FEATURE} to origin` });
    expect(tip()).toBe(updated.to);
    // Never rewritten: the branch's own commit is the merge's first parent, the base its second.
    expect(git(project, "rev-list", "--parents", "-n", "1", updated.to).split(" ").slice(1)).toEqual([own.commit, landed]);
    expect(git(origin, "rev-parse", `refs/heads/${FEATURE}`)).toBe(updated.to);
    expect(git(project, "show", `${updated.to}:src/theirs.ts`)).toBe("src/theirs.ts");
    const feature = store.listFeatures().find((f) => f.name === FEATURE)!;
    expect(feature.baseMergedCommit).toBe(landed);
    expect(store.history(feature.id).at(-1)!.data).toMatchObject({ base_merged_commit: landed, from: own.commit, to: updated.to, how: "merged" });

    // Again with nothing new: nothing changes.
    expect(featureUpdate(store, PLANNER, { feature: FEATURE }, context())).toMatchObject({ how: "none", from: updated.to, to: updated.to, push: null });
  });

  test("fast-forwards a branch that has no commit of its own", () => {
    featureStart(store, PLANNER, { name: FEATURE }, context());
    const landed = moveOriginMain("src/theirs.ts");
    expect(featureUpdate(store, PLANNER, { feature: FEATURE }, context())).toMatchObject({ how: "fast_forward", to: landed });
    expect(tip()).toBe(landed);
  });

  test("a conflict changes nothing, names the files and says how to settle it", async () => {
    featureStart(store, PLANNER, { name: FEATURE }, context());
    const own = await landTask("src/shared.ts", "ours\n");
    const landed = moveOriginMain("src/shared.ts", "theirs\n");
    const pushedBefore = git(origin, "rev-parse", `refs/heads/${FEATURE}`);

    const refused = refusal(() => featureUpdate(store, PLANNER, { feature: FEATURE }, context()));
    expect(refused.code).toBe("refused");
    expect(refused.message).toContain(`bringing main at ${landed} into the feature branch ${FEATURE} conflicts in:\nsrc/shared.ts\n`);
    expect(refused.message).toContain(`stays at ${own.commit}`);
    expect(refused.message).toContain(`git merge ${landed}`);
    expect(refused.message).toContain("raise it to the Human");
    expect(tip()).toBe(own.commit);
    expect(git(origin, "rev-parse", `refs/heads/${FEATURE}`)).toBe(pushedBefore);
    expect(git(project, "status", "--porcelain")).toBe("");
    expect(store.listFeatures().find((f) => f.name === FEATURE)!.baseMergedCommit).toBeNull();

    // Settled in a task whose worker merges the base and resolves it; then the step has nothing left to bring.
    const started = taskStart(store, PLANNER, { issue_id: issueId, kind: "code", intent: "Settle the merge", files: ["src"], criteria: ["SC1"] }, context());
    spawnSync("git", ["merge", "-q", landed], { cwd: started.worktree });
    writeFileSync(path.join(started.worktree, "src", "shared.ts"), "both\n");
    git(started.worktree, "add", ".");
    git(started.worktree, "commit", "-q", "--no-edit");
    await taskClose(store, WORKER, { id: started.id }, context());
    expect(featureUpdate(store, PLANNER, { feature: FEATURE }, context()).how).toBe("none");
  });

  test("a branch checked out in a clean worktree moves there too; a dirty one refuses, changing nothing", async () => {
    featureStart(store, PLANNER, { name: FEATURE }, context());
    const own = await landTask("src/mine/one.ts");
    moveOriginMain("src/theirs.ts");
    const holder = path.join(scratch, "holder");
    git(project, "worktree", "add", "-q", holder, FEATURE);
    writeFileSync(path.join(holder, "README.md"), "dirty\n");
    expect(refusal(() => featureUpdate(store, PLANNER, { feature: FEATURE }, context())).message).toContain("not committed");
    expect(tip()).toBe(own.commit);

    git(holder, "checkout", "-q", "--", "README.md");
    const updated = featureUpdate(store, PLANNER, { feature: FEATURE }, context());
    expect(git(holder, "rev-parse", "HEAD")).toBe(updated.to);
    expect(git(holder, "status", "--porcelain")).toBe("");
  });

  test("is the planner's: the worker and the reviewer are refused, and an unknown or closed branch too", () => {
    featureStart(store, PLANNER, { name: FEATURE }, context());
    for (const actor of [WORKER, REVIEWER]) expect(refusal(() => featureUpdate(store, actor, { feature: FEATURE }, context())).message).toContain("is for the planner");
    expect(refusal(() => featureUpdate(store, PLANNER, { feature: "feat/none" }, context())).code).toBe("not_found");
    store.updateFeature(HUMAN, store.findFeature(FEATURE)!.id, { state: "merged" });
    expect(refusal(() => featureUpdate(store, PLANNER, { feature: FEATURE }, context())).message).toContain("is merged; only an open one, one whose pull request is open, or one ready for a local merge");
  });
});

describe("the review judges the tip that holds the base", () => {
  test("the brief says whether the tip holds the base, and groups no base change under a task", async () => {
    featureStart(store, PLANNER, { name: FEATURE }, context());
    const first = await landTask("src/a/one.ts");
    const landed = moveOriginMain("src/theirs.ts");
    git(project, "fetch", "-q", "origin");

    const before = featureBrief(store, PLANNER, { feature: FEATURE }, context());
    expect(before).toMatchObject({ base: landed, holdsBase: false });

    const merged = featureUpdate(store, PLANNER, { feature: FEATURE }, context()).to;
    const second = await landTask("src/b/two.ts");
    const after = featureBrief(store, PLANNER, { feature: FEATURE }, context());
    expect(after).toMatchObject({ base: landed, holdsBase: true, mergeBase: landed, tip: second.commit });
    expect(after.groups.map((group) => [group.task, group.from, group.to])).toEqual([
      [first.id, before.mergeBase, first.commit],
      // The second task's group starts at the merge, so the base's change is not shown as its own.
      [second.id, merged, second.commit],
    ]);
    expect(git(project, "diff", "--name-only", after.groups[1]!.from, after.groups[1]!.to)).toBe("src/b/two.ts");
  });
});
