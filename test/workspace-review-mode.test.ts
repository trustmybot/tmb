// A review mode per repo in a workspace (trustmybot/tmb#216): repo a follows the workspace's mode,
// repo b names its own. A feature branch starts only in an agile repo, a truest repo's task goes
// into review at close, each repo's push gate asks for what its own mode requires, a repo with no
// mode of its own follows a change of the workspace's, and only the Human sets a repo's mode.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HostAdapter } from "../src/adapters/index.ts";
import { featureStart, HandlerError, issueCreate, settingsSet, taskClose, taskStart } from "../src/engine/handlers/index.ts";
import { emptySettings } from "../src/engine/handlers/settings.ts";
import { judgePush, openProjectStore, readSettings, reviewModeOf, settingLines, TMB_EVENT_TYPES, writeSetting } from "../src/engine/index.ts";
import { sessionStartContext } from "../src/engine/session-start.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";
import { type Ask, runInit, runOnboard, type SetupFlags } from "../src/setup.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-a" };
const ZERO = "0".repeat(40);

setDefaultTimeout(30_000);

let scratch: string;
let workspace: string;
let output: string[];
let a: string;
let b: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repo in the workspace on `base`, with a bare origin that holds it and names it as its default. */
function makeRepo(name: string, base: string): string {
  const dir = path.join(workspace, name);
  const origin = path.join(scratch, `${name}-origin.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", base);
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.com");
  writeFileSync(path.join(dir, "README.md"), `${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `first in ${name}`);
  git(scratch, "init", "-q", "--bare", "-b", base, origin);
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", base);
  git(dir, "remote", "set-head", "origin", base);
  return dir;
}

const HOST: HostAdapter = {
  id: "a",
  name: "Host A",
  command: "host-a",
  reconnectToolServer: "restart Host A",
  limits: { canDenyToolCall: true, modelPerRole: true, namesAgentOnToolCall: true, events: TMB_EVENT_TYPES },
  detect: () => ({ installed: true }),
  setup(projectDir) {
    const opened = openProjectStore(projectDir, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.close();
    return ["wired a"];
  },
  remove: () => [],
  answerHook: () => "",
};

const TMB_COMMAND = [process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts")];

function setupOptions(flags: SetupFlags = {}, ask: Ask | null = null) {
  return { projectDir: workspace, tmbCommand: TMB_COMMAND, adapters: [HOST], supportedHostIds: ["a"], flags, ask, out: (line: string) => output.push(line) };
}

function withStore<T>(use: (store: Store) => T): T {
  const opened = openProjectStore(workspace, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return use(opened.store);
  } finally {
    opened.store.close();
  }
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

/** Answers each question in turn, and records the prompts. */
function scripted(answers: string[], prompts: string[]): Ask {
  return async (prompt) => {
    prompts.push(prompt);
    return answers.shift() ?? null;
  };
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-repo-mode-")));
  workspace = path.join(scratch, "workspace");
  mkdirSync(workspace);
  output = [];
  a = makeRepo("a", "dev");
  b = makeRepo("b", "main");
  await runInit(setupOptions());
  withStore((store) => {
    writeSetting(store, HUMAN, "review_mode", "agile");
    writeSetting(store, HUMAN, "repos", { a: { base_branch: "dev", checks: [] }, b: { base_branch: "main", checks: [], review_mode: "truest" } });
  });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("work follows its repo's review mode", () => {
  let store: Store;
  let issueId: string;
  const context = () => ({ projectDir: workspace });

  beforeEach(() => {
    const opened = openProjectStore(workspace, { create: false });
    if (!opened.ok) throw opened.error;
    store = opened.store;
    issueId = issueCreate(store, HUMAN, { title: "The goal" }).id;
  });

  afterEach(() => {
    store.close();
  });

  test("a feature branch starts in the agile repo and is refused in the truest one", () => {
    expect(featureStart(store, PLANNER, { name: "feat/a", repo: "a" }, context())).toMatchObject({ repo: "a" });
    const refused = refusal(() => featureStart(store, PLANNER, { name: "feat/b", repo: "b" }, context()));
    expect(refused.message).toContain("the repo b is in truest mode, which has no feature branches");
    expect(git(b, "branch", "--list", "feat/b")).toBe("");
  });

  test("a task in the truest repo goes into review at close; one in the agile repo folds into its feature", async () => {
    const spec = { issue_id: issueId, kind: "code", intent: "Change", files: ["src"], criteria: ["SC1"], checks: ["true"] };
    const truest = taskStart(store, PLANNER, { ...spec, repo: "b" }, context());
    expect(store.getTask(truest.id)?.reviewMode).toBe("truest");
    // A feature named in the truest repo is refused, as in a project in truest mode.
    featureStart(store, PLANNER, { name: "feat/a", repo: "a" }, context());
    const agile = taskStart(store, PLANNER, { ...spec, feature: "feat/a" }, context());
    expect(store.getTask(agile.id)?.reviewMode).toBe("agile");

    for (const task of [truest, agile]) {
      mkdirSync(path.join(task.worktree, "src"));
      writeFileSync(path.join(task.worktree, "src", "one.ts"), "one\n");
      git(task.worktree, "add", "src");
      git(task.worktree, "commit", "-q", "-m", "one");
      await taskClose(store, WORKER, { id: task.id }, context());
    }
    expect(store.getTask(truest.id)?.state).toBe("in_review");
    expect(store.getTask(agile.id)?.state).toBe("closed");
  });

  test("a task start that names no repo is refused while the repos follow different modes", () => {
    const spec = { issue_id: issueId, kind: "code", intent: "Change", files: ["src"], criteria: ["SC1"] };
    const refused = refusal(() => taskStart(store, PLANNER, spec, context()));
    expect(refused.message).toContain("the repos of this workspace follow different review modes (a agile, b truest)");
    expect(refused.message).toContain("name the repo this task works in with repo");
  });

  test("a task keeps the mode it was started in when its repo's mode changes", () => {
    const started = taskStart(store, PLANNER, { issue_id: issueId, kind: "code", intent: "Change", files: ["src"], criteria: ["SC1"], repo: "b" }, context());
    writeSetting(store, HUMAN, "repos", { a: { base_branch: "dev", checks: [] }, b: { base_branch: "main", checks: [] } });
    expect(store.getTask(started.id)?.reviewMode).toBe("truest");
  });

  test("a repo with no mode of its own follows the workspace's, and a change of it reaches that repo", () => {
    expect(reviewModeOf(readSettings(store), "a")).toBe("agile");
    writeSetting(store, HUMAN, "review_mode", "truest");
    expect(reviewModeOf(readSettings(store), "a")).toBe("truest");
    expect(refusal(() => featureStart(store, PLANNER, { name: "feat/a", repo: "a" }, context())).message).toContain("the repo a is in truest mode");
    // b's own mode does not follow the workspace's back to agile.
    writeSetting(store, HUMAN, "review_mode", "agile");
    expect(reviewModeOf(readSettings(store), "b")).toBe("truest");
  });
});

describe("each repo's push gate asks for what its own mode requires", () => {
  function judge(dir: string, branch: string) {
    const remote = git(dir, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] || ZERO;
    return judgePush(workspace, "origin", `refs/heads/${branch} ${git(dir, "rev-parse", "HEAD")} refs/heads/${branch} ${remote}\n`, dir);
  }

  beforeEach(() => {
    for (const dir of [a, b]) {
      writeFileSync(path.join(dir, "hotfix.txt"), "fix\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "a hotfix straight on the base");
    }
  });

  test("an unreviewed push to the base is refused in both, and only the truest repo asks for a review of each task", () => {
    const agile = judge(a, "dev");
    const truest = judge(b, "main");
    expect(agile.decision).toBe("deny");
    expect(truest.decision).toBe("deny");
    expect(agile.reason).not.toContain("In truest mode");
    expect(truest.reason).toContain("In truest mode every task is reviewed before its push");
    expect(judge(a, "other").reason).toBe("no ref of the push brings unreviewed commits onto dev");
    expect(judge(b, "other").reason).toBe("no ref of the push brings an unreviewed task commit, or any unreviewed commit onto the base branch");
  });
});

describe("settings show and keep each repo's mode", () => {
  test("tmb settings and the session start show each repo's mode", () => {
    const lines = withStore((store) => settingLines(readSettings(store)));
    expect(lines).toContain("repos: a on dev, review mode agile (the workspace's); b on main, review mode truest (its own)");
    const context = sessionStartContext(workspace, false, "a");
    expect(context).toContain("- a on `dev`, agile mode (the workspace's)");
    expect(context).toContain("- b on `main`, truest mode (its own)");
  });

  test("the review mode is not empty while every repo has a mode of its own, though the workspace has none", () => {
    withStore((store) => {
      const both = { a: { base_branch: "dev", review_mode: "agile" }, b: { base_branch: "main", review_mode: "truest" } };
      writeSetting(store, HUMAN, "repos", both);
      store.recordSettingChange(HUMAN, { key: "review_mode", oldValue: null, newValue: "null" });
      expect(readSettings(store).review_mode).toBeNull();
      expect(emptySettings(readSettings(store))).toEqual([]);
      writeSetting(store, HUMAN, "repos", { ...both, a: { base_branch: "dev" } });
      expect(emptySettings(readSettings(store))).toEqual(["review_mode"]);
    });
  });

  test("settings_set passes on the Human's mode for a repo, keeps it when left out, and workspace takes it away", () => {
    withStore((store) => {
      const context = { projectDir: workspace };
      const set = settingsSet(store, PLANNER, { repos: { a: { base_branch: "dev", review_mode: "truest" } } }, context);
      expect(set.settings.repos?.a).toEqual({ base_branch: "dev", review_mode: "truest" });
      const chosen = store.newestSettingChange("review_mode", "a");
      expect(chosen).toMatchObject({ repo: "a", oldValue: null, newValue: '"truest"', how: "planner" });
      expect(chosen?.createdBy).toMatchObject({ kind: "agent", role: "planner" });
      // A new base branch keeps the repo's own mode: leaving it out changes nothing.
      expect(settingsSet(store, PLANNER, { repos: { b: { base_branch: "release" } } }, context).settings.repos?.b).toEqual({ base_branch: "release", review_mode: "truest" });
      expect(settingsSet(store, PLANNER, { repos: { b: { base_branch: "main", review_mode: "workspace" } } }, context).settings.repos?.b).toEqual({ base_branch: "main" });
      expect(refusal(() => settingsSet(store, PLANNER, { repos: { a: { base_branch: "dev", review_mode: "fast" } } }, context)).code).toBe("invalid_input");
    });
  });

  test("an agent cannot set a repo's mode with no one to ask, as for the workspace's", () => {
    withStore((store) => {
      const context = { projectDir: workspace, unattended: true };
      const refused = refusal(() => settingsSet(store, PLANNER, { repos: { a: { base_branch: "dev", review_mode: "truest" } } }, context));
      expect(refused.message).toContain("a repo's review mode is the Human's choice, and no one can answer in this run");
      expect(refusal(() => settingsSet(store, PLANNER, { repos: { b: { base_branch: "main", review_mode: "workspace" } } }, context)).code).toBe("refused");
      // A change that leaves every repo's mode as it is goes through.
      expect(settingsSet(store, PLANNER, { repos: { b: { base_branch: "main", checks: ["true"] } } }, context).settings.repos?.b).toEqual({ base_branch: "main", checks: ["true"], review_mode: "truest" });
      expect(() => settingsSet(store, WORKER, { repos: { a: { base_branch: "dev", review_mode: "truest" } } }, { projectDir: workspace })).toThrow();
    });
  });
});

describe("tmb onboard in a workspace", () => {
  test("--repo with --review-mode sets that repo's own mode, and workspace takes it away", async () => {
    await runOnboard(setupOptions({ repo: "a", reviewMode: "truest", yes: true }));
    expect(withStore((store) => readSettings(store))).toMatchObject({ review_mode: "agile", repos: { a: { base_branch: "dev", review_mode: "truest" } } });
    await runOnboard(setupOptions({ repo: "b", reviewMode: "workspace", yes: true }));
    expect(withStore((store) => readSettings(store).repos?.b)).toEqual({ base_branch: "main", checks: [] });
    await expect(runOnboard(setupOptions({ repo: "a", reviewMode: "fast", yes: true }))).rejects.toThrow("review mode must be agile or truest");
    // Without --repo, --review-mode is the workspace's, and workspace is no mode of its own.
    await expect(runOnboard(setupOptions({ reviewMode: "workspace", yes: true }))).rejects.toThrow("review mode must be agile or truest");
  });

  test("on a terminal it asks the workspace's mode once, then offers the change per repo", async () => {
    const prompts: string[] = [];
    // role, workspace mode, the offer, then per repo: base, checks, mode.
    const answers = ["", "agile", "y", "", "", "truest", "", "", "workspace"];
    await runOnboard(setupOptions({}, scripted(answers, prompts)));
    expect(prompts.filter((prompt) => prompt.startsWith("Review mode, one of"))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.startsWith("Does any repo take a review mode"))).toHaveLength(1);
    expect(withStore((store) => readSettings(store).repos)).toEqual({ a: { base_branch: "dev", checks: [], review_mode: "truest" }, b: { base_branch: "main", checks: [] } });
  });

  // trustmybot/tmb#263: a workspace with no mode of its own, the repos api, tools and notes.
  async function workspaceOfThree(): Promise<void> {
    workspace = path.join(scratch, "todo");
    mkdirSync(workspace);
    for (const name of ["api", "tools", "notes"]) makeRepo(name, "main");
    await runInit(setupOptions());
    output = [];
  }
  const NO_MODE = "No review mode is chosen, so no task starts yet";
  const said = (text: string) => output.some((line) => line.includes(text));

  test("once every repo has a mode of its own, onboard no longer says none is chosen", async () => {
    await workspaceOfThree();
    await runOnboard(setupOptions({ repo: "api", reviewMode: "agile", yes: true }));
    expect(said(NO_MODE)).toBe(true);
    output = [];
    await runOnboard(setupOptions({ repo: "tools", reviewMode: "truest", yes: true }));
    expect(said(NO_MODE)).toBe(true);
    output = [];
    await runOnboard(setupOptions({ repo: "notes", reviewMode: "agile", yes: true }));
    expect(said("tools")).toBe(true);
    expect(said(NO_MODE)).toBe(false);
    // init run again says the same.
    output = [];
    await runInit(setupOptions());
    expect(said("No review mode is chosen")).toBe(false);
  });

  test("an exempt repo with no mode of its own does not count", async () => {
    await workspaceOfThree();
    await runOnboard(setupOptions({ repo: "api", reviewMode: "agile", yes: true }));
    await runOnboard(setupOptions({ repo: "tools", reviewMode: "truest", yes: true }));
    output = [];
    await runOnboard(setupOptions({ repo: "notes", exempt: true, yes: true }));
    expect(said(NO_MODE)).toBe(false);
  });

  test("answering no to the offer asks no repo's mode, and each repo follows the workspace's", async () => {
    const prompts: string[] = [];
    await runOnboard(setupOptions({}, scripted(["", "agile", "n", "", "", "", ""], prompts)));
    expect(prompts.some((prompt) => prompt.startsWith("Review mode of"))).toBe(false);
    expect(withStore((store) => readSettings(store).repos)).toEqual({ a: { base_branch: "dev", checks: [] }, b: { base_branch: "main", checks: [] } });
  });
});
