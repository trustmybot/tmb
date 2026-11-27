// The one-way migration from a plugin project: copies the records of the tmb plugin for
// Claude Code, from its database at schema version 76, into a tmb record. The plugin's file
// is never opened for writing: a copy of it is read. Dropped features' records stay behind.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIdFactory } from "../../engine/ids.ts";
import { isManaged } from "../../engine/repos.ts";
import type { RepoPolicies } from "../../engine/settings.ts";
import type { Actor, Role, Store } from "../../engine/store/index.ts";
import { PLUGIN_IMPORT } from "../../engine/task-repos.ts";
import { HOST_ID } from "./mcp-json.ts";

/** The plugin schema this tool reads: the last one the plugin shipped before tmb. */
export const PLUGIN_SCHEMA_VERSION = 76;

/** Where the plugin keeps a project's database, relative to the folder it serves. */
export const PLUGIN_DB_RELATIVE = path.join(".claude", "tmb", "trajectory.db");

/** The audit entry that records a migration: the source, the counts and the id map. */
export { PLUGIN_IMPORT };

/** The plugin ran its agents on Claude Code. */
const PLUGIN_HOST = HOST_ID;
const HUMAN: Actor = { kind: "human" };
/** The plugin's issue that parents its own system-level records, not the Human's work. */
const SYSTEM_ISSUE_ID = -1;

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** `openTasks` counts the copied tasks left open: a running session stays on its tmb build until they close. */
export type MigrationCounts = { issues: number; discussions: number; tasks: number; openTasks: number; reviews: number; checkRuns: number; runs: number };

export type MigrationResult = {
  from: string;
  pluginVersion: string | null;
  repo: string | null;
  /** The workspace repo the rows went to; null in a single-repo project. */
  into: string | null;
  counts: MigrationCounts;
  /** Records of the carried issues left behind because tmb has no such kind, per plugin kind. */
  leftBehind: Record<string, number>;
  /** Plugin ids to tmb ids, per kind. */
  ids: { issues: Record<string, string>; tasks: Record<string, string> };
};

/** The plugin database for a project: the nearest `.claude/tmb/trajectory.db` in it or a folder above it. */
/** The probes a review recorded; a value that is not a JSON list is kept as it was. */
function probesOf(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [json];
  }
}

export function findPluginDb(projectDir: string): string | null {
  for (let dir = path.resolve(projectDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, PLUGIN_DB_RELATIVE);
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

type IssueRow = {
  id: number;
  objective: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  gh_iid: number | null;
  gl_iid: number | null;
  repo: string | null;
  milestone: string | null;
};
type DiscussionRow = { id: number; issue_id: number; author: string; kind: string; body: string; created_at: string };
type TaskRow = {
  id: number;
  issue_id: number;
  branch_id: string;
  title: string;
  description: string;
  status: string;
  spec_body: string;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  worktree_path: string | null;
  workflow_mode: string | null;
  base_sha: string | null;
  no_code_class: string | null;
  repo: string | null;
};
type AttemptRow = {
  id: number;
  task_id: number;
  attempt_n: number;
  agent: string;
  verdict: string;
  feedback: string;
  created_at: string;
  reviewed_sha: string | null;
  probes_json: string | null;
};
type FindingRow = {
  task_id: number;
  attempt_n: number;
  criterion_id: string | null;
  probe_cmd: string;
  expected: string;
  observed: string;
  status: string;
  severity: string;
  class: string | null;
};
type VerificationRow = {
  id: number;
  task_id: number;
  commit_sha: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  timed_out: number;
};
type CommandRow = { run_id: number; ordinal: number; command: string; exit_code: number | null; elapsed_s: number | null; output_tail: string | null };
type AgentRunRow = {
  id: number;
  task_id: number | null;
  issue_id: number | null;
  agent_type: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  tool_uses: number;
  duration_ms: number;
  started_at: string | null;
  completed_at: string | null;
  model: string | null;
  host: string | null;
  exit_reason: string | null;
  effort: string | null;
};

/** The plugin's agent names to tmb's roles; any other agent counts as the planner, as bro was. */
function roleOf(agent: string): Role {
  if (agent === "swe") return "worker";
  if (agent === "code-reviewer" || agent === "reviewer") return "reviewer";
  return "planner";
}

function actorOf(author: string, host: string | null = null): Actor {
  if (/^(human|user)$/i.test(author.trim())) return HUMAN;
  return { kind: "agent", role: roleOf(author.trim()), host: host === "codex" ? "codex" : PLUGIN_HOST };
}

/** A plugin time as ISO 8601; SQLite's own `YYYY-MM-DD HH:MM:SS` is UTC. Null when it is no time. */
function isoTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = /^\d{4}-\d\d-\d\d \d/.test(value) && !/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const TASK_CLOSED_STATES = new Set(["closed", "completed", "failed", "escalated"]);
/** The plugin's discussion kinds that tmb has; any other kind is left behind, not folded into these. */
const DISCUSSION_KINDS = new Set(["note", "decision"]);

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

/** Copies the database and its write-ahead log to a scratch folder, so reading it can never change the original. */
function readableCopy(dbPath: string): { db: Database; cleanup: () => void } {
  const scratch = mkdtempSync(path.join(tmpdir(), "tmb-migrate-"));
  const copy = path.join(scratch, "plugin.db");
  try {
    copyFileSync(dbPath, copy);
    if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
    const db = new Database(copy, { readwrite: true, create: false, strict: true });
    return {
      db,
      cleanup: () => {
        db.close();
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw new MigrationError(`cannot read ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function pluginMeta(db: Database, dbPath: string): { schemaVersion: number; pluginVersion: string | null } {
  if (!hasTable(db, "plugin_meta")) throw new MigrationError(`${dbPath} is not a tmb plugin database: it has no plugin_meta table`);
  const row = db.query("SELECT schema_version, plugin_version FROM plugin_meta WHERE id = 1").get() as
    | { schema_version: number; plugin_version: string }
    | null;
  if (!row) throw new MigrationError(`${dbPath} has no schema version in plugin_meta`);
  return { schemaVersion: row.schema_version, pluginVersion: row.plugin_version || null };
}

/**
 * The repo whose records to carry: one plugin database often serves several repos. With
 * one named repo or none in the issues, no choice is needed; otherwise `wanted`, or the
 * project folder's name when it is one of them.
 */
function chooseRepo(db: Database, wanted: string | undefined, projectDir: string): string | null {
  const repos = (db.query("SELECT DISTINCT repo FROM issues WHERE repo IS NOT NULL AND id <> ? ORDER BY repo").all(SYSTEM_ISSUE_ID) as { repo: string }[]).map(
    (row) => row.repo,
  );
  if (wanted !== undefined) {
    if (!repos.includes(wanted)) {
      throw new MigrationError(`the plugin database has no issues in repo ${JSON.stringify(wanted)}; its repos are ${repos.join(", ") || "none"}`);
    }
    return wanted;
  }
  if (repos.length <= 1) return repos[0] ?? null;
  const folder = path.basename(path.resolve(projectDir));
  if (repos.includes(folder)) return folder;
  throw new MigrationError(`the plugin database serves several repos (${repos.join(", ")}); name one with --repo`);
}

/** The task's spec as the plugin wrote it; its status beyond open or closed is left behind. */
function taskSpec(task: TaskRow): string {
  return task.spec_body.trim() !== "" ? task.spec_body : task.description;
}

function taskKind(task: TaskRow): string {
  return task.no_code_class === null ? "code" : "docs";
}

function checkResult(run: VerificationRow): string {
  if (run.finished_at === null) return "not_run";
  return run.exit_code === 0 && run.timed_out === 0 ? "passed" : "failed";
}

function commandStatus(command: CommandRow): string {
  if (command.exit_code === null) return "not_run";
  return command.exit_code === 0 ? "passed" : "failed";
}

/** A plugin agent run's measured cost; null when it was never measured. */
function runCost(run: AgentRunRow): Record<string, unknown> | null {
  const cost: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    tokens_in: run.tokens_in,
    tokens_out: run.tokens_out,
    cache_read_tokens: run.cache_read_tokens,
    cache_creation_tokens: run.cache_creation_tokens,
    model: run.model,
    effort: run.effort,
  })) {
    if (value !== null) cost[key] = value;
  }
  if (Object.keys(cost).length === 0) return null;
  return { ...cost, tool_uses: run.tool_uses, duration_ms: run.duration_ms };
}

/** Makes ids that carry each record's own creation time, in order within one kind. */
function backdatedIds(): (at: string) => string {
  let time = 0;
  const factory = createIdFactory(() => time);
  return (at) => {
    time = Date.parse(at);
    return factory();
  };
}

/** Opens a readable copy of a plugin database at the schema this tool reads, and hands it to `use`. */
function withPluginDb<T>(pluginDbPath: string, use: (db: Database, from: string, pluginVersion: string | null) => T): T {
  const from = path.resolve(pluginDbPath);
  if (!statSync(from, { throwIfNoEntry: false })?.isFile()) throw new MigrationError(`no plugin database at ${from}`);
  const { db, cleanup } = readableCopy(from);
  try {
    const { schemaVersion, pluginVersion } = pluginMeta(db, from);
    if (schemaVersion !== PLUGIN_SCHEMA_VERSION) {
      const advice =
        schemaVersion < PLUGIN_SCHEMA_VERSION
          ? "open a Claude Code session with the plugin in the project once to upgrade it, then migrate"
          : "this tmb reads only that version";
      throw new MigrationError(`${from} has plugin schema version ${schemaVersion}; the migration reads version ${PLUGIN_SCHEMA_VERSION}: ${advice}`);
    }
    return use(db, from, pluginVersion);
  } finally {
    cleanup();
  }
}

/** The plugin's repos, by the names its issues give them. */
function pluginRepos(db: Database): string[] {
  return (db.query("SELECT DISTINCT repo FROM issues WHERE repo IS NOT NULL AND id <> ? ORDER BY repo").all(SYSTEM_ISSUE_ID) as { repo: string }[]).map(
    (row) => row.repo,
  );
}

/**
 * Copies the plugin project's records at `pluginDbPath` into `store`, in one transaction:
 * either every record carries over or none does. Refuses a database at any schema version
 * but 76, and a record that already holds issues or tasks.
 */
export function migratePluginProject(store: Store, options: { pluginDbPath: string; projectDir: string; repo?: string }): MigrationResult {
  if (!statSync(path.resolve(options.pluginDbPath), { throwIfNoEntry: false })?.isFile()) {
    throw new MigrationError(`no plugin database at ${path.resolve(options.pluginDbPath)}`);
  }
  if (store.listIssues().length > 0 || store.listTasks().length > 0) {
    throw new MigrationError("the tmb record already holds issues or tasks; a migration only fills a new record");
  }
  return withPluginDb(options.pluginDbPath, (db, from, pluginVersion) => {
    const repo = chooseRepo(db, options.repo, options.projectDir);
    return store.transaction(() => copyRecords(db, store, { from, pluginVersion, repo, into: null, withRepoless: true, targets: new Map() }));
  });
}

/** What a workspace migration did: one result per plugin repo copied, and each plugin repo it left out, with why. */
export type WorkspaceMigration = { results: MigrationResult[]; leftOut: { repo: string; reason: string }[] };

/** Why a workspace folder cannot take a plugin repo's rows; null when it can. */
function targetRefusal(repos: RepoPolicies, name: string): string | null {
  const policy = repos[name];
  if (policy === undefined) return `the workspace has no repo ${JSON.stringify(name)}; its repos are ${Object.keys(repos).join(", ") || "none"}`;
  if (policy.git === false) return `${name} is a folder that is not a repo, so tmb does no work in it`;
  if (!isManaged(policy)) return `${name} is exempt, so tmb does no work in it`;
  return null;
}

/**
 * Copies a multi-repo plugin project into a workspace's one record (trustmybot/tmb#193), in one
 * transaction. A plugin repo goes to the workspace repo of the same name, or to `into` when
 * `repo` names it; nothing else is guessed. With no `repo`, every plugin repo that maps is
 * copied and each one left out is named. A plugin repo already migrated into the record is
 * refused, and the plugin's issues of no repo are copied once, with the first migration.
 * Each copied task names its workspace repo; issues stay repo-less.
 */
export function migratePluginWorkspace(
  store: Store,
  repos: RepoPolicies,
  options: { pluginDbPath: string; repo?: string; into?: string },
): WorkspaceMigration {
  if (options.into !== undefined && options.repo === undefined) throw new MigrationError("--into names where --repo's rows go; name the plugin repo with --repo");
  const earlier = store.listImports(PLUGIN_IMPORT).map((entry) => entry.repo);
  const migrated = new Set(earlier.filter((repo): repo is string => repo !== null));
  return withPluginDb(options.pluginDbPath, (db, from, pluginVersion) => {
    const plugin = pluginRepos(db);
    const workspace = Object.keys(repos).sort();
    const sides = `the plugin's repos are ${plugin.join(", ") || "none"}; the workspace's are ${workspace.join(", ") || "none"}`;
    const targets = new Map<string, string>();
    const leftOut: WorkspaceMigration["leftOut"] = [];
    if (options.repo !== undefined) {
      if (!plugin.includes(options.repo)) throw new MigrationError(`the plugin database has no issues in repo ${JSON.stringify(options.repo)}; ${sides}`);
      if (migrated.has(options.repo)) throw new MigrationError(`the plugin's repo ${options.repo} is already migrated into this record`);
      const into = options.into ?? (repos[options.repo] !== undefined ? options.repo : null);
      if (into === null) {
        throw new MigrationError(`the workspace has no repo named ${options.repo}; name where its rows go with --repo ${options.repo} --into <workspace repo>: ${sides}`);
      }
      const refusal = targetRefusal(repos, into);
      if (refusal !== null) throw new MigrationError(`the plugin's repo ${options.repo} cannot go to ${into}: ${refusal}`);
      targets.set(options.repo, into);
    } else {
      for (const name of plugin) {
        if (migrated.has(name)) leftOut.push({ repo: name, reason: "already migrated into this record" });
        else if (repos[name] === undefined) leftOut.push({ repo: name, reason: `the workspace has no repo of that name; map it with --repo ${name} --into <workspace repo>` });
        else {
          const refusal = targetRefusal(repos, name);
          if (refusal !== null) leftOut.push({ repo: name, reason: `${refusal}; map it with --repo ${name} --into <workspace repo>` });
          else targets.set(name, name);
        }
      }
      if (targets.size === 0) {
        const why = leftOut.map((left) => `${left.repo}: ${left.reason}`).join("; ");
        throw new MigrationError(`no plugin repo maps to a workspace repo to migrate (${why || "the plugin has no repos"}); ${sides}`);
      }
    }
    return store.transaction(() => {
      let withRepoless = earlier.length === 0;
      const results: MigrationResult[] = [];
      for (const [repo, into] of targets) {
        results.push(copyRecords(db, store, { from, pluginVersion, repo, into, withRepoless, targets }));
        withRepoless = false;
      }
      return { results, leftOut };
    });
  });
}

/**
 * `into` is the workspace repo the rows go to, null in a single-repo project. `withRepoless`
 * copies the plugin's issues of no repo too. A task the plugin cut in another repo that `targets`
 * maps goes to that repo's workspace repo; any other goes to `into`.
 */
function copyRecords(
  db: Database,
  store: Store,
  source: { from: string; pluginVersion: string | null; repo: string | null; into: string | null; withRepoless: boolean; targets: ReadonlyMap<string, string> },
): MigrationResult {
  const now = new Date().toISOString();
  const counts: MigrationCounts = { issues: 0, discussions: 0, tasks: 0, openTasks: 0, reviews: 0, checkRuns: 0, runs: 0 };
  const issueIds = new Map<number, string>();
  const taskIds = new Map<number, string>();
  const tasks = new Map<number, TaskRow>();
  const leftBehind: Record<string, number> = {};

  const issues = db
    .query(
      `SELECT id, objective, description, status, created_at, updated_at, closed_at, gh_iid, gl_iid, repo, milestone
         FROM issues WHERE id <> ? AND (${source.withRepoless ? "repo IS NULL OR " : ""}repo = ?) ORDER BY created_at, id`,
    )
    .all(SYSTEM_ISSUE_ID, source.repo) as IssueRow[];
  const issueId = backdatedIds();
  for (const issue of issues) {
    const at = isoTime(issue.created_at) ?? now;
    const title = issue.objective.trim() !== "" ? issue.objective : `Plugin issue ${issue.id}`;
    const id = store.backdated(at, () =>
      store.createIssue(actorOf("bro"), { id: issueId(at), title, body: issue.description, milestone: issue.milestone }),
    );
    issueIds.set(issue.id, id);
    counts.issues++;
  }

  const discussionId = backdatedIds();
  for (const row of db.query("SELECT id, issue_id, author, kind, body, created_at FROM discussions ORDER BY created_at, id").all() as DiscussionRow[]) {
    const issue = issueIds.get(row.issue_id);
    if (issue === undefined || row.body.trim() === "") continue;
    if (!DISCUSSION_KINDS.has(row.kind)) {
      leftBehind[row.kind] = (leftBehind[row.kind] ?? 0) + 1;
      continue;
    }
    const at = isoTime(row.created_at) ?? now;
    store.backdated(at, () =>
      store.appendDiscussion(actorOf(row.author), {
        id: discussionId(at),
        issueId: issue,
        kind: row.kind === "decision" ? "decision" : "note",
        body: row.body,
      }),
    );
    counts.discussions++;
  }

  const taskId = backdatedIds();
  const taskRows = db
    .query(
      `SELECT id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at, completed_at,
              worktree_path, workflow_mode, base_sha, no_code_class, repo
         FROM tasks ORDER BY created_at, id`,
    )
    .all() as TaskRow[];
  for (const task of taskRows) {
    const issue = issueIds.get(task.issue_id);
    if (issue === undefined) continue;
    const at = isoTime(task.created_at) ?? now;
    const closed = TASK_CLOSED_STATES.has(task.status);
    if (!closed) counts.openTasks++;
    const id = store.backdated(at, () =>
      store.appendTask(actorOf("bro"), {
        id: taskId(at),
        issueId: issue,
        title: task.title.trim() !== "" ? task.title : firstLine(task.description) || `Plugin task ${task.id}`,
        spec: taskSpec(task),
        state: closed ? "closed" : "open",
        branch: task.branch_id,
        commitSha: task.commit_sha,
        worktree: task.worktree_path,
        baseCommit: task.base_sha,
        kind: taskKind(task),
        repo: source.into === null ? null : ((task.repo === null ? undefined : source.targets.get(task.repo)) ?? source.into),
      }),
    );
    if (closed && (task.workflow_mode === "agile" || task.workflow_mode === "truest")) {
      const closedAt = isoTime(task.completed_at) ?? isoTime(task.updated_at) ?? at;
      store.backdated(closedAt, () => store.updateTask(actorOf("bro"), id, { reviewMode: task.workflow_mode }));
    }
    taskIds.set(task.id, id);
    tasks.set(task.id, task);
    counts.tasks++;
  }

  const findings = hasTable(db, "review_findings")
    ? (db
        .query("SELECT task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, severity, class FROM review_findings ORDER BY created_at, id")
        .all() as FindingRow[])
    : [];
  const reviewId = backdatedIds();
  for (const attempt of db
    .query("SELECT id, task_id, attempt_n, agent, verdict, feedback, created_at, reviewed_sha, probes_json FROM validation_attempts ORDER BY created_at, id")
    .all() as AttemptRow[]) {
    const task = tasks.get(attempt.task_id);
    if (task === undefined) continue;
    const at = isoTime(attempt.created_at) ?? now;
    const sha = attempt.reviewed_sha ?? task.commit_sha;
    const ownFindings = findings
      .filter((finding) => finding.task_id === attempt.task_id && finding.attempt_n === attempt.attempt_n)
      .map((finding) => ({
        criterion: finding.criterion_id,
        probe: finding.probe_cmd,
        expected: finding.expected,
        observed: finding.observed,
        status: finding.status,
        severity: finding.severity,
        class: finding.class,
      }));
    const probes = probesOf(attempt.probes_json);
    store.backdated(at, () =>
      store.appendReview(actorOf(attempt.agent || "code-reviewer"), {
        id: reviewId(at),
        target: sha ? { kind: "commit", ref: sha } : { kind: "branch", ref: task.branch_id },
        verdict: attempt.verdict,
        findings: [{ task: taskIds.get(attempt.task_id), attempt: attempt.attempt_n, feedback: attempt.feedback }, ...ownFindings, ...probes.map((probe) => ({ probe }))],
      }),
    );
    counts.reviews++;
  }

  const commands = db.query("SELECT run_id, ordinal, command, exit_code, elapsed_s, output_tail FROM verification_run_commands ORDER BY run_id, ordinal").all() as CommandRow[];
  const checkId = backdatedIds();
  for (const run of db
    .query("SELECT id, task_id, commit_sha, source, started_at, finished_at, exit_code, timed_out FROM verification_runs ORDER BY started_at, id")
    .all() as VerificationRow[]) {
    const task = taskIds.get(run.task_id);
    if (task === undefined) continue;
    const at = isoTime(run.started_at) ?? now;
    store.backdated(at, () =>
      store.appendCheckRun(actorOf(run.source === "gate" ? "swe" : "bro"), {
        id: checkId(at),
        taskId: task,
        commitSha: run.commit_sha,
        startedAt: at,
        endedAt: isoTime(run.finished_at),
        result: checkResult(run),
        commands: commands
          .filter((command) => command.run_id === run.id)
          .map((command) => ({
            command: command.command,
            status: commandStatus(command),
            exitCode: command.exit_code,
            elapsedSeconds: command.elapsed_s,
            outputTail: command.output_tail ?? "",
          })),
      }),
    );
    counts.checkRuns++;
  }

  const runId = backdatedIds();
  for (const run of db
    .query(
      `SELECT id, task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms,
              started_at, completed_at, model, host, exit_reason, effort
         FROM agent_runs ORDER BY coalesce(started_at, completed_at), id`,
    )
    .all() as AgentRunRow[]) {
    const task = run.task_id === null ? null : (taskIds.get(run.task_id) ?? undefined);
    if (task === undefined) continue;
    if (task === null && (run.issue_id === null || !issueIds.has(run.issue_id))) continue;
    const at = isoTime(run.started_at) ?? isoTime(run.completed_at) ?? now;
    store.backdated(at, () =>
      store.appendRun(actorOf(run.agent_type, run.host), {
        id: runId(at),
        taskId: task,
        role: roleOf(run.agent_type),
        startedAt: at,
        endedAt: isoTime(run.completed_at),
        outcome: run.exit_reason,
        cost: runCost(run),
      }),
    );
    counts.runs++;
  }

  for (const issue of issues) {
    const id = issueIds.get(issue.id)!;
    const numbers = [issue.gh_iid === null ? null : `GitHub #${issue.gh_iid}`, issue.gl_iid === null ? null : `GitLab #${issue.gl_iid}`].filter(Boolean);
    const where = [numbers.length > 0 ? numbers.join(", ") : null, issue.repo === null ? null : `repo ${issue.repo}`].filter(Boolean).join(", ");
    store.appendDiscussion(HUMAN, { issueId: id, kind: "note", body: `Carried over from the plugin's issue ${issue.id}${where ? ` (${where})` : ""}.` });
    if (issue.status === "closed") {
      const closedAt = isoTime(issue.closed_at) ?? isoTime(issue.updated_at) ?? now;
      store.backdated(closedAt, () => store.updateIssue(actorOf("bro"), id, { state: "closed" }));
    }
  }

  const result: MigrationResult = {
    from: source.from,
    pluginVersion: source.pluginVersion,
    repo: source.repo,
    into: source.into,
    counts,
    leftBehind,
    ids: {
      issues: Object.fromEntries([...issueIds].map(([plugin, tmb]) => [String(plugin), tmb])),
      tasks: Object.fromEntries([...taskIds].map(([plugin, tmb]) => [String(plugin), tmb])),
    },
  };
  const detail = { ...result, schemaVersion: PLUGIN_SCHEMA_VERSION };
  store.recordImport(HUMAN, { source: PLUGIN_IMPORT, repo: typeof detail.repo === "string" ? detail.repo : null, detail });
  return result;
}
