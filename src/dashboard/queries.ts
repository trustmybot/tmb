// The dashboard's reads: plain SELECTs over the record's projections, on a read-only
// connection. Each returns rows in the shape the web pages show, snake_case as stored, with
// `created_by` parsed back into its actor and an `author` name for display.
import type { Database } from "bun:sqlite";
import type { Actor } from "../engine/index.ts";

export type Row = Record<string, unknown>;

const RECENT_RUNS = 10;
export const LIST_LIMIT_MAX = 1000;
const LIST_LIMIT_DEFAULT = 300;

/**
 * The Human, the agent's role, or tmb; the host and source stay in `created_by`. A row the syncer
 * mirrored names the remote account that wrote it, not tmb.
 */
export function authorOf(actor: Actor): string {
  if (actor.kind === "tmb" && actor.remote) return actor.remote;
  return actor.kind === "agent" ? actor.role : actor.kind;
}

function parseJson(text: unknown, fallback: unknown): unknown {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Parses `created_by` and any JSON columns named, and adds `author`. */
function shape(row: Row, jsonColumns: Record<string, unknown> = {}): Row {
  const out: Row = { ...row };
  if (typeof row.created_by === "string") {
    const actor = parseJson(row.created_by, null) as Actor | null;
    out.created_by = actor;
    out.author = actor ? authorOf(actor) : null;
  }
  for (const [column, fallback] of Object.entries(jsonColumns)) {
    if (column in row) out[column] = parseJson(row[column], fallback);
  }
  return out;
}

export function clampLimit(raw: string | null): number {
  const n = Number(raw ?? LIST_LIMIT_DEFAULT);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), LIST_LIMIT_MAX) : LIST_LIMIT_DEFAULT;
}

const ISSUE_LIST_SQL = `
SELECT i.id, i.title, i.state, i.milestone, i.created_by, i.created_at, i.updated_at, i.remote, i.remote_url, i.remote_created_at,
  COALESCE(i.remote_created_at, i.created_at) AS opened_at,
  (SELECT count(*) FROM tasks t WHERE t.issue_id = i.id) AS task_count,
  (SELECT count(*) FROM tasks t WHERE t.issue_id = i.id AND t.state = 'closed') AS tasks_done,
  (SELECT count(*) FROM discussions d WHERE d.issue_id = i.id) AS discussion_count
FROM issues i ORDER BY i.id`;

const TASK_SQL = `
SELECT t.id, t.issue_id, i.title AS issue_title, t.title, t.spec, t.state, t.kind, t.branch, t.worktree,
  t.base_commit, t.commit_sha, t.feature_id, f.name AS feature_name, f.state AS feature_state, f.pr_url AS feature_pr_url, t.review_mode, t.push_result,
  t.push_detail, t.created_by, t.created_at, t.updated_at,
  (SELECT c.result FROM check_runs c WHERE c.task_id = t.id ORDER BY c.id DESC LIMIT 1) AS last_check
FROM tasks t
JOIN issues i ON i.id = t.issue_id
LEFT JOIN features f ON f.id = t.feature_id`;

const RUN_SQL = `
SELECT r.id, r.task_id, t.title AS task_title, COALESCE(r.feature_id, t.feature_id) AS feature_id, f.name AS feature_name,
  r.role, r.started_at, r.ended_at, r.outcome, r.cost, r.created_by, r.created_at
FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
LEFT JOIN features f ON f.id = COALESCE(r.feature_id, t.feature_id)`;

const CHECK_RUN_SQL = `
SELECT c.id, c.task_id, t.title AS task_title, c.commit_sha, c.started_at, c.ended_at, c.result, c.commands, c.created_by, c.created_at
FROM check_runs c JOIN tasks t ON t.id = c.task_id`;

const runRow = (r: Row) => shape(r, { cost: null });
const checkRow = (r: Row) => shape(r, { commands: [] });

/** The dashboard's reads of the record, on the read-only connection it is given. */
export class RecordQueries {
  constructor(private readonly db: Database) {}

  private all(sql: string, ...params: (string | number)[]): Row[] {
    return this.db.query(sql).all(...params) as Row[];
  }

  /** Changes whenever another connection commits to the database, so the page knows to refetch. */
  dataVersion(): number {
    return (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  }

  issues(): Row[] {
    return this.all(ISSUE_LIST_SQL).map((r) => shape(r));
  }

  issueDetail(id: string): Row | null {
    const issue = this.db.query("SELECT * FROM issues WHERE id = ?").get(id) as Row | null;
    if (!issue) return null;
    const discussions = this.all("SELECT * FROM discussions WHERE issue_id = ? ORDER BY id", id).map((r) => shape(r));
    const decision = [...discussions].reverse().find((d) => d.kind === "decision") ?? null;
    return {
      issue: shape(issue),
      discussions,
      decision_in_force: decision?.id ?? null,
      tasks: this.all(`${TASK_SQL} WHERE t.issue_id = ? ORDER BY t.id`, id).map((r) => shape(r)),
      milestones: this.all("SELECT DISTINCT milestone FROM issues WHERE milestone IS NOT NULL ORDER BY milestone").map((r) => r.milestone),
    };
  }

  tasks(): Row[] {
    return this.all(`${TASK_SQL} ORDER BY t.id`).map((r) => shape(r));
  }

  taskDetail(id: string): Row | null {
    const task = this.db.query(`${TASK_SQL} WHERE t.id = ?`).get(id) as Row | null;
    if (!task) return null;
    return {
      task: shape(task),
      check_runs: this.all(`${CHECK_RUN_SQL} WHERE c.task_id = ? ORDER BY c.id DESC`, id).map(checkRow),
      runs: this.all(`${RUN_SQL} WHERE r.task_id = ? ORDER BY r.id DESC`, id).map(runRow),
    };
  }

  features(): Row[] {
    return this.all(`SELECT f.*,
         (SELECT count(*) FROM tasks t WHERE t.feature_id = f.id) AS task_count,
         (SELECT count(*) FROM tasks t WHERE t.feature_id = f.id AND t.state <> 'closed') AS open_task_count
       FROM features f ORDER BY f.id`,
    ).map((r) => shape(r));
  }

  runs(limit: number): Row[] {
    return this.all(`${RUN_SQL} ORDER BY r.id DESC LIMIT ?`, limit).map(runRow);
  }

  checkRuns(limit: number): Row[] {
    return this.all(`${CHECK_RUN_SQL} ORDER BY c.id DESC LIMIT ?`, limit).map(checkRow);
  }

  guardDecisions(limit: number): Row[] {
    return this.all("SELECT * FROM guard_decisions ORDER BY id DESC LIMIT ?", limit).map((r) => shape(r));
  }

  /**
   * The feed of what the audit trail held before it went (trustmybot/tmb#408): setting changes,
   * waivers, review marks, freezes, feedback reports and imports, newest first, each as what and detail.
   */
  audit(limit: number): Row[] {
    return this.all(`SELECT id, created_by, created_at, 'setting:' || key || coalesce(' (' || repo || ')', '') AS what,
              coalesce(new_value, '') || coalesce(' via ' || how, '') AS detail FROM setting_changes
       UNION ALL SELECT id, created_by, created_at, 'waiver', commit_sha || ': ' || reason FROM waivers
       UNION ALL SELECT id, created_by, created_at, 'review_mark', kind || ' ' || state || ' on ' || commit_sha || CASE WHEN sent_at IS NULL THEN ', not sent' ELSE '' END FROM review_marks
       UNION ALL SELECT id, created_by, created_at, 'freeze', reason || CASE WHEN lifted_at IS NULL THEN '' ELSE ', lifted' END FROM freezes
       UNION ALL SELECT id, created_by, created_at, 'feedback', route || coalesce(' ' || url, '') FROM feedback_reports
       UNION ALL SELECT id, created_by, created_at, 'import', source || coalesce(' ' || repo, '') FROM imports
       ORDER BY id DESC LIMIT ?`,
      limit,
    ).map((r) => shape(r));
  }

  summary(): Row {
    const count = (sql: string) => (this.db.query(sql).get() as { n: number }).n;
    return {
      issues: {
        open: count("SELECT count(*) AS n FROM issues WHERE state = 'open'"),
        closed: count("SELECT count(*) AS n FROM issues WHERE state = 'closed'"),
      },
      tasks_by_state: this.all("SELECT state, count(*) AS count FROM tasks GROUP BY state ORDER BY state"),
      open_features: count("SELECT count(*) AS n FROM features WHERE state = 'open'"),
      open_runs: count("SELECT count(*) AS n FROM runs WHERE ended_at IS NULL"),
      recent_runs: this.runs(RECENT_RUNS),
    };
  }
}
