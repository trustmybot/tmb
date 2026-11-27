import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "../../src/engine/ids.ts";
import { type Decision, decide, openProjectStore, PROJECT_DIR_NAME, projectDbPath, projectRootOf, type TmbEvent } from "../../src/engine/index.ts";
import type { GuardDecision, Store } from "../../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-decide-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function event(fields: Partial<TmbEvent> = {}): TmbEvent {
  return { type: "before-file-write", projectDir: project, host: "host-a", role: "planner", action: "src/a.ts", ...fields };
}

function createRecord(): void {
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  opened.store.close();
}

function guardDecisions(): GuardDecision[] {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return opened.store.listGuardDecisions();
  } finally {
    opened.store.close();
  }
}

describe("decide", () => {
  test("allows in a project with no record, and creates nothing", () => {
    expect(decide(event())).toEqual({ decision: "allow" });
    expect(existsSync(path.dirname(projectDbPath(project)))).toBe(false);
  });

  test("denies when the record cannot be read, naming the cause", () => {
    mkdirSync(path.dirname(projectDbPath(project)), { recursive: true });
    writeFileSync(projectDbPath(project), "this is not a database, only text long enough to look like a header");
    const answer = decide(event());
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("cannot read the project's record");
    expect(answer.reason).toContain("trajectory.db");
  });

  test("denies when the record file is there but empty: a damaged record, not a missing one (#185)", () => {
    mkdirSync(path.dirname(projectDbPath(project)), { recursive: true });
    writeFileSync(projectDbPath(project), "");
    const answer = decide(event());
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("cannot read the project's record");
    expect(answer.reason).toContain("is empty");
  });

  test("denies when a newer tmb made the record, saying so", () => {
    createRecord();
    const db = new Database(projectDbPath(project));
    db.run("PRAGMA user_version = 99");
    db.close();
    const answer = decide(event());
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("newer tmb");
    expect(answer.reason).toContain("upgrade tmb");
  });

  test("with a readable record, allows and records each decision under the role and host", () => {
    createRecord();
    expect(decide(event({ type: "before-file-write", role: "worker", task: "T1", action: "src/a.ts" }))).toEqual({ decision: "allow" });
    expect(decide(event({ type: "before-file-write", action: "src/b.ts" }))).toEqual({ decision: "allow" });

    const recorded = guardDecisions();
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ decision: "allow", reason: "no rule denies it", createdBy: { kind: "agent", role: "worker", host: "host-a" } });
    expect(JSON.parse(recorded[0]!.event)).toEqual({ type: "before-file-write", role: "worker", task: "T1", action: "src/a.ts" });
    expect(recorded[1]!.createdBy).toEqual({ kind: "agent", role: "planner", host: "host-a" });
    expect(JSON.parse(recorded[1]!.event)).toEqual({ type: "before-file-write", role: "planner", action: "src/b.ts" });
  });

  test("records a subagent that is not a tmb role under the planner, keeping its own role in the event", () => {
    createRecord();
    expect(decide(event({ type: "before-agent-start", role: "Explore", action: "general-purpose" })).decision).toBe("allow");
    const [recorded] = guardDecisions();
    expect(recorded!.createdBy).toEqual({ kind: "agent", role: "planner", host: "host-a" });
    expect(JSON.parse(recorded!.event)).toMatchObject({ type: "before-agent-start", role: "Explore", action: "general-purpose" });
  });

  test("denies when the decision cannot be recorded", () => {
    createRecord();
    const answer = decide(event({ host: " " }));
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("could not record its decision");
    expect(guardDecisions()).toHaveLength(0);
  });
});

describe("the worker gate", () => {
  const PLANNER = { kind: "agent", role: "planner", host: "host-a" } as const;

  function withStore<T>(use: (store: Store) => T): T {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    try {
      return use(opened.store);
    } finally {
      opened.store.close();
    }
  }

  /** An open task whose worktree folder exists; the gate reads only the record and the folder. */
  function openTask(state = "open", repo?: string | null): string {
    const worktree = mkdtempSync(path.join(project, "wt-"));
    return withStore((store) => {
      const issueId = store.createIssue(PLANNER, { title: "goal" });
      return store.appendTask(PLANNER, { issueId, title: "task", spec: "{}", state, worktree, ...(repo === undefined ? {} : { repo }) });
    });
  }

  function workerStart(prompt: string, startFolder?: string): Decision {
    return decide(event({ type: "before-agent-start", role: "worker", action: prompt, ...(startFolder === undefined ? {} : { startFolder }) }));
  }

  function gitInit(dir: string): void {
    mkdirSync(dir, { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: dir, timeout: 10_000 }).status).toBe(0);
  }

  test("denies a worker start whose prompt names no task, a task not in the record, a closed task or a missing worktree", () => {
    createRecord();
    const closed = openTask("closed");
    const gone = openTask();
    withStore((store) => rmSync(store.getTask(gone)!.worktree!, { recursive: true }));
    const cases: [string, string][] = [
      ["just do it", "names no task"],
      [`task_id=${newId()}`, "is in the record"],
      [`task_id=${closed}`, "is closed"],
      [`task_id=${gone}`, "is missing"],
    ];
    for (const [prompt, why] of cases) {
      const answer = workerStart(prompt);
      expect(answer.decision).toBe("deny");
      expect(answer.reason).toContain(why);
      expect(answer.reason).toContain("task_start");
    }
    withStore((store) => expect(store.openRuns("worker")).toEqual([]));
    expect(guardDecisions().map((decision) => decision.decision)).toEqual(["deny", "deny", "deny", "deny"]);
  });

  test("allows a worker start naming an open task with its worktree, recording a run start; the stop ends it", () => {
    createRecord();
    const taskId = openTask();
    const answer = workerStart(`Carry out the task.\ntask_id=${taskId.toLowerCase()}`);
    expect(answer.decision).toBe("allow");
    const [run] = withStore((store) => store.openRuns("worker"));
    expect(run).toMatchObject({ taskId, role: "worker", endedAt: null, createdBy: { kind: "agent", role: "worker", host: "host-a" } });
    expect(run!.startedAt).toBeString();

    expect(decide(event({ type: "after-agent-stop", role: "worker", action: "worker" })).decision).toBe("allow");
    withStore((store) => {
      expect(store.openRuns("worker")).toEqual([]);
      expect(store.history(run!.id).map((e) => e.type)).toEqual(["created", "updated"]);
    });
    expect(guardDecisions().map((decision) => decision.reason)).toEqual([
      expect.stringContaining(`started on open task ${taskId}`),
      `worker run ${run!.id} ended, stopped`,
    ]);
  });

  test("a stop that names no task ends nothing while several worker runs are open; one naming its task ends that run", () => {
    createRecord();
    const first = openTask();
    const second = openTask();
    workerStart(`task_id=${first}`);
    workerStart(`task_id=${second}`);
    decide(event({ type: "after-agent-stop", role: "worker", action: "worker" }));
    withStore((store) => expect(store.openRuns("worker").map((run) => run.taskId)).toEqual([first, second]));
    expect(guardDecisions().at(-1)!.reason).toContain("none was ended");

    decide(event({ type: "after-agent-stop", role: "worker", task: second, action: "worker" }));
    withStore((store) => expect(store.openRuns("worker").map((run) => run.taskId)).toEqual([first]));
  });

  test("a new worker start on a task ends that task's older open run as stopped, so the next stop ends the new one (trustmybot/tmb#459)", () => {
    createRecord();
    const taskId = openTask();
    const other = openTask();
    workerStart(`task_id=${taskId}`);
    workerStart(`task_id=${other}`);
    const [crashed] = withStore((store) => store.openRuns("worker", taskId));
    workerStart(`task_id=${taskId}`);
    withStore((store) => {
      expect(store.getRun(crashed!.id)).toMatchObject({ outcome: "stopped", cost: null });
      expect(store.getRun(crashed!.id)!.endedAt).toBeString();
      expect(store.openRuns("worker", taskId).map((run) => run.id)).not.toContain(crashed!.id);
      expect(store.openRuns("worker").map((run) => run.taskId)).toEqual([other, taskId]);
    });
  });

  test("a worker run whose task left the open state ends finished, and keeps the cost its stop carried", () => {
    createRecord();
    const taskId = openTask();
    workerStart(`task_id=${taskId}`);
    const [run] = withStore((store) => store.openRuns("worker"));
    withStore((store) => store.updateTask(PLANNER, taskId, { state: "in_review" }));
    const cost = [{ model: "claude-opus-5-5", inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 }];
    expect(decide(event({ type: "after-agent-stop", role: "worker", action: "worker", cost })).reason).toBe(`worker run ${run!.id} ended, finished`);
    withStore((store) => expect(store.getRun(run!.id)).toMatchObject({ outcome: "finished", cost }));
  });

  test("a reviewer run that recorded no review ends stopped, with no cost when its stop carried none", () => {
    createRecord();
    decide(event({ type: "before-agent-start", role: "reviewer", action: "review" }));
    const [run] = withStore((store) => store.openRuns("reviewer"));
    decide(event({ type: "after-agent-stop", role: "reviewer", action: "reviewer" }));
    withStore((store) => expect(store.getRun(run!.id)).toMatchObject({ outcome: "stopped", cost: null }));
  });

  test("records a reviewer's start and stop as a run with no task", () => {
    createRecord();
    expect(decide(event({ type: "before-agent-start", role: "reviewer", action: "review" })).decision).toBe("allow");
    withStore((store) => expect(store.openRuns("reviewer").map((run) => run.taskId)).toEqual([null]));
    expect(decide(event({ type: "after-agent-stop", role: "reviewer", action: "reviewer" })).reason).toContain("ended");
    withStore((store) => expect(store.openRuns("reviewer")).toEqual([]));
  });

  test("leaves other roles' starts and stops as they were: allowed, with no run", () => {
    createRecord();
    expect(decide(event({ type: "before-agent-start", role: "explorer", action: "look" }))).toEqual({ decision: "allow" });
    expect(decide(event({ type: "after-agent-stop", role: "explorer", action: "explorer" }))).toEqual({ decision: "allow" });
    withStore((store) => expect([...store.openRuns("worker"), ...store.openRuns("reviewer")]).toEqual([]));
  });

  test("a worker start the host failed to make ends its run stopped, so the next stop is not left with two open runs (trustmybot/tmb#285)", () => {
    createRecord();
    const first = openTask();
    const second = openTask();
    workerStart(`task_id=${first}`);
    workerStart(`task_id=${second}`);
    const [, failed] = withStore((store) => store.openRuns("worker"));

    const answer = decide(event({ type: "agent-start-failed", role: "worker", action: `task_id=${second}` }));
    expect(answer).toEqual({ decision: "allow", reason: `worker run ${failed!.id} ended, stopped: its start failed, so no worker ran` });
    withStore((store) => {
      expect(store.getRun(failed!.id)).toMatchObject({ outcome: "stopped", cost: null });
      expect(store.openRuns("worker").map((run) => run.taskId)).toEqual([first]);
    });
    // The worker that did start stops; with one run open, its stop ends it.
    expect(decide(event({ type: "after-agent-stop", role: "worker", action: "worker" })).reason).toContain("ended");
    withStore((store) => expect(store.openRuns("worker")).toEqual([]));
  });

  test("a failed start ends nothing when no run of its own is open, and a failed reviewer start ends the reviewer run", () => {
    createRecord();
    const taskId = openTask();
    expect(decide(event({ type: "agent-start-failed", role: "worker", action: `task_id=${taskId}` })).reason).toContain("no worker run on task");
    expect(decide(event({ type: "agent-start-failed", role: "worker", action: "no task" })).reason).toContain("opened no run");
    workerStart(`task_id=${taskId}`);
    // Another host's failure is not this host's run.
    decide(event({ type: "agent-start-failed", role: "worker", host: "host-b", action: `task_id=${taskId}` }));
    withStore((store) => expect(store.openRuns("worker").map((run) => run.taskId)).toEqual([taskId]));

    decide(event({ type: "before-agent-start", role: "reviewer", action: "review" }));
    decide(event({ type: "agent-start-failed", role: "reviewer", action: "review" }));
    withStore((store) => expect(store.openRuns("reviewer")).toEqual([]));
    expect(decide(event({ type: "agent-start-failed", role: "explorer", action: "look" }))).toEqual({ decision: "allow" });
  });

  test("a worker start made outside its task's repo is denied before any run opens, naming the folder to start from (trustmybot/tmb#285)", () => {
    createRecord();
    // A workspace: the project folder is no git repo; the repo api is.
    const repoDir = path.join(project, "api");
    gitInit(repoDir);
    const taskId = openTask("open", "api");

    for (const from of [project, path.join(project, "wt-elsewhere")]) {
      mkdirSync(from, { recursive: true });
      const answer = workerStart(`task_id=${taskId}`, from);
      expect(answer.decision).toBe("deny");
      expect(answer.reason).toContain(`Change into ${repoDir}`);
      expect(answer.reason).toContain(`made from ${from}`);
    }
    withStore((store) => expect(store.openRuns("worker")).toEqual([]));

    // From the repo, or a folder inside it, the start opens its run.
    mkdirSync(path.join(repoDir, "src"));
    expect(workerStart(`task_id=${taskId}`, path.join(repoDir, "src")).decision).toBe("allow");
    withStore((store) => expect(store.openRuns("worker").map((run) => run.taskId)).toEqual([taskId]));
  });

  test("a start from a git project, for a task with no repo, opens its run; a task with no repo in a workspace is denied", () => {
    createRecord();
    const legacy = openTask("open", null);
    const denied = workerStart(`task_id=${legacy}`, project);
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("names no repo");
    withStore((store) => expect(store.openRuns("worker")).toEqual([]));

    gitInit(project);
    expect(workerStart(`task_id=${legacy}`, realpathSync(project)).decision).toBe("allow");
  });

  test("allows a worker start in a project with no record", () => {
    expect(workerStart("no task")).toEqual({ decision: "allow" });
  });
});

describe("the guards", () => {
  const PLANNER = { kind: "agent", role: "planner", host: "host-a" } as const;

  test("tmb leaves a worker's writes to the host, wherever they land, and denies every reviewer write by role (#185)", () => {
    createRecord();
    const worktree = mkdtempSync(path.join(project, "wt-"));
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    const issueId = opened.store.createIssue(PLANNER, { title: "goal" });
    opened.store.appendTask(PLANNER, { issueId, title: "task", spec: "{}", state: "open", worktree });
    opened.store.close();
    const write = (role: string, action: string) => decide(event({ type: "before-file-write", role, action }));

    const reviewer = write("reviewer", path.join(worktree, "a.ts"));
    expect(reviewer).toMatchObject({ decision: "deny", reason: expect.stringContaining("The reviewer judges a change and never edits one") });
    expect(write("reviewer", "src/a.ts").decision).toBe("deny");
    expect(write("worker", path.join(worktree, "src", "new", "a.ts")).decision).toBe("allow");
    expect(write("worker", path.join(project, "src", "a.ts")).decision).toBe("allow");
    expect(write("worker", "src/a.ts").decision).toBe("allow");
    expect(write("planner", "src/a.ts").decision).toBe("allow");
  });
});

describe("projectRootOf", () => {
  test("finds the nearest folder holding a record, from the folder itself or below it", () => {
    createRecord();
    const sub = path.join(project, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(projectRootOf(project)).toBe(project);
    expect(projectRootOf(sub)).toBe(project);
    expect(projectRootOf(path.join(sub, ".."))).toBe(project);
  });

  test("passes over a file of that name, and with no project folder above returns the start folder", () => {
    const sub = path.join(project, "a");
    mkdirSync(sub);
    writeFileSync(path.join(sub, PROJECT_DIR_NAME), "");
    expect(projectRootOf(sub)).toBe(sub);
  });

  test("passes over a stray project folder with no database in it, up to the folder that holds the record", () => {
    createRecord();
    const stray = path.join(project, "a");
    const sub = path.join(stray, "b");
    mkdirSync(path.join(stray, PROJECT_DIR_NAME), { recursive: true });
    mkdirSync(sub);
    expect(projectRootOf(sub)).toBe(project);
    expect(projectRootOf(stray)).toBe(project);
  });

  test("passes over a folder where the database's name is a folder, not a file", () => {
    const sub = path.join(project, "a");
    mkdirSync(projectDbPath(project), { recursive: true });
    mkdirSync(sub);
    expect(projectRootOf(sub)).toBe(sub);
  });
});
