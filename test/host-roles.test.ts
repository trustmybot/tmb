// A role per host: init names each host's role, and the main agent of a host set up as the
// reviewer is briefed, guarded and recorded as the reviewer. Its run opens at its session start,
// ends with its verdict or with the session, and opens again when it next reads a brief.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolSession } from "../src/engine/doors/tool-server.ts";
import { featureBrief, featureStart, issueCreate, reviewRecord, taskClose, taskStart } from "../src/engine/handlers/index.ts";
import {
  AWAITING_REVIEW_HEADING,
  decide,
  handleEvent,
  hostRole,
  MAIN_AGENT,
  NO_VERDICT,
  OPEN_WORK_HEADING,
  openProjectStore,
  projectDbPath,
  writeSetting,
} from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "host-a" };
const REVIEWER_HOST = "host-b";
const REVIEWER: Actor = { kind: "agent", role: "reviewer", host: REVIEWER_HOST };
const FEATURE = "feat/goal";

let scratch: string;
let project: string;
let store: Store;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-host-roles-")));
  project = path.join(scratch, "project");
  mkdirSync(project);
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
  writeSetting(store, HUMAN, "review_mode", "agile");
  writeSetting(store, HUMAN, "checks", ["true"]);
  writeSetting(store, HUMAN, "host_roles", { "host-a": "planner", [REVIEWER_HOST]: "reviewer" });
});

afterEach(() => {
  store.close();
  rmSync(scratch, { recursive: true, force: true });
});

const context = () => ({ projectDir: project });

/** A feature branch with one closed task on it; returns its tip. */
async function featureWithWork(): Promise<string> {
  const issueId = issueCreate(store, HUMAN, { title: "The goal" }).id;
  featureStart(store, HUMAN, { name: FEATURE }, context());
  const started = taskStart(store, PLANNER, { issue_id: issueId, feature: FEATURE, kind: "code", intent: "Add a", files: ["src"], criteria: ["SC1"] }, context());
  mkdirSync(path.join(started.worktree, "src"), { recursive: true });
  writeFileSync(path.join(started.worktree, "src", "a.ts"), "export const a = 1;\n");
  git(started.worktree, "add", ".");
  git(started.worktree, "commit", "-q", "-m", "add a");
  await taskClose(store, WORKER, { id: started.id }, context());
  return git(project, "rev-parse", FEATURE);
}

/** The outcome the record keeps for the run. */
function outcomeOf(id: string): string | null {
  const db = new Database(projectDbPath(project), { readonly: true });
  try {
    return (db.query("SELECT outcome FROM runs WHERE id = ?").get(id) as { outcome: string | null }).outcome;
  } finally {
    db.close();
  }
}

function openRunsOf(host: string) {
  return store.openRuns("reviewer").filter((run) => run.createdBy.kind === "agent" && run.createdBy.host === host);
}

describe("host roles", () => {
  test("a host takes the role init gave it, and a host init never named is the planner", () => {
    expect(hostRole(store, "host-a")).toBe("planner");
    expect(hostRole(store, REVIEWER_HOST)).toBe("reviewer");
    expect(hostRole(store, "host-c")).toBe("planner");
  });

  test("the setting refuses a role that is not a host's", () => {
    expect(() => writeSetting(store, HUMAN, "host_roles", { "host-a": "worker" })).toThrow();
  });

  test("the main agent's events are guarded and recorded in the host's role", () => {
    const write = (host: string) => decide({ type: "before-file-write", projectDir: project, host, role: MAIN_AGENT, action: "src/a.ts" });
    expect(write(REVIEWER_HOST)).toMatchObject({ decision: "deny" });
    expect(write("host-a")).toMatchObject({ decision: "allow" });
    const roles = store.listGuardDecisions().map((decision) => decision.createdBy);
    expect(roles).toEqual([
      { kind: "agent", role: "reviewer", host: REVIEWER_HOST },
      { kind: "agent", role: "planner", host: "host-a" },
    ]);
  });

  test("the tool server acts in the host's role unless the call names one", async () => {
    const session = new ToolSession(project, REVIEWER_HOST);
    try {
      const made = await session.call("issue_create", { title: "From the reviewer host" });
      const named = await session.call("issue_create", { title: "From a worker", role: "worker" });
      const id = (result: typeof made) => (JSON.parse((result.content[0] as { text: string }).text) as { id: string }).id;
      expect(store.getIssue(id(made))?.createdBy).toEqual(REVIEWER);
      expect(store.getIssue(id(named))?.createdBy).toEqual({ kind: "agent", role: "worker", host: REVIEWER_HOST });
    } finally {
      session.close();
    }
  });
});

describe("a host set up as the reviewer", () => {
  test("is briefed as the reviewer, told which branches wait at their tip, and its run opens", async () => {
    const tip = await featureWithWork();
    const context = handleEvent({ type: "session-start", projectDir: project, unattended: false, host: REVIEWER_HOST }).context;
    expect(context).toContain(AWAITING_REVIEW_HEADING);
    expect(context).toContain(`feature=${FEATURE} at ${tip.slice(0, 12)}`);
    expect(context).not.toContain(OPEN_WORK_HEADING);
    expect(openRunsOf(REVIEWER_HOST)).toHaveLength(1);

    const planner = handleEvent({ type: "session-start", projectDir: project, unattended: false, host: "host-a" }).context;
    expect(planner).toContain(OPEN_WORK_HEADING);
    expect(planner).not.toContain(AWAITING_REVIEW_HEADING);
    expect(openRunsOf("host-a")).toHaveLength(0);
  });

  test("a branch with no work, or reviewed at its tip, does not wait", async () => {
    featureStart(store, HUMAN, { name: "feat/empty" }, context());
    const before = handleEvent({ type: "session-start", projectDir: project, unattended: false, host: REVIEWER_HOST }).context;
    expect(before).toContain("No feature branch waits for a review now.");

    const tip = await featureWithWork();
    reviewRecord(store, REVIEWER, { feature: FEATURE, commit: tip, verdict: "fail", blocking: ["src/a.ts:1 a is wrong"] }, context());
    const after = handleEvent({ type: "session-start", projectDir: project, unattended: false, host: REVIEWER_HOST }).context;
    expect(after).not.toContain(`feature=${FEATURE}`);
  });

  test("its run ends with its verdict, and the next brief opens a new one", async () => {
    const tip = await featureWithWork();
    handleEvent({ type: "session-start", projectDir: project, unattended: false, host: REVIEWER_HOST });
    const [run] = openRunsOf(REVIEWER_HOST);

    featureBrief(store, REVIEWER, { feature: FEATURE }, context());
    expect(openRunsOf(REVIEWER_HOST)).toEqual([run!]);
    reviewRecord(store, REVIEWER, { feature: FEATURE, commit: tip, verdict: "pass" }, context());
    expect(openRunsOf(REVIEWER_HOST)).toHaveLength(0);
    expect(outcomeOf(run!.id)).toBe("finished");
    // The review names the run that wrote it, and the run names the branch it reviewed (trustmybot/tmb#135).
    expect(store.getRun(run!.id)!.featureId).toBe(store.findFeature(FEATURE)!.id);
    expect(store.listRunReviews(run!.id).map((review) => review.verdict)).toEqual(["pass"]);

    featureBrief(store, REVIEWER, { feature: FEATURE }, context());
    expect(openRunsOf(REVIEWER_HOST)).toHaveLength(1);
  });

  test("a reviewer subagent's branch review links its run to the branch, and its stop ends it finished", async () => {
    const tip = await featureWithWork();
    const asSubagent: Actor = { kind: "agent", role: "reviewer", host: "host-a" };
    decide({ type: "before-agent-start", projectDir: project, host: "host-a", role: "reviewer", action: "review the branch" });
    const [run] = openRunsOf("host-a");
    expect(run!.featureId).toBeNull();
    reviewRecord(store, asSubagent, { feature: FEATURE, commit: tip, verdict: "pass" }, context());
    const [review] = store.listRunReviews(run!.id);
    expect(review).toMatchObject({ runId: run!.id, verdict: "pass" });
    expect(store.getRun(run!.id)!.featureId).toBe(store.findFeature(FEATURE)!.id);
    decide({ type: "after-agent-stop", projectDir: project, host: "host-a", role: "reviewer", action: "reviewer" });
    expect(outcomeOf(run!.id)).toBe("finished");
  });

  test("a session start raised again on resume or compact opens no second run", () => {
    handleEvent({ type: "session-start", projectDir: project, unattended: false, host: REVIEWER_HOST });
    handleEvent({ type: "session-start", projectDir: project, unattended: false, host: REVIEWER_HOST });
    expect(openRunsOf(REVIEWER_HOST)).toHaveLength(1);
    handleEvent({ type: "session-end", projectDir: project, host: REVIEWER_HOST });
    expect(openRunsOf(REVIEWER_HOST)).toHaveLength(0);
  });

  test("another host neither records a verdict on its run nor is blocked by it", async () => {
    const tip = await featureWithWork();
    handleEvent({ type: "session-start", projectDir: project, unattended: false, host: REVIEWER_HOST });
    const asReviewerOnHostA: Actor = { kind: "agent", role: "reviewer", host: "host-a" };
    expect(() => reviewRecord(store, asReviewerOnHostA, { feature: FEATURE, commit: tip, verdict: "pass" }, context())).toThrow(/no reviewer run is open/);

    decide({ type: "before-agent-start", projectDir: project, host: "host-a", role: "reviewer", action: "review" });
    decide({ type: "after-agent-stop", projectDir: project, host: "host-a", role: "reviewer", action: "reviewer" });
    expect(openRunsOf("host-a")).toHaveLength(0);
    expect(openRunsOf(REVIEWER_HOST)).toHaveLength(1);
  });

  test("a session that ends before a verdict ends its run with none", () => {
    handleEvent({ type: "session-start", projectDir: project, unattended: false, host: REVIEWER_HOST });
    const [run] = openRunsOf(REVIEWER_HOST);
    handleEvent({ type: "session-end", projectDir: project, host: REVIEWER_HOST });
    expect(openRunsOf(REVIEWER_HOST)).toHaveLength(0);
    expect(outcomeOf(run!.id)).toBe(NO_VERDICT);
  });

  test("a planner host's session end touches no run", () => {
    decide({ type: "before-agent-start", projectDir: project, host: "host-a", role: "reviewer", action: "review" });
    handleEvent({ type: "session-end", projectDir: project, host: "host-a" });
    expect(openRunsOf("host-a")).toHaveLength(1);
  });
});
