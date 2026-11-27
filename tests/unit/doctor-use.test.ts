// trustmybot/tmb#257: doctor says whether tmb is being used and its record is whole: work that went
// around it, a plugin record left behind, runs with no cost, tasks with no repo in a workspace,
// worktrees with none of tmb's wiring and how far behind the installed build is. Each is broken
// once here and found.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adapter as claudeCode } from "../../src/adapters/claude-code/index.ts";
import { PLUGIN_IMPORT } from "../../src/adapters/claude-code/migrate-plugin.ts";
import { HOST_ADAPTERS, type HostAdapter } from "../../src/adapters/index.ts";
import { sessionStartLine } from "../../src/doctor/index.ts";
import { howFarBehind } from "../../src/doctor/machine.ts";
import type { DoctorEnv } from "../../src/doctor/types.ts";
import { costCheck, pluginHistoryCheck, repoOfTasksCheck, unwiredWorktreesCheck, workAroundCheck } from "../../src/doctor/use.ts";
import { openProjectStore, readSettings, TMB_EVENT_TYPES, writeSetting } from "../../src/engine/index.ts";
import type { Actor, Store } from "../../src/engine/store/index.ts";
import { giveTasksTheirRepos } from "../../src/engine/task-repos.ts";
import { runInit } from "../../src/setup.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "claude-code" };
const COMMAND = ["/opt/tmb/bin/tmb"];

let root: string;
const savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };

function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repo on `branch` with one commit made long before any record. */
function repo(dir: string, branch = "main", origin?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", branch]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  if (origin !== undefined) git(dir, ["remote", "add", "origin", origin]);
  commit(dir, "first", "2020-01-01T00:00:00Z");
}

function commit(dir: string, subject: string, date: string): void {
  writeFileSync(path.join(dir, `${subject.replace(/\W+/g, "-")}.txt`), subject);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

function withStore<T>(dir: string, use: (store: Store) => T): T {
  const opened = openProjectStore(dir, { create: true });
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    return use(opened.store);
  } finally {
    opened.store.close();
  }
}

function env(cwd: string, overrides: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    program: { name: "tmb", channel: "stable" },
    version: "1.2.0",
    installed: null,
    stateDir: path.join(root, "state"),
    tmbCommand: COMMAND,
    adapters: HOST_ADAPTERS,
    cwd,
    path: "",
    platform: process.platform,
    isRunning: () => false,
    versionOf: () => null,
    gh: () => ({ installed: true, signedIn: true }),
    now: () => new Date(),
    ...overrides,
  };
}

/** A day after now, so a commit is surely after every task the test writes. */
const LATER = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tmb-doctor-use-"));
  process.env.XDG_CONFIG_HOME = path.join(root, ".no-xdg");
  process.env.GIT_CONFIG_GLOBAL = path.join(root, ".no-gitconfig");
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("work that went around tmb", () => {
  let project: string;
  beforeEach(() => {
    project = path.join(root, "app");
    repo(project, "main", "https://github.com/acme/app.git");
    withStore(project, (store) => {
      writeSetting(store, HUMAN, "base_branch", "main");
      const issue = store.createIssue(HUMAN, { title: "An issue" });
      const task = store.appendTask(PLANNER, { issueId: issue, title: "A task" });
      store.updateTask(PLANNER, task, { prUrl: "https://github.com/acme/app/pull/5" });
    });
  });

  test("nothing on the base branch since the record was made: fine", () => {
    const finding = withStore(project, (store) => workAroundCheck(env(project), project, store, readSettings(store)));
    expect(finding.status).toBe("ok");
    expect(finding.summary).toContain("git alone: gh is not signed in");
  });

  test("over the record's whole life: count, share and newest date; a task's commit, a feature branch merged locally and a recorded pull request are the record's own", () => {
    commit(project, "by hand", LATER);
    commit(project, "the task's own (#5)", LATER);
    commit(project, "another by hand (#9)", LATER);
    commit(project, "a task's commit, no pull request", LATER);
    const taskCommit = git(project, ["rev-parse", "HEAD"]);
    const base = taskCommit;
    // A feature branch merged with no remote (trustmybot/tmb#183): only the record's feature proves it.
    git(project, ["checkout", "-q", "-b", "feat-x"]);
    commit(project, "on the feature branch", LATER);
    git(project, ["checkout", "-q", "main"]);
    git(project, ["merge", "-q", "--no-ff", "-m", "merge feat-x", "feat-x"], { GIT_AUTHOR_DATE: LATER, GIT_COMMITTER_DATE: LATER });
    withStore(project, (store) => {
      const issue = store.createIssue(HUMAN, { title: "More" });
      const task = store.appendTask(PLANNER, { issueId: issue, title: "Done" });
      store.updateTask(PLANNER, task, { commitSha: taskCommit });
      store.createFeature(PLANNER, { name: "feat-x", baseBranch: "main", baseCommit: base });
      // A task made after all of it does not hide what went around the record.
      store.appendTask(PLANNER, { issueId: issue, title: "Newest" });
    });
    const asked: string[] = [];
    const merged = (dir: string, since: string) => (asked.push(`${dir} ${since}`), { numbers: [5, 9, 11] });
    const finding = withStore(project, (store) => workAroundCheck(env(project, { mergedPulls: merged }), project, store, readSettings(store)));
    const today = new Date().toISOString().slice(0, 10);
    expect(finding.status).toBe("warn");
    expect(finding.summary).toBe(`2 of 5 commits on base branches (40%) and 2 pull requests merged since the record was made (${today}) went around the record, with no task; the newest commit is from ${LATER.slice(0, 10)}`);
    expect(finding.details).toEqual(["app: 2 of 5 commits on main, 2 pull requests merged"]);
    expect(finding.fix!.say).toContain("a push typed by hand is still allowed");
    expect(asked).toHaveLength(1);
  });

  test("with no GitHub to ask, git alone counts, and says so", () => {
    commit(project, "by hand", LATER);
    const finding = withStore(project, (store) =>
      workAroundCheck(env(project, { mergedPulls: () => ({ why: "GitHub could not be asked: no network" }) }), project, store, readSettings(store)),
    );
    expect(finding.status).toBe("warn");
    expect(finding.summary).toStartWith("1 of 1 commit on base branches (100%) since the record was made");
    expect(finding.summary).toEndWith("(git alone: GitHub could not be asked: no network)");
  });

  test("the planner's session start carries one line, and does not ask GitHub", () => {
    commit(project, "by hand", LATER);
    claudeCode.setup(project, COMMAND);
    let asked = 0;
    const line = sessionStartLine(env(project, { mergedPulls: () => (asked++, { numbers: [] }) }));
    expect(line).toMatch(/^\d+ things? needs? a look: `tmb doctor`$/);
    expect(asked).toBe(0);
  });
});

/** A plugin record of version 76's shape, as far as doctor reads it, with rows in `rows` per repo. */
function pluginRecord(dir: string, rows: Record<string, { issues: number; tasks: number; runs: number }>): void {
  mkdirSync(path.join(dir, ".claude", "tmb"), { recursive: true });
  const db = new Database(path.join(dir, ".claude", "tmb", "trajectory.db"));
  db.run("CREATE TABLE issues (id INTEGER PRIMARY KEY, repo TEXT)");
  db.run("CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER, repo TEXT)");
  db.run("CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, task_id INTEGER)");
  db.run("INSERT INTO issues (id, repo) VALUES (-1, NULL)");
  for (const [name, counts] of Object.entries(rows)) {
    let issue = 0;
    for (let i = 0; i < counts.issues; i++) issue = (db.query("INSERT INTO issues (repo) VALUES (?) RETURNING id").get(name) as { id: number }).id;
    let task = 0;
    for (let i = 0; i < counts.tasks; i++) task = (db.query("INSERT INTO tasks (issue_id, repo) VALUES (?, NULL) RETURNING id").get(issue) as { id: number }).id;
    for (let i = 0; i < counts.runs; i++) db.query("INSERT INTO agent_runs (task_id) VALUES (?)").run(task);
  }
  db.close();
}

describe("a plugin record beside this one", () => {
  let folder: string;
  beforeEach(() => {
    folder = path.join(root, "work");
    repo(path.join(folder, "tmb"));
    repo(path.join(folder, "plugin"));
    pluginRecord(folder, { tmb: { issues: 2, tasks: 1, runs: 1 }, plugin: { issues: 3, tasks: 2, runs: 4 } });
    withStore(folder, (store) => store.recordImport(HUMAN, { source: PLUGIN_IMPORT, repo: "tmb", detail: { repo: "tmb", into: null, ids: { tasks: {} } } }));
  });

  test("repos not named yet: the counts left behind, and the two steps, init first", () => {
    const finding = withStore(folder, (store) => pluginHistoryCheck(env(folder), folder, store, readSettings(store)));
    expect(finding.status).toBe("warn");
    expect(finding.summary).toContain("holds 1 repo no migration brought here");
    expect(finding.details).toEqual(["plugin repo plugin: 3 issues, 2 tasks, 4 runs"]);
    expect(finding.fix!.say).toBe("two steps: `tmb init` again in the project folder, which names its repos; then `tmb migrate --repo plugin`");
  });

  test("repos named: the migrate step alone, with --into where the workspace has no repo of that name", () => {
    withStore(folder, (store) => writeSetting(store, HUMAN, "repos", { tmb: { base_branch: "main" }, plugin: { base_branch: "main" } }));
    const named = withStore(folder, (store) => pluginHistoryCheck(env(folder), folder, store, readSettings(store)));
    expect(named.fix!.say).toBe("`tmb migrate --repo plugin`");
    withStore(folder, (store) => writeSetting(store, HUMAN, "repos", { tmb: { base_branch: "main" }, "tmb-plugin": { base_branch: "main" } }));
    const renamed = withStore(folder, (store) => pluginHistoryCheck(env(folder), folder, store, readSettings(store)));
    expect(renamed.fix!.say).toBe("`tmb migrate --repo plugin --into <workspace repo>`");
  });

  test("every plugin repo migrated: fine", () => {
    withStore(folder, (store) => store.recordImport(HUMAN, { source: PLUGIN_IMPORT, repo: "plugin", detail: { repo: "plugin", into: "plugin" } }));
    const finding = withStore(folder, (store) => pluginHistoryCheck(env(folder), folder, store, readSettings(store)));
    expect(finding.status).toBe("ok");
  });
});

describe("runs with no cost", () => {
  test("counted with their share of the ended runs", () => {
    const project = path.join(root, "app");
    repo(project);
    const finding = withStore(project, (store) => {
      expect(costCheck(store).status).toBe("ok");
      const priced = store.appendRun(PLANNER, { role: "worker" });
      store.endRun(PLANNER, priced, { cost: [{ model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }] });
      for (let i = 0; i < 3; i++) store.endRun(PLANNER, store.appendRun(PLANNER, { role: "worker" }));
      store.appendRun(PLANNER, { role: "worker" });
      return costCheck(store);
    });
    expect(finding.status).toBe("warn");
    expect(finding.summary).toBe("3 of 4 ended runs (75%) carry no cost");
    withStore(project, (store) => store.recordImport(HUMAN, { source: PLUGIN_IMPORT, detail: {} }));
    expect(withStore(project, costCheck).summary).toBe("3 of 4 ended runs (75%) carry no cost, runs migrated from the plugin included");
  });
});

describe("tasks that name no repo once the project is a workspace", () => {
  let folder: string;
  beforeEach(() => {
    folder = path.join(root, "work");
    repo(path.join(folder, "api"), "main", "git@github.com:acme/api.git");
    repo(path.join(folder, "web"), "main", "https://github.com/acme/web.git");
    git(path.join(folder, "api"), ["branch", "tmb/task-b"]);
  });

  test("doctor names them; init's step gives each the repo its migration, branch or pull request shows", () => {
    const ids = withStore(folder, (store) => {
      const issue = store.createIssue(HUMAN, { title: "Old work" });
      const migrated = store.appendTask(PLANNER, { issueId: issue, title: "From the plugin" });
      const branched = store.appendTask(PLANNER, { issueId: issue, title: "On a branch", branch: "tmb/task-b" });
      const pulled = store.appendTask(PLANNER, { issueId: issue, title: "With a pull request" });
      store.updateTask(PLANNER, pulled, { prUrl: "https://github.com/acme/web/pull/3" });
      const unknown = store.appendTask(PLANNER, { issueId: issue, title: "Nothing shows" });
      store.recordImport(HUMAN, { source: PLUGIN_IMPORT, repo: "web", detail: { repo: "web", into: null, ids: { tasks: { "7": migrated } } } });
      writeSetting(store, HUMAN, "repos", { api: { base_branch: "main" }, web: { base_branch: "main" } });
      return { migrated, branched, pulled, unknown };
    });
    const before = withStore(folder, (store) => repoOfTasksCheck(env(folder), store, readSettings(store)));
    expect(before.status).toBe("warn");
    expect(before.summary).toBe("4 tasks name no repo, so their runs and checks name none either");
    expect(before.fix!.say).toContain("`tmb init` again");

    const result = withStore(folder, (store) => giveTasksTheirRepos(store, HUMAN, folder, readSettings(store).repos!));
    expect(result.given).toEqual([
      { task: ids.migrated, repo: "web", from: "it was migrated from the plugin's repo web" },
      { task: ids.branched, repo: "api", from: "its branch tmb/task-b is there" },
      { task: ids.pulled, repo: "web", from: "its pull request is in acme/web" },
    ]);
    expect(result.left.map((task) => task.id)).toEqual([ids.unknown]);
    const after = withStore(folder, (store) => {
      expect(store.getTask(ids.branched)!.repo).toBe("api");
      return repoOfTasksCheck(env(folder), store, readSettings(store));
    });
    expect(after.summary).toBe("1 task names no repo, so its runs and checks name none either");
    expect(after.details).toEqual([`task ${ids.unknown} "Nothing shows"`]);
  });

  test("init run again in the folder names the repos and gives the old tasks theirs, saying each", async () => {
    const id = withStore(folder, (store) => store.appendTask(PLANNER, { issueId: store.createIssue(HUMAN, { title: "Old" }), title: "On a branch", branch: "tmb/task-b" }));
    const host: HostAdapter = {
      id: "a",
      name: "Host A",
      command: "host-a",
      reconnectToolServer: "restart Host A",
      limits: { canDenyToolCall: true, modelPerRole: true, namesAgentOnToolCall: true, events: TMB_EVENT_TYPES },
      detect: () => ({ installed: true }),
      setup: () => ["wired a"],
      remove: () => [],
      answerHook: () => "",
    };
    const output: string[] = [];
    await runInit({ projectDir: folder, tmbCommand: COMMAND, adapters: [host], supportedHostIds: ["a"], flags: {}, ask: null, out: (line: string) => output.push(line) });
    expect(output).toContain("  Tasks made before this was a workspace: 1 given their repo, 0 left with none.");
    expect(output).toContain(`  Gave task ${id} its repo api: its branch tmb/task-b is there.`);
    expect(withStore(folder, (store) => store.getTask(id)!.repo)).toBe("api");
  });

  test("two proofs that name different repos give none: the task stays for doctor to list", () => {
    const repos = { api: { base_branch: "main" }, web: { base_branch: "main" } };
    const id = withStore(folder, (store) => {
      const task = store.appendTask(PLANNER, { issueId: store.createIssue(HUMAN, { title: "x" }), title: "Torn", branch: "tmb/task-b" });
      store.updateTask(PLANNER, task, { prUrl: "https://github.com/acme/web/pull/3" });
      writeSetting(store, HUMAN, "repos", repos);
      return task;
    });
    const result = withStore(folder, (store) => giveTasksTheirRepos(store, HUMAN, folder, repos));
    expect(result.given).toEqual([]);
    expect(result.left.map((task) => task.id)).toEqual([id]);
  });

  test("a project of one repo needs no repo named", () => {
    const project = path.join(root, "app");
    repo(project);
    const finding = withStore(project, (store) => {
      store.appendTask(PLANNER, { issueId: store.createIssue(HUMAN, { title: "x" }), title: "t" });
      return repoOfTasksCheck(env(project), store, readSettings(store));
    });
    expect(finding.status).toBe("ok");
  });
});

describe("worktrees with none of tmb's wiring", () => {
  test("every worktree, inside the project folder or not, is named; the main folder and the record's task worktree are not", () => {
    const project = path.join(root, "app");
    repo(project);
    claudeCode.setup(project, COMMAND);
    withStore(project, (store) => {
      writeSetting(store, HUMAN, "host", "claude-code");
      writeSetting(store, HUMAN, "host_roles", { "claude-code": "planner" });
    });
    const check = () => withStore(project, (store) => unwiredWorktreesCheck(env(project), project, store, readSettings(store), COMMAND));
    expect(check().status).toBe("ok");
    const outside = path.join(root, "app-side");
    const inside = path.join(project, "lane-1");
    const tasks = path.join(root, "app-task");
    git(project, ["worktree", "add", "-q", "-b", "side", outside]);
    git(project, ["worktree", "add", "-q", "-b", "lane", inside]);
    git(project, ["worktree", "add", "-q", "-b", "tmb/t", tasks]);
    withStore(project, (store) => store.appendTask(PLANNER, { issueId: store.createIssue(HUMAN, { title: "x" }), title: "t", worktree: tasks }));
    const finding = check();
    expect(finding.status).toBe("warn");
    expect(finding.summary).toBe("2 worktrees of the project's repos have none of tmb's wiring: a session started there works without tmb's hooks or tool server");
    expect(finding.details!.map((line) => line.split(":")[0]).sort()).toEqual([inside, outside].sort());
  });

  test("many are counted, and only the first few listed", () => {
    const project = path.join(root, "app");
    repo(project);
    claudeCode.setup(project, COMMAND);
    withStore(project, (store) => writeSetting(store, HUMAN, "host", "claude-code"));
    for (let i = 0; i < 8; i++) git(project, ["worktree", "add", "-q", "-b", `lane-${i}`, path.join(root, `lane-${i}`)]);
    const finding = withStore(project, (store) => unwiredWorktreesCheck(env(project), project, store, readSettings(store), COMMAND));
    expect(finding.summary).toStartWith("8 worktrees");
    expect(finding.details).toHaveLength(6);
    expect(finding.details![5]).toBe("and 3 more");
  });
});

describe("how far behind the installed build is", () => {
  test("in builds on one line, and in days between the two files", () => {
    const installed = path.join(root, "tmb-dev");
    const newer = path.join(root, "staged");
    writeFileSync(installed, "");
    writeFileSync(newer, "");
    const day = 24 * 60 * 60;
    const now = Date.now() / 1000;
    utimesSync(installed, now - 12 * day, now - 12 * day);
    utimesSync(newer, now, now);
    expect(howFarBehind("0.1.0-dev.78", "0.1.0-dev.128", installed, newer)).toBe("50 builds and 12 days behind");
    expect(howFarBehind("1.0.0", "1.1.0", installed, newer)).toBe("12 days behind");
    utimesSync(installed, now, now);
    expect(howFarBehind("1.0.0", "1.1.0", installed, newer)).toBeNull();
  });
});
