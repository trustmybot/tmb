// The record store: every write appends one event and applies it to the projections in
// the same transaction; reads come from the projections and return small pieces.
import type { Database } from "bun:sqlite";
import { isId, newId } from "../ids.ts";
import { type Actor, type ActorColumns, type Role, actorColumns, actorFromColumns, assertWriter } from "./actor.ts";
import { type EventType, type RecordKind, type StoredEvent, applyEvent, assertValues } from "./projections.ts";
import { PROJECTION_TABLES } from "./schema.ts";

export const SNIPPET_MAX = 200;

/** The key under which the record names the tmb that wrote its shape. */
export const SHAPE_WRITER_KEY = "shape_writer";
/** A tmb as it signs a shape it wrote: its version and the program it ran as. */
export type ShapeWriter = { version: string; program: string };
export const SEARCH_LIMIT_MAX = 50;

export type IssueState = "open" | "closed";
export type DiscussionKind = "note" | "decision";

export type Issue = {
  id: string;
  title: string;
  body: string;
  state: IssueState;
  milestone: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
};

/** An issue as a list shows it: the body cut to a snippet. */
export type IssueSummary = { id: string; title: string; state: IssueState; milestone: string | null; snippet: string };

export type Discussion = {
  id: string;
  issueId: string;
  kind: DiscussionKind;
  body: string;
  createdBy: Actor;
  createdAt: string;
};

export type SearchHit = {
  kind: "issue" | "discussion";
  id: string;
  issueId: string;
  title: string;
  state: IssueState;
  snippet: string;
};

/** `id` is for a record copied from elsewhere, such as a migration, that keeps an id made for it beforehand. */
export type NewIssue = { id?: string; title: string; body?: string; milestone?: string | null };
export type IssueChanges = { title?: string; body?: string; state?: IssueState; milestone?: string | null };
export type NewDiscussion = { id?: string; issueId: string; kind: DiscussionKind; body: string };
/** Details an entry keeps in its event's data, beyond its columns (trustmybot/tmb#408). */
export type EntryDetail = Record<string, unknown>;
/** A Human waiver of a review at one commit, of one task or one feature branch; or one a rebase carried. */
export type NewWaiver = { taskId?: string | null; featureId?: string | null; commitSha: string; reason: string; carriedFrom?: string | null; detail?: EntryDetail };
export type WaiverEntry = {
  id: string;
  taskId: string | null;
  featureId: string | null;
  carriedFrom: string | null;
  commitSha: string;
  reason: string;
  createdBy: Actor;
  createdAt: string;
};
/** The mark tmb set, or tried to set, on a commit for a verdict or a waiver. */
export type NewReviewMark = {
  taskId?: string | null;
  featureId?: string | null;
  commitSha: string;
  kind: string;
  state: string;
  sentAt?: string | null;
  /** The text the remote is shown. */
  description: string;
  detail?: EntryDetail;
};
export type ReviewMark = {
  id: string;
  taskId: string | null;
  featureId: string | null;
  commitSha: string;
  kind: string;
  state: string;
  sentAt: string | null;
  description: string;
  createdBy: Actor;
  createdAt: string;
};
/** One change to a setting: its key, the repo for one repo's own, and the values as JSON text. */
export type NewSettingChange = { key: string; repo?: string | null; oldValue: string | null; newValue: string | null; how?: string | null; detail?: EntryDetail };
export type SettingChange = {
  id: string;
  key: string;
  repo: string | null;
  oldValue: string | null;
  newValue: string | null;
  how: string | null;
  createdBy: Actor;
  createdAt: string;
};
export type NewFeedbackReport = { route: string; url?: string | null; issueId?: string | null; detail?: EntryDetail };
export type FeedbackReport = { id: string; route: string; url: string | null; issueId: string | null; createdBy: Actor; createdAt: string };
export type NewImport = { source: string; repo?: string | null; detail: unknown };
export type ImportEntry = { id: string; source: string; repo: string | null; detail: unknown; createdBy: Actor; createdAt: string };
export type NewTask = {
  /** An id made beforehand, when something outside the record, such as a branch, is named after the task first. */
  id?: string;
  issueId: string;
  title: string;
  spec?: string;
  state?: string;
  branch?: string | null;
  commitSha?: string | null;
  worktree?: string | null;
  baseCommit?: string | null;
  featureId?: string | null;
  kind?: string | null;
  /** The commit that holds the main folder as it was when the task started. */
  mainSnapshot?: string | null;
  /** The repo the task was cut in, by its name in the workspace; null for the project folder itself. */
  repo?: string | null;
  /** The dropped task this one replaces. */
  replaces?: string | null;
};
export type Task = {
  id: string;
  issueId: string;
  title: string;
  spec: string;
  state: string;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  commitSha: string | null;
  featureId: string | null;
  kind: string | null;
  reviewMode: string | null;
  pushResult: string | null;
  pushDetail: string | null;
  /** The pull request the engine opened for a truest task; null until then. */
  prUrl: string | null;
  /** The commit that holds the main folder as it was when the task started; null for a task started before tasks kept one. */
  mainSnapshot: string | null;
  /** The repo the task was cut in, by its name in the workspace; null for the project folder itself. */
  repo: string | null;
  /** Why the task was dropped; null unless it is. */
  dropReason: string | null;
  /** The dropped task this one replaces; null when it replaces none. */
  replaces: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
};
export type TaskChanges = {
  state?: string;
  commitSha?: string | null;
  reviewMode?: string | null;
  pushResult?: string | null;
  pushDetail?: string | null;
  prUrl?: string | null;
  /** A truest task rebased onto a moved base branch now leaves it at the new base. */
  baseCommit?: string | null;
  /** The worktree a worker's host made and tmb adopted as the task's. */
  worktree?: string | null;
  /** Why the planner or the Human dropped the task. */
  dropReason?: string | null;
  /** The workspace repo of a task made before its project became a workspace (trustmybot/tmb#257). */
  repo?: string | null;
};
export type NewFeature = { name: string; baseBranch: string; baseCommit: string; repo?: string | null };
export type FeatureChanges = { state?: string; prUrl?: string | null; dropReason?: string | null; baseMergedCommit?: string | null };
export type Feature = {
  id: string;
  name: string;
  baseBranch: string;
  baseCommit: string;
  state: string;
  /** The pull request the engine opened for it; null until then. */
  prUrl: string | null;
  /** The repo the feature branch was cut in, by its name in the workspace; null for the project folder itself. */
  repo: string | null;
  /** Why the feature branch was dropped; null unless it is. */
  dropReason: string | null;
  /** The base branch's commit last brought into the branch; null until one is. */
  baseMergedCommit: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
};
/** Tokens one model used in a run, as the host reported them; never money (trustmybot/tmb#133). */
export type ModelUsage = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type Run = {
  id: string;
  taskId: string | null;
  /** The feature branch a branch review's run reviewed; a worker's run reads its feature through its task. */
  featureId: string | null;
  role: Role;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  /** One entry per model, or null when the host gave none. */
  cost: ModelUsage[] | null;
  createdBy: Actor;
};
export type RunEnd = { endedAt?: string; outcome?: string | null; cost?: ModelUsage[] | null };
export type CheckRun = {
  id: string;
  taskId: string;
  commitSha: string;
  startedAt: string;
  endedAt: string | null;
  result: string | null;
  commands: unknown[];
  createdBy: Actor;
};
export type CheckRunEnd = { endedAt?: string; result: string; commands: unknown[] };
export type NewRun = {
  id?: string;
  taskId?: string | null;
  role: Role;
  startedAt?: string;
  endedAt?: string | null;
  outcome?: string | null;
  cost?: ModelUsage[] | Record<string, unknown> | null;
  featureId?: string | null;
};
export type NewCheckRun = {
  id?: string;
  taskId: string;
  commitSha: string;
  startedAt?: string;
  endedAt?: string | null;
  result?: string | null;
  commands?: unknown[];
};
export type NewReview = {
  id?: string;
  target: { kind: "commit" | "branch"; ref: string };
  verdict: string;
  findings?: unknown[];
  /** The feature branch a branch review judged, and the commit it judged it at. */
  featureId?: string | null;
  commitSha?: string | null;
  /** The reviewer run that wrote it. */
  runId?: string | null;
  /** The review a rebase carried to this commit. */
  carriedFrom?: string | null;
  detail?: EntryDetail;
};
export type Review = {
  id: string;
  targetKind: "commit" | "branch";
  target: string;
  verdict: string;
  findings: unknown[];
  featureId: string | null;
  commitSha: string | null;
  runId: string | null;
  carriedFrom: string | null;
  createdBy: Actor;
  createdAt: string;
};
export type NewGuardDecision = { event: string; decision: "allow" | "deny"; reason: string };
export type GuardDecision = NewGuardDecision & { id: string; createdBy: Actor; createdAt: string };

type EventRow = ActorColumns & { id: string; record_kind: RecordKind; record_id: string; type: EventType; data: string; at: string };
type IssueRow = {
  id: string;
  title: string;
  body: string;
  state: IssueState;
  milestone: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type DiscussionRow = { id: string; issue_id: string; kind: DiscussionKind; body: string; created_by: string; created_at: string };
type GuardDecisionRow = { id: string; event: string; decision: "allow" | "deny"; reason: string; created_by: string; created_at: string };
type WaiverRow = {
  id: string;
  task_id: string | null;
  feature_id: string | null;
  carried_from: string | null;
  commit_sha: string;
  reason: string;
  created_by: string;
  created_at: string;
};
type ReviewMarkRow = {
  id: string;
  task_id: string | null;
  feature_id: string | null;
  commit_sha: string;
  kind: string;
  state: string;
  sent_at: string | null;
  data: string;
  created_by: string;
  created_at: string;
};
type SettingChangeRow = {
  id: string;
  key: string;
  repo: string | null;
  old_value: string | null;
  new_value: string | null;
  how: string | null;
  created_by: string;
  created_at: string;
};
type FeedbackReportRow = { id: string; route: string; url: string | null; issue_id: string | null; created_by: string; created_at: string };
type ImportRow = { id: string; source: string; repo: string | null; detail: string; created_by: string; created_at: string };
type TaskRow = {
  id: string;
  issue_id: string;
  title: string;
  spec: string;
  state: string;
  branch: string | null;
  worktree: string | null;
  base_commit: string | null;
  commit_sha: string | null;
  feature_id: string | null;
  kind: string | null;
  review_mode: string | null;
  push_result: string | null;
  push_detail: string | null;
  pr_url?: string | null;
  main_snapshot?: string | null;
  repo?: string | null;
  drop_reason?: string | null;
  replaces?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type FeatureRow = {
  id: string;
  name: string;
  base_branch: string;
  base_commit: string;
  state: string;
  pr_url: string | null;
  repo?: string | null;
  drop_reason?: string | null;
  base_merged_commit?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type ReviewRow = {
  id: string;
  target_kind: "commit" | "branch";
  target: string;
  verdict: string;
  findings: string;
  feature_id: string | null;
  commit_sha: string | null;
  run_id: string | null;
  carried_from?: string | null;
  created_by: string;
  created_at: string;
};
type RunRow = {
  id: string;
  task_id: string | null;
  feature_id: string | null;
  role: Role;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  cost: string | null;
  created_by: string;
};
type CheckRunRow = {
  id: string;
  task_id: string;
  commit_sha: string;
  started_at: string;
  ended_at: string | null;
  result: string | null;
  commands: string;
  created_by: string;
};

/** Flattens whitespace and cuts text to at most SNIPPET_MAX characters, marking a cut with an ellipsis. */
export function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= SNIPPET_MAX ? flat : `${chars.slice(0, SNIPPET_MAX - 1).join("")}…`;
}

/** Quotes each word so user text can never be read as FTS5 query syntax; the words are ANDed. */
function toMatchQuery(query: string): string | null {
  const words = query.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words.length > 0 ? words.map((word) => `"${word.replace(/"/g, '""')}"`).join(" ") : null;
}

/** Drops undefined fields the way the stored JSON will, so the live apply and a rebuild see the same data. */
function asStoredData(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

function toEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    recordKind: row.record_kind,
    recordId: row.record_id,
    type: row.type,
    data: JSON.parse(row.data) as Record<string, unknown>,
    actor: actorFromColumns(row),
    at: row.at,
  };
}

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    state: row.state,
    milestone: row.milestone,
    createdBy: JSON.parse(row.created_by) as Actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWaiver(row: WaiverRow): WaiverEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    featureId: row.feature_id,
    carriedFrom: row.carried_from,
    commitSha: row.commit_sha,
    reason: row.reason,
    createdBy: JSON.parse(row.created_by) as Actor,
    createdAt: row.created_at,
  };
}

function toReviewMark(row: ReviewMarkRow): ReviewMark {
  const data = JSON.parse(row.data) as { description?: unknown };
  return {
    id: row.id,
    taskId: row.task_id,
    featureId: row.feature_id,
    commitSha: row.commit_sha,
    kind: row.kind,
    state: row.state,
    sentAt: row.sent_at,
    description: typeof data.description === "string" ? data.description : "",
    createdBy: JSON.parse(row.created_by) as Actor,
    createdAt: row.created_at,
  };
}

function toSettingChange(row: SettingChangeRow): SettingChange {
  return {
    id: row.id,
    key: row.key,
    repo: row.repo,
    oldValue: row.old_value,
    newValue: row.new_value,
    how: row.how,
    createdBy: JSON.parse(row.created_by) as Actor,
    createdAt: row.created_at,
  };
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    issueId: row.issue_id,
    title: row.title,
    spec: row.spec,
    state: row.state,
    branch: row.branch,
    worktree: row.worktree,
    baseCommit: row.base_commit,
    commitSha: row.commit_sha,
    featureId: row.feature_id,
    kind: row.kind,
    reviewMode: row.review_mode,
    pushResult: row.push_result,
    pushDetail: row.push_detail,
    prUrl: row.pr_url ?? null,
    mainSnapshot: row.main_snapshot ?? null,
    repo: row.repo ?? null,
    dropReason: row.drop_reason ?? null,
    replaces: row.replaces ?? null,
    createdBy: JSON.parse(row.created_by) as Actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFeature(row: FeatureRow): Feature {
  return {
    id: row.id,
    name: row.name,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    state: row.state,
    prUrl: row.pr_url,
    repo: row.repo ?? null,
    dropReason: row.drop_reason ?? null,
    baseMergedCommit: row.base_merged_commit ?? null,
    createdBy: JSON.parse(row.created_by) as Actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    targetKind: row.target_kind,
    target: row.target,
    verdict: row.verdict,
    findings: JSON.parse(row.findings) as unknown[],
    featureId: row.feature_id,
    commitSha: row.commit_sha,
    runId: row.run_id,
    carriedFrom: row.carried_from ?? null,
    createdBy: JSON.parse(row.created_by) as Actor,
    createdAt: row.created_at,
  };
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    featureId: row.feature_id,
    role: row.role,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    cost: row.cost === null ? null : (JSON.parse(row.cost) as ModelUsage[]),
    createdBy: JSON.parse(row.created_by) as Actor,
  };
}

function toCheckRun(row: CheckRunRow): CheckRun {
  return {
    id: row.id,
    taskId: row.task_id,
    commitSha: row.commit_sha,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    result: row.result,
    commands: JSON.parse(row.commands) as unknown[],
    createdBy: JSON.parse(row.created_by) as Actor,
  };
}

function toDiscussion(row: DiscussionRow): Discussion {
  return {
    id: row.id,
    issueId: row.issue_id,
    kind: row.kind,
    body: row.body,
    createdBy: JSON.parse(row.created_by) as Actor,
    createdAt: row.created_at,
  };
}

export class Store {
  /** Use openStore; it checks the file and its schema version first. */
  constructor(private readonly db: Database) {}

  close(): void {
    this.db.close();
  }

  /** The tmb that wrote the record's current shape; null for a record from before it was signed. */
  shapeWriter(): ShapeWriter | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(SHAPE_WRITER_KEY) as { value: string } | null;
    if (!row) return null;
    const { version, program } = JSON.parse(row.value) as ShapeWriter;
    return { version, program };
  }

  // --- issues -------------------------------------------------------------------------

  createIssue(actor: Actor, issue: NewIssue): string {
    return this.create(actor, "issue", { title: issue.title, body: issue.body ?? "", milestone: issue.milestone ?? null }, issue.id);
  }

  updateIssue(actor: Actor, id: string, changes: IssueChanges): void {
    this.append(actor, "issue", id, "updated", { ...changes });
  }

  getIssue(id: string): Issue | null {
    const row = this.db.query("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | null;
    return row ? toIssue(row) : null;
  }

  listIssues(filter: { state?: IssueState } = {}): IssueSummary[] {
    const rows = (
      filter.state === undefined
        ? this.db.query("SELECT id, title, state, milestone, body FROM issues ORDER BY id").all()
        : this.db.query("SELECT id, title, state, milestone, body FROM issues WHERE state = ? ORDER BY id").all(filter.state)
    ) as Pick<IssueRow, "id" | "title" | "state" | "milestone" | "body">[];
    return rows.map(({ body, ...summary }) => ({ ...summary, snippet: clip(body) }));
  }

  // --- discussions --------------------------------------------------------------------

  appendDiscussion(actor: Actor, discussion: NewDiscussion): string {
    return this.create(actor, "discussion", { issue_id: discussion.issueId, kind: discussion.kind, body: discussion.body }, discussion.id);
  }

  /** The issue's discussion, oldest first. */
  listDiscussions(issueId: string): Discussion[] {
    const rows = this.db.query("SELECT * FROM discussions WHERE issue_id = ? ORDER BY id").all(issueId) as DiscussionRow[];
    return rows.map(toDiscussion);
  }

  /** The decision in force on an issue: its newest one. */
  newestDecision(issueId: string): Discussion | null {
    const row = this.db
      .query("SELECT * FROM discussions WHERE issue_id = ? AND kind = 'decision' ORDER BY id DESC LIMIT 1")
      .get(issueId) as DiscussionRow | null;
    return row ? toDiscussion(row) : null;
  }

  // --- the other records: one append path each; their workflow comes in later levels ---

  // --- what the audit trail held, each in its own table (trustmybot/tmb#408) ----------

  recordWaiver(actor: Actor, waiver: NewWaiver): string {
    return this.create(actor, "waiver", {
      ...waiver.detail,
      task_id: waiver.taskId ?? null,
      feature_id: waiver.featureId ?? null,
      carried_from: waiver.carriedFrom ?? null,
      commit_sha: waiver.commitSha,
      reason: waiver.reason,
    });
  }

  /** Every waiver, oldest first. */
  listWaivers(): WaiverEntry[] {
    return (this.db.query("SELECT * FROM waivers ORDER BY id").all() as WaiverRow[]).map(toWaiver);
  }

  getWaiver(id: string): WaiverEntry | null {
    const row = this.db.query("SELECT * FROM waivers WHERE id = ?").get(id) as WaiverRow | null;
    return row ? toWaiver(row) : null;
  }

  recordReviewMark(actor: Actor, mark: NewReviewMark): string {
    return this.create(actor, "review_mark", {
      ...mark.detail,
      task_id: mark.taskId ?? null,
      feature_id: mark.featureId ?? null,
      commit_sha: mark.commitSha,
      kind: mark.kind,
      state: mark.state,
      sent_at: mark.sentAt ?? null,
      description: mark.description,
    });
  }

  /** Records that the remote now has a mark recorded as not sent. */
  markSent(actor: Actor, id: string, at: string): void {
    this.append(actor, "review_mark", id, "updated", { sent_at: at });
  }

  /** Every review mark, oldest first, with the text it was set with. */
  listReviewMarks(): ReviewMark[] {
    const rows = this.db
      .query("SELECT m.*, e.data AS data FROM review_marks m JOIN events e ON e.record_id = m.id AND e.type = 'created' ORDER BY m.id")
      .all() as ReviewMarkRow[];
    return rows.map(toReviewMark);
  }

  recordSettingChange(actor: Actor, change: NewSettingChange): string {
    return this.create(actor, "setting_change", {
      ...change.detail,
      key: change.key,
      repo: change.repo ?? null,
      old_value: change.oldValue,
      new_value: change.newValue,
      how: change.how ?? null,
    });
  }

  /**
   * The newest change to `key`: for one repo's own setting when `repo` is given, else the project's.
   * With `valued`, the newest that set a value: that value is the one in force until the config
   * file holds it (trustmybot/tmb#305). A change with no value records only how a mode was chosen.
   */
  newestSettingChange(key: string, repo: string | null = null, valued = false): SettingChange | null {
    const value = valued ? " AND new_value IS NOT NULL" : "";
    const row = (
      repo === null
        ? this.db.query(`SELECT * FROM setting_changes WHERE key = ? AND repo IS NULL${value} ORDER BY id DESC LIMIT 1`).get(key)
        : this.db.query(`SELECT * FROM setting_changes WHERE key = ? AND repo = ?${value} ORDER BY id DESC LIMIT 1`).get(key, repo)
    ) as SettingChangeRow | null;
    return row ? toSettingChange(row) : null;
  }

  /** Every setting change, oldest first; only those of `key` when given. */
  listSettingChanges(key?: string): SettingChange[] {
    const rows = (
      key === undefined
        ? this.db.query("SELECT * FROM setting_changes ORDER BY id").all()
        : this.db.query("SELECT * FROM setting_changes WHERE key = ? ORDER BY id").all(key)
    ) as SettingChangeRow[];
    return rows.map(toSettingChange);
  }

  /** A freeze of agent work, with why; a session may name it (trustmybot/tmb#408). */
  recordFreeze(actor: Actor, freeze: { reason: string; sessionId?: string | null }): string {
    return this.create(actor, "freeze", { reason: freeze.reason, session_id: freeze.sessionId ?? null });
  }

  /** Lifts a freeze: who lifted it and when. */
  liftFreeze(actor: Actor, id: string, at: string): void {
    this.append(actor, "freeze", id, "updated", { lifted_by: actor, lifted_at: at });
  }

  recordFeedbackReport(actor: Actor, report: NewFeedbackReport): string {
    return this.create(actor, "feedback_report", { ...report.detail, route: report.route, url: report.url ?? null, issue_id: report.issueId ?? null });
  }

  /** Every feedback report filed or opened, oldest first. */
  listFeedbackReports(): FeedbackReport[] {
    const rows = this.db.query("SELECT * FROM feedback_reports ORDER BY id").all() as FeedbackReportRow[];
    return rows.map((row) => ({
      id: row.id,
      route: row.route,
      url: row.url,
      issueId: row.issue_id,
      createdBy: JSON.parse(row.created_by) as Actor,
      createdAt: row.created_at,
    }));
  }

  recordImport(actor: Actor, entry: NewImport): string {
    return this.create(actor, "import", { source: entry.source, repo: entry.repo ?? null, detail: entry.detail });
  }

  /** Every import from `source`, oldest first. */
  listImports(source: string): ImportEntry[] {
    const rows = this.db.query("SELECT * FROM imports WHERE source = ? ORDER BY id").all(source) as ImportRow[];
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      repo: row.repo,
      detail: JSON.parse(row.detail) as unknown,
      createdBy: JSON.parse(row.created_by) as Actor,
      createdAt: row.created_at,
    }));
  }

  appendTask(actor: Actor, task: NewTask): string {
    return this.create(actor, "task", {
      issue_id: task.issueId,
      title: task.title,
      spec: task.spec ?? "",
      state: task.state ?? "pending",
      branch: task.branch ?? null,
      commit_sha: task.commitSha ?? null,
      worktree: task.worktree ?? null,
      base_commit: task.baseCommit ?? null,
      feature_id: task.featureId ?? null,
      kind: task.kind ?? null,
      main_snapshot: task.mainSnapshot ?? null,
      repo: task.repo ?? null,
      replaces: task.replaces ?? null,
    }, task.id);
  }

  updateTask(actor: Actor, id: string, changes: TaskChanges): void {
    this.append(actor, "task", id, "updated", {
      state: changes.state,
      commit_sha: changes.commitSha,
      review_mode: changes.reviewMode,
      push_result: changes.pushResult,
      push_detail: changes.pushDetail,
      pr_url: changes.prUrl,
      base_commit: changes.baseCommit,
      worktree: changes.worktree,
      drop_reason: changes.dropReason,
      repo: changes.repo,
    });
  }

  getTask(id: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
    return row ? toTask(row) : null;
  }

  /** Tasks in one state, or in any state when none is given, oldest first. */
  listTasks(state?: string): Task[] {
    const rows = (
      state === undefined
        ? this.db.query("SELECT * FROM tasks ORDER BY id").all()
        : this.db.query("SELECT * FROM tasks WHERE state = ? ORDER BY id").all(state)
    ) as TaskRow[];
    return rows.map(toTask);
  }

  /** A feature branch's tasks, oldest first. */
  listFeatureTasks(featureId: string): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE feature_id = ? ORDER BY id").all(featureId) as TaskRow[];
    return rows.map(toTask);
  }

  // --- feature branches ---------------------------------------------------------------

  createFeature(actor: Actor, feature: NewFeature): string {
    return this.create(actor, "feature", { name: feature.name, base_branch: feature.baseBranch, base_commit: feature.baseCommit, repo: feature.repo ?? null });
  }

  updateFeature(actor: Actor, id: string, changes: FeatureChanges, detail?: EntryDetail): void {
    // Only what changes: a key with no value would clear its column.
    this.append(actor, "feature", id, "updated", {
      ...detail,
      ...(changes.baseMergedCommit === undefined ? {} : { base_merged_commit: changes.baseMergedCommit }),
      ...(changes.state === undefined ? {} : { state: changes.state }),
      ...(changes.prUrl === undefined ? {} : { pr_url: changes.prUrl }),
      ...(changes.dropReason === undefined ? {} : { drop_reason: changes.dropReason }),
    });
  }

  getFeature(id: string): Feature | null {
    const row = this.db.query("SELECT * FROM features WHERE id = ?").get(id) as FeatureRow | null;
    return row ? toFeature(row) : null;
  }

  findFeature(name: string): Feature | null {
    const row = this.db.query("SELECT * FROM features WHERE name = ?").get(name) as FeatureRow | null;
    return row ? toFeature(row) : null;
  }

  /** Feature branches in one state, or in any state when none is given, oldest first. */
  listFeatures(state?: string): Feature[] {
    const rows = (
      state === undefined
        ? this.db.query("SELECT * FROM features ORDER BY id").all()
        : this.db.query("SELECT * FROM features WHERE state = ? ORDER BY id").all(state)
    ) as FeatureRow[];
    return rows.map(toFeature);
  }

  appendRun(actor: Actor, run: NewRun): string {
    return this.create(actor, "run", {
      task_id: run.taskId ?? null,
      role: run.role,
      started_at: run.startedAt ?? new Date().toISOString(),
      ended_at: run.endedAt ?? null,
      outcome: run.outcome ?? null,
      cost: run.cost ?? null,
      feature_id: run.featureId ?? null,
    }, run.id);
  }

  endRun(actor: Actor, id: string, end: RunEnd = {}): void {
    this.append(actor, "run", id, "updated", {
      ended_at: end.endedAt ?? new Date().toISOString(),
      outcome: end.outcome ?? null,
      ...(end.cost === undefined || end.cost === null ? {} : { cost: end.cost }),
    });
  }

  /** Links a branch review's run to the feature branch it reviewed. */
  setRunFeature(actor: Actor, id: string, featureId: string): void {
    this.append(actor, "run", id, "updated", { feature_id: featureId });
  }

  getRun(id: string): Run | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;
    return row ? toRun(row) : null;
  }

  /** The reviews a run wrote, oldest first. */
  listRunReviews(runId: string): Review[] {
    const rows = this.db.query("SELECT * FROM reviews WHERE run_id = ? ORDER BY id").all(runId) as ReviewRow[];
    return rows.map(toReview);
  }

  /** Runs of a role that have a start and no end, oldest first; only those of `taskId` when given. */
  openRuns(role: Role, taskId?: string): Run[] {
    const rows = (
      taskId === undefined
        ? this.db.query("SELECT * FROM runs WHERE role = ? AND ended_at IS NULL ORDER BY id").all(role)
        : this.db.query("SELECT * FROM runs WHERE role = ? AND ended_at IS NULL AND task_id = ? ORDER BY id").all(role, taskId)
    ) as RunRow[];
    return rows.map(toRun);
  }

  appendCheckRun(actor: Actor, check: NewCheckRun): string {
    return this.create(actor, "check_run", {
      task_id: check.taskId,
      commit_sha: check.commitSha,
      started_at: check.startedAt ?? new Date().toISOString(),
      ended_at: check.endedAt ?? null,
      result: check.result ?? null,
      commands: check.commands ?? [],
    }, check.id);
  }

  endCheckRun(actor: Actor, id: string, end: CheckRunEnd): void {
    this.append(actor, "check_run", id, "updated", {
      ended_at: end.endedAt ?? new Date().toISOString(),
      result: end.result,
      commands: end.commands,
    });
  }

  /** A task's check runs, oldest first. */
  listCheckRuns(taskId: string): CheckRun[] {
    const rows = this.db.query("SELECT * FROM check_runs WHERE task_id = ? ORDER BY id").all(taskId) as CheckRunRow[];
    return rows.map(toCheckRun);
  }

  /** Runs of any role that have a start and no end, oldest first: what is stuck, or still running. */
  unendedRuns(): Run[] {
    return (this.db.query("SELECT * FROM runs WHERE ended_at IS NULL ORDER BY id").all() as RunRow[]).map(toRun);
  }

  /** Check runs that have a start and no end, oldest first. */
  unendedCheckRuns(): CheckRun[] {
    return (this.db.query("SELECT * FROM check_runs WHERE ended_at IS NULL ORDER BY id").all() as CheckRunRow[]).map(toCheckRun);
  }

  /** How many runs ended, and how many of those carry no cost (trustmybot/tmb#257). */
  runCostCounts(): { ended: number; withoutCost: number } {
    const row = this.db.query("SELECT count(*) AS ended, coalesce(sum(cost IS NULL), 0) AS without FROM runs WHERE ended_at IS NOT NULL").get() as { ended: number; without: number };
    return { ended: row.ended, withoutCost: row.without };
  }

  /** When the record's first entry was written; null for an empty record. */
  firstEntryAt(): string | null {
    return (this.db.query("SELECT min(at) AS at FROM events").get() as { at: string | null }).at;
  }

  /** The pull requests tasks and feature branches opened, by their URLs. */
  pullRequestUrls(): string[] {
    const rows = this.db.query("SELECT pr_url FROM tasks WHERE pr_url IS NOT NULL UNION SELECT pr_url FROM features WHERE pr_url IS NOT NULL").all() as { pr_url: string }[];
    return rows.map((row) => row.pr_url);
  }

  /** The tasks any agent run names. */
  tasksWithRuns(): Set<string> {
    const rows = this.db.query("SELECT DISTINCT task_id FROM runs WHERE task_id IS NOT NULL").all() as { task_id: string }[];
    return new Set(rows.map((row) => row.task_id));
  }

  appendReview(actor: Actor, review: NewReview): string {
    return this.create(actor, "review", {
      target_kind: review.target.kind,
      target: review.target.ref,
      verdict: review.verdict,
      findings: review.findings ?? [],
      feature_id: review.featureId ?? null,
      commit_sha: review.commitSha ?? null,
      run_id: review.runId ?? null,
      ...(review.carriedFrom === undefined || review.carriedFrom === null ? {} : { carried_from: review.carriedFrom }),
      ...review.detail,
    }, review.id);
  }

  /** The reviews of one feature branch, oldest first. */
  listFeatureReviews(featureId: string): Review[] {
    const rows = this.db.query("SELECT * FROM reviews WHERE feature_id = ? ORDER BY id").all(featureId) as ReviewRow[];
    return rows.map(toReview);
  }

  /** The reviews of one task's commits (truest mode), oldest first. */
  listTaskReviews(taskId: string): Review[] {
    const rows = this.db.query("SELECT * FROM reviews WHERE target_kind = 'commit' AND target = ? ORDER BY id").all(taskId) as ReviewRow[];
    return rows.map(toReview);
  }

  /** Every review, oldest first. */
  listReviews(): Review[] {
    const rows = this.db.query("SELECT * FROM reviews ORDER BY id").all() as ReviewRow[];
    return rows.map(toReview);
  }

  appendGuardDecision(actor: Actor, guard: NewGuardDecision): string {
    return this.create(actor, "guard_decision", { event: guard.event, decision: guard.decision, reason: guard.reason });
  }

  /** Every guard decision, oldest first. */
  listGuardDecisions(): GuardDecision[] {
    const rows = this.db.query("SELECT * FROM guard_decisions ORDER BY id").all() as GuardDecisionRow[];
    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      decision: row.decision,
      reason: row.reason,
      createdBy: JSON.parse(row.created_by) as Actor,
      createdAt: row.created_at,
    }));
  }

  // --- reads across records -----------------------------------------------------------

  /** Ranked snippets from issue titles and bodies and discussion bodies. */
  search(query: string, limit = 10): SearchHit[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
      throw new RangeError(`search limit must be an integer from 1 to ${SEARCH_LIMIT_MAX}, got ${limit}`);
    }
    const match = toMatchQuery(query);
    if (match === null) return [];
    const rows = this.db
      .query(
        `SELECT search.record_kind AS kind, search.record_id AS id, search.issue_id AS issueId,
                issues.title AS title, issues.state AS state, snippet(search, -1, '', '', '…', 32) AS snippet
           FROM search JOIN issues ON issues.id = search.issue_id
          WHERE search MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as SearchHit[];
    return rows.map((hit) => ({ ...hit, snippet: clip(hit.snippet) }));
  }

  /** Every event of one record, oldest first. */
  history(recordId: string): StoredEvent[] {
    const rows = this.db.query("SELECT * FROM events WHERE record_id = ? ORDER BY id").all(recordId) as EventRow[];
    return rows.map(toEvent);
  }

  /** The kinds of the newest `limit` events, oldest first, as `task updated`; never their content. */
  recentEventKinds(limit: number): string[] {
    const rows = this.db.query("SELECT record_kind, type FROM events ORDER BY id DESC LIMIT ?").all(limit) as { record_kind: string; type: string }[];
    return rows.reverse().map((row) => `${row.record_kind} ${row.type}`);
  }

  /** Empties every projection and the search index, then replays all events into them. */
  rebuildProjections(): void {
    this.db
      .transaction(() => {
        for (const table of PROJECTION_TABLES) this.db.run(`DELETE FROM ${table}`);
        this.db.run("DELETE FROM search");
        for (const row of this.db.query("SELECT * FROM events ORDER BY id").iterate() as IterableIterator<EventRow>) {
          applyEvent(this.db, toEvent(row));
        }
      })
      .immediate();
  }

  /** Runs `work` in one transaction: the reads it makes and the records it writes stand or fall together. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  // --- the one write path -------------------------------------------------------------

  /**
   * Runs `work` with every event it writes stamped at `at` instead of now, for records copied
   * from elsewhere that keep the time they were first made. Event ids still follow the newest
   * stored one, so a rebuild replays them in the order they were written.
   */
  backdated<T>(at: string, work: () => T): T {
    if (Number.isNaN(Date.parse(at))) throw new Error(`not a time: ${JSON.stringify(at)}`);
    const before = this.clock;
    this.clock = () => new Date(at).toISOString();
    try {
      return work();
    } finally {
      this.clock = before;
    }
  }

  private clock: () => string = () => new Date().toISOString();

  private create(actor: Actor, kind: RecordKind, data: Record<string, unknown>, id: string = newId()): string {
    if (!isId(id)) throw new Error(`a ${kind} id must be a record id, got ${JSON.stringify(id)}`);
    this.append(actor, kind, id, "created", data);
    return id;
  }

  /**
   * Appends one event and applies it, in one transaction. The event id is made after the
   * newest stored one, so id order is the order events were applied in, which is the
   * order a rebuild replays them in.
   */
  private append(actor: Actor, recordKind: RecordKind, recordId: string, type: EventType, data: Record<string, unknown>): StoredEvent {
    assertWriter(actor);
    const stored = asStoredData(data);
    assertValues(recordKind, stored);
    return this.db
      .transaction(() => {
        const newest = this.db.query("SELECT max(id) AS id FROM events").get() as { id: string | null };
        const event: StoredEvent = {
          id: newId(newest.id ?? undefined),
          recordKind,
          recordId,
          type,
          data: stored,
          actor,
          at: this.clock(),
        };
        const who = actorColumns(actor);
        this.db
          .query(
            `INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, actor_source, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(event.id, recordKind, recordId, type, JSON.stringify(event.data), who.actor_kind, who.actor_role, who.actor_host, who.actor_source, event.at);
        applyEvent(this.db, { ...event, actor: actorFromColumns(who) });
        return event;
      })
      .immediate();
  }
}
