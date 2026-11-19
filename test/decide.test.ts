import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "../src/engine/ids.ts";
import { type Decision, decide, openProjectStore, PROJECT_DIR_NAME, projectDbPath, projectRootOf, type TmbEvent } from "../src/engine/index.ts";
import type { GuardDecision, Store } from "../src/engine/store/index.ts";

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
    expect(decide(event({ type: "before-command", role: "worker", task: "T1", action: "bun test" }))).toEqual({ decision: "allow" });
    expect(decide(event({ type: "before-file-write", action: "src/b.ts" }))).toEqual({ decision: "allow" });

    const recorded = guardDecisions();
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ decision: "allow", reason: "no rule denies it", createdBy: { kind: "agent", role: "worker", host: "host-a" } });
    expect(JSON.parse(recorded[0]!.event)).toEqual({ type: "before-command", role: "worker", task: "T1", action: "bun test" });
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
  function openTask(state = "open"): string {
    const worktree = mkdtempSync(path.join(project, "wt-"));
    return withStore((store) => {
      const issueId = store.createIssue(PLANNER, { title: "goal" });
      return store.appendTask(PLANNER, { issueId, title: "task", spec: "{}", state, worktree });
    });
  }

  function workerStart(prompt: string): Decision {
    return decide(event({ type: "before-agent-start", role: "worker", action: prompt }));
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
      `worker run ${run!.id} ended`,
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

  test("leaves other roles' starts and stops as they were: allowed, with no run", () => {
    createRecord();
    expect(decide(event({ type: "before-agent-start", role: "reviewer", action: "review" }))).toEqual({ decision: "allow" });
    expect(decide(event({ type: "after-agent-stop", role: "reviewer", action: "reviewer" }))).toEqual({ decision: "allow" });
    withStore((store) => expect(store.openRuns("reviewer")).toEqual([]));
  });

  test("allows a worker start in a project with no record", () => {
    expect(workerStart("no task")).toEqual({ decision: "allow" });
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
