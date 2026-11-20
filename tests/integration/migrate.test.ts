// A plugin project's records carry over: `tmb migrate` run in a project copies a plugin
// database at schema v76 into the project's new record, and leaves the plugin's file as it was.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openProjectStore } from "../../src/engine/project.ts";
import type { Store } from "../../src/engine/store/index.ts";
import { tmbProcesses } from "./tmb-processes.ts";

const SCHEMA = readFileSync(path.join(import.meta.dir, "fixtures", "plugin-schema-v76.sql"), "utf8");
const t = tmbProcesses("tmb-migrate-");

/** A plugin workspace serving two repos, as `.claude/tmb/trajectory.db` above the repos' folders. */
function pluginWorkspace(): { workspace: string; dbPath: string } {
  const workspace = path.join(t.scratch, `workspace-${crypto.randomUUID().slice(0, 8)}`);
  const dbPath = path.join(workspace, ".claude", "tmb", "trajectory.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO repos (name, path) VALUES ('app', '/w/app'), ('other', '/w/other');
    INSERT INTO milestones (name, repo) VALUES ('Level 1', 'app');
    INSERT INTO issues (id, objective, description, status, created_at, updated_at, closed_at, gh_iid, repo, milestone) VALUES
      (1, 'Dark mode toggle', 'Users want a dark theme.', 'closed', '2026-01-02T10:00:00.000Z', '2026-01-05T10:00:00.000Z', '2026-01-05T10:00:00.000Z', 41, 'app', 'Level 1'),
      (2, 'Faster search', 'Search is slow on big projects.', 'open', '2026-01-03T10:00:00.000Z', '2026-01-03T10:00:00.000Z', NULL, NULL, 'app', NULL),
      (3, 'Other repo work', 'Not for this project.', 'open', '2026-01-04T10:00:00.000Z', '2026-01-04T10:00:00.000Z', NULL, NULL, 'other', NULL);
    INSERT INTO discussions (issue_id, author, kind, body, repo, created_at) VALUES
      (1, 'bro', 'intent', 'Add a toggle in settings.', 'app', '2026-01-02T10:01:00.000Z'),
      (1, 'bro', 'decision', 'Use CSS variables for the theme.', 'app', '2026-01-02T10:02:00.000Z'),
      (1, 'human', 'note', 'Keep the default light.', 'app', '2026-01-02T10:03:00.000Z'),
      (1, 'code-reviewer', 'question', 'Is the toggle persisted?', 'app', '2026-01-02T10:04:00.000Z'),
      (1, 'bro', 'answer', 'Yes, in local storage.', 'app', '2026-01-02T10:05:00.000Z'),
      (2, 'bro', 'analysis', 'The scan is linear.', 'app', '2026-01-03T10:01:00.000Z'),
      (2, 'bro', 'intent', 'Add an index.', 'app', '2026-01-03T10:02:00.000Z'),
      (3, 'bro', 'question', 'Other repo, not counted.', 'other', '2026-01-04T10:03:00.000Z'),
      (3, 'bro', 'note', 'Not carried.', 'other', '2026-01-04T10:01:00.000Z'),
      (-1, 'bro', 'note', 'System note, not carried.', NULL, '2026-01-04T10:02:00.000Z');
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at, completed_at,
                       base_sha, workflow_mode, no_code_class, repo) VALUES
      (10, 1, 'feat/dark-mode', 'Theme variables', 'Add the variables', 'closed', '## Spec\nAdd CSS variables.', 'abc123',
       '2026-01-02T11:00:00.000Z', '2026-01-04T11:00:00.000Z', '2026-01-04T11:00:00.000Z', 'base000', 'agile', NULL, 'app'),
      (11, 1, 'docs/dark-mode', '', 'Document the toggle', 'escalated', '', NULL,
       '2026-01-02T12:00:00.000Z', '2026-01-02T12:00:00.000Z', NULL, NULL, NULL, 'docs', 'app'),
      (12, 2, 'perf/search', 'Index search', 'Add an index', 'running', 'Index it.', NULL,
       '2026-01-03T11:00:00.000Z', '2026-01-03T11:00:00.000Z', NULL, 'base111', NULL, NULL, 'app'),
      (13, 3, 'other/x', 'Other task', 'Elsewhere', 'pending', '', NULL,
       '2026-01-04T11:00:00.000Z', '2026-01-04T11:00:00.000Z', NULL, NULL, NULL, NULL, 'other');
    INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, repo, created_at, reviewed_sha, probes_json) VALUES
      (10, 1, 'code-reviewer', 'fail', 'Missing a test.', 1, 'app', '2026-01-03T09:00:00.000Z', 'abc000', 'not json'),
      (10, 2, 'code-reviewer', 'pass', 'All good.', 1, 'app', '2026-01-04T09:00:00.000Z', 'abc123', '[{"target":"t","probe_cmd":"bun test","observed":"ok"}]');
    INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at, severity) VALUES
      ('F10-1', 10, 1, 'SC1', 'bun test', 'a test for the toggle', 'none', 'fixed', '2026-01-03T09:00:00.000Z', 'blocking');
    INSERT INTO verification_runs (id, task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s) VALUES
      (100, 10, 'abc123', 'gate', '2026-01-04T10:00:00.000Z', '2026-01-04T10:01:00.000Z', 0, 600);
    INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES
      (100, 0, 'bun test', 0, 12.5, '3 pass');
    INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, started_at, completed_at, host, exit_reason) VALUES
      (10, 1, 'swe', 1000, 200, '2026-01-02T11:05:00.000Z', '2026-01-02T11:30:00.000Z', 'claude', 'completed'),
      (NULL, 2, 'bro', NULL, NULL, '2026-01-03T10:05:00.000Z', NULL, 'claude', NULL),
      (13, 3, 'swe', NULL, NULL, '2026-01-04T11:05:00.000Z', NULL, 'claude', NULL);
    INSERT INTO audit (issue_id, event_type, summary, created_at) VALUES (1, 'hook_call', 'not carried', '2026-01-02T10:00:00.000Z');
    INSERT INTO roundtables (issue_id, topic, created_at) VALUES (1, 'dropped feature', '2026-01-02T10:00:00.000Z');
  `);
  db.close();
  return { workspace, dbPath };
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function openRecord(project: string): Store {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  return opened.store;
}

afterAll(() => t.cleanup());

describe("a plugin project's records carry over", () => {
  let project: string;
  let dbPath: string;
  let hashBefore: string;
  let output: string;

  beforeAll(() => {
    const plugin = pluginWorkspace();
    dbPath = plugin.dbPath;
    hashBefore = sha256(dbPath);
    // The project folder is named like the repo, so the repo is chosen without --repo.
    project = path.join(plugin.workspace, "app");
    mkdirSync(project);
    t.git(project, "init", "-q", "-b", "main");
    t.tmb(["init"], project);
    output = t.tmb(["migrate"], project);
  });

  test("tmb migrate finds the plugin database above the project and says what it copied and what it left behind", () => {
    expect(output).toContain(dbPath);
    expect(output).toContain("(repo app)");
    // It names the record it wrote to: the one init made in the project.
    expect(output).toContain(`into ${path.join(project, ".tmb", "trajectory.db")}`);
    expect(output).toContain("2 issues, 2 notes and decisions, 3 tasks, 2 reviews, 1 check runs, 2 agent runs");
    expect(output).toContain("Left behind, as tmb has no such kind: 1 analysis, 1 answer, 2 intent, 1 question.");
    // Left open, so it holds tmb's updates back (trustmybot/tmb#61).
    expect(output).toContain("1 of the tasks are still open");
  });

  test("the plugin's database is byte for byte unchanged", () => {
    expect(sha256(dbPath)).toBe(hashBefore);
  });

  test("issues keep their title, body, state, milestone and time, with a note naming the plugin and GitHub numbers", () => {
    const issues = t.tmbJson<{ id: string; title: string; state: string; milestone: string | null }[]>(["issue", "list"], project);
    expect(issues.map((issue) => [issue.title, issue.state, issue.milestone])).toEqual([
      ["Dark mode toggle", "closed", "Level 1"],
      ["Faster search", "open", null],
    ]);
    const store = openRecord(project);
    try {
      const dark = store.getIssue(issues[0]!.id)!;
      expect(dark.body).toBe("Users want a dark theme.");
      expect(dark.createdAt).toBe("2026-01-02T10:00:00.000Z");
      expect(dark.updatedAt).toBe("2026-01-05T10:00:00.000Z");
      const bodies = store.listDiscussions(dark.id).map((d) => [d.kind, d.body, d.createdBy.kind === "agent" ? d.createdBy.role : "human"]);
      // The plugin's intent, question, answer and analysis records are left behind, not made notes.
      expect(bodies).toEqual([
        ["decision", "Use CSS variables for the theme.", "planner"],
        ["note", "Keep the default light.", "human"],
        ["note", "Carried over from the plugin's issue 1 (GitHub #41, repo app).", "human"],
      ]);
      expect(store.newestDecision(dark.id)?.body).toBe("Use CSS variables for the theme.");
      expect(store.search("CSS variables").map((hit) => hit.issueId)).toContain(dark.id);
    } finally {
      store.close();
    }
  });

  test("tasks carry their branch, commits, kind and spec, not the plugin's status; finished ones are closed", () => {
    const store = openRecord(project);
    try {
      const tasks = store.listTasks();
      expect(tasks.map((task) => [task.title, task.state, task.branch, task.kind, task.commitSha, task.baseCommit, task.reviewMode])).toEqual([
        ["Theme variables", "closed", "feat/dark-mode", "code", "abc123", "base000", "agile"],
        ["Document the toggle", "closed", "docs/dark-mode", "docs", null, null, null],
        ["Index search", "open", "perf/search", "code", null, "base111", null],
      ]);
      expect(tasks[0]!.spec).toBe("## Spec\nAdd CSS variables.");
      expect(tasks[1]!.spec).toBe("Document the toggle");
      expect(tasks.some((task) => task.spec.includes("status"))).toBe(false);
      expect(tasks[0]!.createdAt).toBe("2026-01-02T11:00:00.000Z");
      expect(tasks.map((task) => task.createdBy)).toEqual(tasks.map(() => ({ kind: "agent", role: "planner", host: "claude-code" })));

      const checks = store.listCheckRuns(tasks[0]!.id);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ commitSha: "abc123", result: "passed", startedAt: "2026-01-04T10:00:00.000Z" });
      expect(checks[0]!.commands).toEqual([{ command: "bun test", status: "passed", exitCode: 0, elapsedSeconds: 12.5, outputTail: "3 pass" }]);
    } finally {
      store.close();
    }
  });

  test("reviews, agent runs and one audit entry of the migration carry over; dropped features and other repos do not", () => {
    const db = new Database(path.join(project, ".tmb", "trajectory.db"), { readonly: true });
    try {
      const reviews = db.query("SELECT target_kind, target, verdict, findings, created_by FROM reviews ORDER BY id").all() as Record<string, string>[];
      expect(reviews.map((review) => [review.target_kind, review.target, review.verdict])).toEqual([
        ["commit", "abc000", "fail"],
        ["commit", "abc123", "pass"],
      ]);
      const failFindings = JSON.parse(reviews[0]!.findings!) as Record<string, unknown>[];
      expect(failFindings[0]).toMatchObject({ attempt: 1, feedback: "Missing a test." });
      expect(failFindings[1]).toMatchObject({ criterion: "SC1", probe: "bun test", status: "fixed", severity: "blocking" });
      // A probe list that is not JSON is kept as written rather than stopping the copy.
      expect(failFindings[2]).toEqual({ probe: "not json" });
      expect(JSON.parse(reviews[0]!.created_by!)).toEqual({ kind: "agent", role: "reviewer", host: "claude-code" });

      const runs = db.query("SELECT role, task_id IS NULL AS issue_level, ended_at, outcome, cost FROM runs ORDER BY id").all() as Record<string, unknown>[];
      expect(runs.map((run) => [run.role, run.issue_level, run.outcome])).toEqual([
        ["worker", 0, "completed"],
        ["planner", 1, null],
      ]);
      expect(JSON.parse(runs[0]!.cost as string)).toMatchObject({ tokens_in: 1000, tokens_out: 200 });

      // init's own entries come first; the migration adds exactly one.
      const audit = (db.query("SELECT what, detail FROM audit").all() as { what: string; detail: string }[]).filter((entry) => entry.what.startsWith("migration"));
      expect(audit.map((entry) => entry.what)).toEqual(["migration.plugin"]);
      const detail = JSON.parse(audit[0]!.detail) as {
        repo: string;
        leftBehind: Record<string, number>;
        ids: { issues: Record<string, string>; tasks: Record<string, string> };
      };
      expect(detail.repo).toBe("app");
      expect(detail.leftBehind).toEqual({ intent: 2, question: 1, answer: 1, analysis: 1 });
      expect(Object.keys(detail.ids.issues)).toEqual(["1", "2"]);
      expect(Object.keys(detail.ids.tasks)).toEqual(["10", "11", "12"]);

      const all = db.query("SELECT body FROM discussions").all() as { body: string }[];
      expect(all.some((row) => row.body.includes("Not carried") || row.body.includes("System note"))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a rebuild from the events gives the same record", () => {
    const store = openRecord(project);
    try {
      const before = { issues: store.listIssues(), tasks: store.listTasks() };
      store.rebuildProjections();
      expect({ issues: store.listIssues(), tasks: store.listTasks() }).toEqual(before);
    } finally {
      store.close();
    }
  });

  test("a second migration into the same record is refused", () => {
    const again = t.run(["migrate"], project);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already holds issues or tasks");
  });
});

describe("tmb migrate refuses", () => {
  test("a plugin database serving several repos when the project is none of them, until --repo names one", () => {
    const plugin = pluginWorkspace();
    const project = path.join(plugin.workspace, "elsewhere");
    mkdirSync(project);
    t.tmb(["init"], project);
    const refused = t.run(["migrate"], project);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("several repos (app, other); name one with --repo");
    expect(t.tmb(["migrate", "--repo", "other"], project)).toContain("1 issues, 1 notes and decisions, 1 tasks");
  });

  test("a database at another plugin schema version, and touches nothing", () => {
    const plugin = pluginWorkspace();
    const db = new Database(plugin.dbPath);
    db.run("UPDATE plugin_meta SET schema_version = 75");
    db.close();
    const hash = sha256(plugin.dbPath);
    const project = path.join(plugin.workspace, "app");
    mkdirSync(project);
    t.tmb(["init"], project);
    const refused = t.run(["migrate"], project);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("plugin schema version 75; the migration reads version 76");
    expect(sha256(plugin.dbPath)).toBe(hash);
  });

  test("a file that is not a plugin database", () => {
    const project = path.join(t.scratch, "plain");
    mkdirSync(project);
    t.tmb(["init"], project);
    const file = path.join(t.scratch, "not-plugin.db");
    writeFileSync(file, "");
    new Database(file).close();
    const refused = t.run(["migrate", "--from", file], project);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not a tmb plugin database");
  });

  test("a project with no plugin database above it", () => {
    const project = path.join(t.scratch, "lonely");
    mkdirSync(project);
    const refused = t.run(["migrate"], project);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("no plugin database");
  });

  // trustmybot/tmb#161: run before init, the records went into a new record in another folder.
  test("before tmb init, naming tmb init, and creates no record anywhere", () => {
    const plugin = pluginWorkspace();
    const project = path.join(plugin.workspace, "app");
    mkdirSync(project);
    t.git(project, "init", "-q", "-b", "main");
    const refused = t.run(["migrate"], project);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("run tmb init here first, then tmb migrate");
    expect(existsSync(path.join(project, ".tmb"))).toBe(false);
    expect(existsSync(path.join(plugin.workspace, ".tmb"))).toBe(false);
  });

  test("into a record in a folder above the repo that does not serve it, and names it", () => {
    const plugin = pluginWorkspace();
    // A single-repo project above, whose record the nearest-record rule would find.
    const outer = plugin.workspace;
    t.git(outer, "init", "-q", "-b", "main");
    t.tmb(["init"], outer);
    const project = path.join(outer, "app");
    mkdirSync(project);
    t.git(project, "init", "-q", "-b", "main");
    const refused = t.run(["migrate"], project);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`the nearest tmb record, ${path.join(outer, ".tmb", "trajectory.db")}, belongs to a folder above this repo`);
    expect(t.tmbJson<unknown[]>(["issue", "list"], outer)).toEqual([]);
    // Once init has made the repo's own record, the records go there.
    t.tmb(["init"], project);
    expect(t.tmb(["migrate"], project)).toContain(`into ${path.join(project, ".tmb", "trajectory.db")}`);
  });
});
