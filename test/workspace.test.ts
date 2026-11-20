// A workspace (trustmybot/tmb#163): a folder that is not a git work tree, holding two repos that
// share one record. Repo a merges into dev, repo b into main, each with its own bare origin and
// its own checks. init registers both, gates both and indexes both; a feature or task is cut in
// the repo it names, from that repo's base branch; a close runs that repo's checks and folds and
// pushes there; the push gate judges each repo against its own base branch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HostAdapter } from "../src/adapters/index.ts";
import { graphDbPath } from "../src/engine/graph/db.ts";
import { featureStart, HandlerError, issueCreate, settingsSet, taskClose, taskStart } from "../src/engine/handlers/index.ts";
import { judgePush, openProjectStore, readSettings, removePushGates, TMB_EVENT_TYPES, writeSetting } from "../src/engine/index.ts";
import { scanRepos } from "../src/engine/repos.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";
import { runInit, runOnboard, type SetupFlags } from "../src/setup.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-a" };
const ZERO = "0".repeat(40);

let scratch: string;
let workspace: string;
let output: string[];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repo in the workspace on `base`, with a bare origin that holds it and names it as its default. */
function makeRepo(name: string, base: string): string {
  const dir = path.join(workspace, name);
  const origin = path.join(scratch, `${name.replace(/\//g, "-")}-origin.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", base);
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.com");
  writeFileSync(path.join(dir, "README.md"), `${name}\n`);
  writeFileSync(path.join(dir, "main.ts"), `export function hello${name.replace(/\W/g, "")}() {}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `first in ${name}`);
  git(scratch, "init", "-q", "--bare", "-b", base, origin);
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", base);
  git(dir, "remote", "set-head", "origin", base);
  return dir;
}

/** A host adapter whose setup only creates the record, as every real one does first. */
const HOST: HostAdapter = {
  id: "a",
  name: "Host A",
  command: "host-a",
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

/** The hooks init writes run this checkout's tmb, so a push in a test goes through the real gate. */
const TMB_COMMAND = [process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts")];

function setupOptions(flags: SetupFlags = {}) {
  return { projectDir: workspace, tmbCommand: TMB_COMMAND, adapters: [HOST], supportedHostIds: ["a"], flags, ask: null, out: (line: string) => output.push(line) };
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

function hookOf(repo: string): string {
  return path.join(workspace, repo, ".git", "hooks", "pre-push");
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

let a: string;
let b: string;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-workspace-")));
  workspace = path.join(scratch, "workspace");
  mkdirSync(workspace);
  output = [];
  a = makeRepo("a", "dev");
  b = makeRepo("b", "main");
  // A linked worktree in the workspace has a .git file, never a repo of its own.
  git(a, "worktree", "add", "-q", "-b", "side", path.join(workspace, "a-side"));
  await runInit(setupOptions());
  withStore((store) => {
    // Each repo's own checks: a's leaves a mark in its worktree, b's fails, so a mixed-up close shows.
    writeSetting(store, HUMAN, "repos", {
      a: { base_branch: "dev", checks: ["touch checked-in-a"] },
      b: { base_branch: "main", checks: ["false"] },
    });
  });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("init in a workspace", () => {
  test("finds both repos with their own base branches, gates and indexes each, and skips a linked worktree", () => {
    expect(scanRepos(workspace)).toEqual(["a", "b"]);
    expect(output).toContain("  Added repo a: base branch dev, from origin's default branch.");
    expect(output).toContain("  Added repo b: base branch main, from origin's default branch.");
    for (const repo of ["a", "b"]) {
      expect(readFileSync(hookOf(repo), "utf8")).toContain("# tmb: the push gate.");
      expect(statSync(hookOf(repo)).mode & 0o111).not.toBe(0);
      expect(existsSync(graphDbPath(workspace, repo))).toBe(true);
    }
    expect(output.some((line) => line.startsWith("Indexed the code graph of a from dev"))).toBe(true);
    expect(output.some((line) => line.startsWith("Indexed the code graph of b from main"))).toBe(true);
    expect(existsSync(graphDbPath(workspace))).toBe(false);
  });

  test("init again keeps each repo's policy, adds a new repo and drops a gone one", async () => {
    makeRepo("tools/c", "trunk");
    rmSync(b, { recursive: true, force: true });
    output = [];
    await runInit(setupOptions());
    const repos = withStore((store) => readSettings(store).repos);
    expect(repos).toEqual({ a: { base_branch: "dev", checks: ["touch checked-in-a"] }, "tools/c": { base_branch: "trunk", checks: [] } });
    expect(output).toContain("  Added repo tools/c: base branch trunk, from origin's default branch.");
    expect(output).toContain("  Dropped repo b: it is no longer a repo in this folder.");
    expect(existsSync(path.join(workspace, "tools", "c", ".git", "hooks", "pre-push"))).toBe(true);
  });

  test("tmb remove deletes the hook from every registered repo", () => {
    removePushGates(workspace);
    expect(existsSync(hookOf("a"))).toBe(false);
    expect(existsSync(hookOf("b"))).toBe(false);
  });

  test("onboard sets one repo by --repo, and refuses --base without one", async () => {
    await expect(runOnboard(setupOptions({ base: "release" }))).rejects.toThrow("name the one --base, --check or --exempt sets with --repo");
    await runOnboard(setupOptions({ repo: "b", base: "release", checks: ["true"] }));
    expect(withStore((store) => readSettings(store).repos)).toEqual({
      a: { base_branch: "dev", checks: ["touch checked-in-a"] },
      b: { base_branch: "release", checks: ["true"] },
    });
    await runOnboard(setupOptions({ repo: "b", exempt: true }));
    expect(withStore((store) => readSettings(store).repos?.b?.exempt)).toBe(true);
  });
});

describe("settings in a workspace", () => {
  test("settings_set takes repos for a registered repo, and refuses base_branch and checks", () => {
    withStore((store) => {
      const context = { projectDir: workspace };
      expect(refusal(() => settingsSet(store, PLANNER, { base_branch: "dev" }, context)).message).toContain("set base_branch for a repo through repos");
      expect(refusal(() => settingsSet(store, PLANNER, { repos: { zz: { base_branch: "x" } } }, context)).code).toBe("not_found");
      const set = settingsSet(store, PLANNER, { repos: { b: { base_branch: "main", checks: ["true"] } } }, context);
      expect(set.changed).toEqual(["repos"]);
      expect(set.settings.repos).toEqual({ a: { base_branch: "dev", checks: ["touch checked-in-a"] }, b: { base_branch: "main", checks: ["true"] } });
      expect(set.empty).toEqual(["review_mode"]);
    });
  });
});

describe("features and tasks in a workspace", () => {
  let store: Store;
  let issueId: string;
  const context = () => ({ projectDir: workspace });

  beforeEach(() => {
    const opened = openProjectStore(workspace, { create: false });
    if (!opened.ok) throw opened.error;
    store = opened.store;
    writeSetting(store, HUMAN, "review_mode", "agile");
    issueId = issueCreate(store, HUMAN, { title: "The goal" }).id;
  });

  afterEach(() => {
    store.close();
  });

  test("feature_start refuses a call that names no repo, listing both, and cuts in the named repo from its base", () => {
    const refused = refusal(() => featureStart(store, PLANNER, { name: "feat/x" }, context()));
    expect(refused.message).toContain("this workspace has 2 repos (a, b); name the one this works in with repo");
    expect(refusal(() => featureStart(store, PLANNER, { name: "feat/x", repo: "zz" }, context())).code).toBe("not_found");

    git(a, "commit", "-q", "--allow-empty", "-m", "latest on dev");
    const started = featureStart(store, PLANNER, { name: "feat/x", repo: "a" }, context());
    expect(started).toMatchObject({ name: "feat/x", repo: "a", baseBranch: "dev", baseCommit: git(a, "rev-parse", "dev") });
    expect(git(a, "rev-parse", "feat/x")).toBe(git(a, "rev-parse", "dev"));
    expect(git(b, "branch", "--list", "feat/x")).toBe("");
    // A feature name is unique in the whole record, whichever repo it is in.
    expect(refusal(() => featureStart(store, PLANNER, { name: "feat/x", repo: "b" }, context())).message).toContain("already holds a feature branch");
  });

  test("an agile task inherits its feature's repo, runs that repo's checks, folds and pushes there", async () => {
    featureStart(store, PLANNER, { name: "feat/x", repo: "a" }, context());
    const spec = { issue_id: issueId, kind: "code", feature: "feat/x", intent: "Change a", files: ["src"], criteria: ["SC1"] };
    expect(refusal(() => taskStart(store, PLANNER, { ...spec, repo: "b" }, context())).message).toContain("is in the repo a, not b");
    const started = taskStart(store, PLANNER, spec, context());
    expect(started.brief.repo).toBe("a");
    expect(started.worktree.startsWith(path.join(workspace, ".tmb", "worktrees"))).toBe(true);
    expect(git(started.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(a, ".git"));

    mkdirSync(path.join(started.worktree, "src"));
    writeFileSync(path.join(started.worktree, "src", "one.ts"), "one\n");
    git(started.worktree, "add", "src");
    git(started.worktree, "commit", "-q", "-m", "one");
    const head = git(started.worktree, "rev-parse", "HEAD");

    const closed = await taskClose(store, WORKER, { id: started.id }, context());
    expect(closed.checks.map((check) => [check.command, check.status])).toEqual([["touch checked-in-a", "passed"]]);
    expect(closed.fold).toMatchObject({ feature: "feat/x", to: head });
    expect(git(a, "rev-parse", "feat/x")).toBe(head);
    // The backup push goes through a's own pre-push hook, which runs this tmb's gate.
    expect(closed.push).toMatchObject({ result: "pushed" });
    expect(git(a, "ls-remote", "origin", "refs/heads/feat/x")).toStartWith(head);
  });

  test("a truest task names its repo and is cut there from that repo's base branch", () => {
    writeSetting(store, HUMAN, "review_mode", "truest");
    const spec = { issue_id: issueId, kind: "code", intent: "Change b", files: ["src"], criteria: ["SC1"] };
    expect(refusal(() => taskStart(store, PLANNER, spec, context())).message).toContain("name the one this works in with repo");
    const started = taskStart(store, PLANNER, { ...spec, repo: "b" }, context());
    expect(started.brief.repo).toBe("b");
    expect(git(started.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(path.join(b, ".git"));
    expect(git(started.worktree, "rev-parse", "HEAD")).toBe(git(b, "rev-parse", "main"));
    expect(started.brief.checks).toEqual(["false"]);
  });
});

describe("the push gate in a workspace", () => {
  /** The ref line git passes the hook for a push of HEAD to `branch`, with the remote's sha. */
  function pushLine(dir: string, branch: string): string {
    const remote = git(dir, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] || ZERO;
    return `refs/heads/${branch} ${git(dir, "rev-parse", "HEAD")} refs/heads/${branch} ${remote}\n`;
  }

  function judge(dir: string, branch: string) {
    return judgePush(workspace, "origin", pushLine(dir, branch), dir);
  }

  beforeEach(() => {
    withStore((store) => writeSetting(store, HUMAN, "review_mode", "agile"));
    for (const [dir, base] of [[a, "dev"], [b, "main"]] as const) {
      mkdirSync(path.join(dir, "nested", "deeper"), { recursive: true });
      writeFileSync(path.join(dir, "nested", "deeper", "hotfix.txt"), "fix\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", `a hotfix straight on ${base}`);
    }
  });

  test("refuses an unreviewed push to each repo's own base, from the repo and from a nested folder", () => {
    for (const [dir, base] of [[a, "dev"], [b, "main"]] as const) {
      for (const from of [dir, path.join(dir, "nested", "deeper")]) {
        const decision = judge(from, base);
        expect(decision.decision).toBe("deny");
        expect(decision.reason).toContain(`onto the base branch ${base}`);
      }
    }
  });

  test("does not judge another repo's base branch as this one's", () => {
    // b's base is main, so a push of b's work to a branch named dev is not a push to a base branch.
    expect(judge(b, "dev").decision).toBe("allow");
    // a's base is dev, so main in a is any other branch.
    expect(judge(a, "main").decision).toBe("allow");
  });

  test("a push from an unregistered or exempt repo is allowed, and the reason says why", () => {
    const stray = makeRepo("stray", "main");
    const decision = judge(stray, "main");
    expect(decision).toMatchObject({ decision: "allow" });
    expect(decision.reason).toContain("does not register, or registers as exempt");

    withStore((store) => writeSetting(store, HUMAN, "repos", { a: { base_branch: "dev" }, b: { exempt: true } }));
    expect(judge(b, "main").decision).toBe("allow");
    expect(judge(a, "dev").decision).toBe("deny");
  });

  test("a push from a task worktree is judged by the repo it was cut from", () => {
    const worktree = path.join(scratch, "wt");
    git(a, "worktree", "add", "-q", "-b", "wt-branch", worktree, "dev");
    expect(judgePush(workspace, "origin", pushLine(worktree, "dev"), worktree).decision).toBe("deny");
  });
});

describe("one rule for where the record is", () => {
  test("no module but project.ts names the record's file", () => {
    const src = path.join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.tsx?$/.test(entry.name) && readFileSync(file, "utf8").includes("trajectory.db")) offenders.push(path.relative(src, file).split(path.sep).join("/"));
      }
    };
    walk(src);
    // migrate-plugin.ts names the plugin's own database, which is not tmb's record.
    expect(offenders.sort()).toEqual(["adapters/claude-code/migrate-plugin.ts", "engine/project.ts"]);
  });
});
