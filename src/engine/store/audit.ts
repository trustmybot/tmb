// What the audit trail held, each in its own table (trustmybot/tmb#408): setting changes,
// freezes, feedback reports, imports and guard decisions.
import type { Actor } from "./actor.ts";
import { type EntryDetail, type EventLog, actorOf } from "./event-log.ts";

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
export type NewGuardDecision = { event: string; decision: "allow" | "deny"; reason: string };
export type GuardDecision = NewGuardDecision & { id: string; createdBy: Actor; createdAt: string };

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
type GuardDecisionRow = { id: string; event: string; decision: "allow" | "deny"; reason: string; created_by: string; created_at: string };

function toSettingChange(row: SettingChangeRow): SettingChange {
  return {
    id: row.id,
    key: row.key,
    repo: row.repo,
    oldValue: row.old_value,
    newValue: row.new_value,
    how: row.how,
    createdBy: actorOf(row.created_by),
    createdAt: row.created_at,
  };
}

/** Every change to the project's and its repos' settings. */
export class SettingChangeRepository {
  constructor(private readonly log: EventLog) {}

  recordSettingChange(actor: Actor, change: NewSettingChange): string {
    return this.log.create(actor, "setting_change", {
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
        ? this.log.db.query(`SELECT * FROM setting_changes WHERE key = ? AND repo IS NULL${value} ORDER BY id DESC LIMIT 1`).get(key)
        : this.log.db.query(`SELECT * FROM setting_changes WHERE key = ? AND repo = ?${value} ORDER BY id DESC LIMIT 1`).get(key, repo)
    ) as SettingChangeRow | null;
    return row ? toSettingChange(row) : null;
  }

  /** Every setting change, oldest first; only those of `key` when given. */
  listSettingChanges(key?: string): SettingChange[] {
    const rows = (
      key === undefined
        ? this.log.db.query("SELECT * FROM setting_changes ORDER BY id").all()
        : this.log.db.query("SELECT * FROM setting_changes WHERE key = ? ORDER BY id").all(key)
    ) as SettingChangeRow[];
    return rows.map(toSettingChange);
  }
}

/** Freezes, feedback reports, imports and guard decisions: entries kept for the trail. */
export class AuditRepository {
  constructor(private readonly log: EventLog) {}

  /** A freeze of agent work, with why; a session may name it (trustmybot/tmb#408). */
  recordFreeze(actor: Actor, freeze: { reason: string; sessionId?: string | null }): string {
    return this.log.create(actor, "freeze", { reason: freeze.reason, session_id: freeze.sessionId ?? null });
  }

  /** Lifts a freeze: who lifted it and when. */
  liftFreeze(actor: Actor, id: string, at: string): void {
    this.log.update(actor, "freeze", id, { lifted_by: actor, lifted_at: at });
  }

  recordFeedbackReport(actor: Actor, report: NewFeedbackReport): string {
    return this.log.create(actor, "feedback_report", { ...report.detail, route: report.route, url: report.url ?? null, issue_id: report.issueId ?? null });
  }

  /** Every feedback report filed or opened, oldest first. */
  listFeedbackReports(): FeedbackReport[] {
    const rows = this.log.db.query("SELECT * FROM feedback_reports ORDER BY id").all() as FeedbackReportRow[];
    return rows.map((row) => ({
      id: row.id,
      route: row.route,
      url: row.url,
      issueId: row.issue_id,
      createdBy: actorOf(row.created_by),
      createdAt: row.created_at,
    }));
  }

  recordImport(actor: Actor, entry: NewImport): string {
    return this.log.create(actor, "import", { source: entry.source, repo: entry.repo ?? null, detail: entry.detail });
  }

  /** Every import from `source`, oldest first. */
  listImports(source: string): ImportEntry[] {
    const rows = this.log.db.query("SELECT * FROM imports WHERE source = ? ORDER BY id").all(source) as ImportRow[];
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      repo: row.repo,
      detail: JSON.parse(row.detail) as unknown,
      createdBy: actorOf(row.created_by),
      createdAt: row.created_at,
    }));
  }

  appendGuardDecision(actor: Actor, guard: NewGuardDecision): string {
    return this.log.create(actor, "guard_decision", { event: guard.event, decision: guard.decision, reason: guard.reason });
  }

  /** Every guard decision, oldest first. */
  listGuardDecisions(): GuardDecision[] {
    const rows = this.log.db.query("SELECT * FROM guard_decisions ORDER BY id").all() as GuardDecisionRow[];
    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      decision: row.decision,
      reason: row.reason,
      createdBy: actorOf(row.created_by),
      createdAt: row.created_at,
    }));
  }
}
