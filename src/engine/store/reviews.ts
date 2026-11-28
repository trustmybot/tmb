// Reviews and what stands beside them: the Human's waivers, and the marks tmb set on commits.
import type { Actor } from "./actor.ts";
import { type EntryDetail, type EventLog, actorOf } from "./event-log.ts";

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

function toWaiver(row: WaiverRow): WaiverEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    featureId: row.feature_id,
    carriedFrom: row.carried_from,
    commitSha: row.commit_sha,
    reason: row.reason,
    createdBy: actorOf(row.created_by),
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
    createdBy: actorOf(row.created_by),
    createdAt: row.created_at,
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
    createdBy: actorOf(row.created_by),
    createdAt: row.created_at,
  };
}

export class ReviewRepository {
  constructor(private readonly log: EventLog) {}

  appendReview(actor: Actor, review: NewReview): string {
    return this.log.create(actor, "review", {
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

  /** The reviews a run wrote, oldest first. */
  listRunReviews(runId: string): Review[] {
    const rows = this.log.db.query("SELECT * FROM reviews WHERE run_id = ? ORDER BY id").all(runId) as ReviewRow[];
    return rows.map(toReview);
  }

  /** The reviews of one feature branch, oldest first. */
  listFeatureReviews(featureId: string): Review[] {
    const rows = this.log.db.query("SELECT * FROM reviews WHERE feature_id = ? ORDER BY id").all(featureId) as ReviewRow[];
    return rows.map(toReview);
  }

  /** The reviews of one task's commits (truest mode), oldest first. */
  listTaskReviews(taskId: string): Review[] {
    const rows = this.log.db.query("SELECT * FROM reviews WHERE target_kind = 'commit' AND target = ? ORDER BY id").all(taskId) as ReviewRow[];
    return rows.map(toReview);
  }

  /** Every review, oldest first. */
  listReviews(): Review[] {
    const rows = this.log.db.query("SELECT * FROM reviews ORDER BY id").all() as ReviewRow[];
    return rows.map(toReview);
  }

  recordWaiver(actor: Actor, waiver: NewWaiver): string {
    return this.log.create(actor, "waiver", {
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
    return (this.log.db.query("SELECT * FROM waivers ORDER BY id").all() as WaiverRow[]).map(toWaiver);
  }

  getWaiver(id: string): WaiverEntry | null {
    const row = this.log.db.query("SELECT * FROM waivers WHERE id = ?").get(id) as WaiverRow | null;
    return row ? toWaiver(row) : null;
  }

  recordReviewMark(actor: Actor, mark: NewReviewMark): string {
    return this.log.create(actor, "review_mark", {
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
    this.log.update(actor, "review_mark", id, { sent_at: at });
  }

  /** Every review mark, oldest first, with the text it was set with. */
  listReviewMarks(): ReviewMark[] {
    const rows = this.log.db
      .query("SELECT m.*, e.data AS data FROM review_marks m JOIN events e ON e.record_id = m.id AND e.type = 'created' ORDER BY m.id")
      .all() as ReviewMarkRow[];
    return rows.map(toReviewMark);
  }
}
