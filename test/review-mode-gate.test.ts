// The review mode is the Human's choice (trustmybot/tmb#114): no task starts until it is chosen.
// With a Human to ask, the planner is refused and asks; with no one to ask, the task is refused
// and the planner cannot pick the mode itself. The record keeps which way it was chosen.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { featureStart, HandlerError, issueCreate, settingsSet, taskStart } from "../src/engine/handlers/index.ts";
import { chooseReviewMode, openProjectStore, readSettings, reviewModeChosenVia, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "test" };
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
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-review-mode-gate-")));
  git(project, "init", "-q", "-b", "main");
  writeFileSync(path.join(project, ".gitignore"), ".tmb/\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "first");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  // Everything but the review mode, as the planner applies it at the first session.
  writeSetting(store, PLANNER, "base_branch", "main");
  writeSetting(store, PLANNER, "checks", ["true"]);
  issueId = issueCreate(store, HUMAN, { title: "The goal" }).id;
  featureStart(store, PLANNER, { name: FEATURE }, attended());
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const attended = () => ({ projectDir: project });
const unattended = () => ({ projectDir: project, unattended: true });
const spec = () => ({ issue_id: issueId, kind: "code", intent: "Add the feature", files: ["src/a"], criteria: ["SC1: it works"] });

function refusal(call: () => unknown): HandlerError {
  try {
    call();
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a HandlerError, but the call succeeded");
}

function expectNoTask(): void {
  expect(store.listTasks()).toEqual([]);
  expect(git(project, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual([FEATURE, "main"]);
}

describe("the review mode gate", () => {
  test("with the review mode chosen, a task starts in that mode, and the record says who chose it", () => {
    expect(chooseReviewMode(store, HUMAN, "agile", "onboard")).toBe(true);
    const started = taskStart(store, PLANNER, spec(), attended());
    expect(started.brief.state).toBe("open");
    expect(store.getTask(started.id)!.reviewMode).toBe("agile");
    expect(reviewModeChosenVia(store)).toBe("onboard");
  });

  test("with no review mode and a Human to ask, the start is refused; the planner asks and sets the answer, and the task starts", () => {
    const refused = refusal(() => taskStart(store, PLANNER, spec(), attended()));
    expect(refused.code).toBe("refused");
    expect(refused.message).toContain("no review mode is chosen");
    expect(refused.message).toContain("Ask the Human");
    expect(refused.message).toContain("`tmb onboard`");
    expectNoTask();

    // The planner passes on the Human's answer; the record says it came through the planner.
    const set = settingsSet(store, PLANNER, { review_mode: "truest" }, attended());
    expect(set.changed).toEqual(["review_mode"]);
    expect(reviewModeChosenVia(store)).toBe("planner");
    expect(store.listAuditAbout("setting:review_mode").at(-1)!.createdBy).toEqual(PLANNER);

    // In truest mode a task names no feature branch.
    const started = taskStart(store, PLANNER, spec(), attended());
    expect(store.getTask(started.id)!.reviewMode).toBe("truest");
  });

  test("with no review mode and no one to ask, the start is refused naming tmb onboard, and the planner cannot pick a mode", () => {
    const refused = refusal(() => taskStart(store, PLANNER, spec(), unattended()));
    expect(refused.code).toBe("refused");
    expect(refused.message).toContain("`tmb onboard`");

    const picked = refusal(() => settingsSet(store, PLANNER, { review_mode: "agile" }, unattended()));
    expect(picked.code).toBe("refused");
    expect(picked.message).toContain("no one can answer in this run");
    expect(picked.message).toContain("`tmb onboard`");
    expect(readSettings(store).review_mode).toBeNull();
    expect(reviewModeChosenVia(store)).toBeNull();
    expect(refusal(() => taskStart(store, PLANNER, spec(), unattended())).message).toContain("no review mode is chosen");
    expectNoTask();

    // The other settings stay the planner's, unattended too.
    expect(settingsSet(store, PLANNER, { checks: ["echo ok"] }, unattended()).changed).toEqual(["checks"]);
  });

  test("an unattended run keeps a mode the Human chose, and the planner may repeat it but not change it", () => {
    chooseReviewMode(store, HUMAN, "agile", "init");
    expect(settingsSet(store, PLANNER, { review_mode: "agile" }, unattended()).changed).toEqual([]);
    expect(refusal(() => settingsSet(store, PLANNER, { review_mode: "truest" }, unattended())).code).toBe("refused");
    expect(reviewModeChosenVia(store)).toBe("init");
    expect(taskStart(store, PLANNER, spec(), unattended()).brief.state).toBe("open");
  });

  test("a project whose mode was set before tmb recorded the way keeps it, and its tasks start", () => {
    writeSetting(store, HUMAN, "review_mode", "agile");
    expect(reviewModeChosenVia(store)).toBeNull();
    expect(taskStart(store, PLANNER, spec(), attended()).brief.state).toBe("open");
  });
});
