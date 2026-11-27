// Schema version 13: `audit` goes (trustmybot/tmb#408). Each old entry is written again as an
// event of its new record kind, made by tmb, and folded into its new table; the old events stay
// as they are, and a rebuild skips them. Nothing here reads today's projection code: the columns
// each new event fills are fixed below, so a later change to a table never changes this step.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { newId } from "../ids.ts";

const UPGRADE_ACTOR = JSON.stringify({ kind: "tmb", source: "upgrade" });

type AuditRow = { id: string; what: string; detail: string; created_at: string };
type Tie = { program: string; version: string; command: string[] };

/** What the step could not move, by why; each such entry's old event stays in `events`. */
export type AuditLeftBehind = { unmatchedMarks: number; unmatchedMarkSends: number; uncoveredCarries: number; unknown: number };

/** The record kinds this step writes, with the columns a created event fills, as at version 13. */
const CREATED_COLUMNS = {
  setting_change: { table: "setting_changes", columns: ["key", "repo", "old_value", "new_value", "how"] },
  waiver: { table: "waivers", columns: ["task_id", "feature_id", "carried_from", "commit_sha", "reason"] },
  review: { table: "reviews", columns: ["target_kind", "target", "verdict", "findings", "feature_id", "commit_sha", "run_id", "carried_from"] },
  review_mark: { table: "review_marks", columns: ["task_id", "feature_id", "commit_sha", "kind", "state", "sent_at"] },
  feedback_report: { table: "feedback_reports", columns: ["route", "url", "issue_id"] },
  import: { table: "imports", columns: ["source", "repo", "detail"] },
} as const;
type CreatedKind = keyof typeof CREATED_COLUMNS;

function columnValue(value: unknown): SQLQueryBindings {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return value as SQLQueryBindings;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A setting's value as JSON text: the entry's detail when it is JSON, else that text as a JSON string. */
function jsonText(text: string): string {
  return parsed(text) === null && text.trim() !== "null" ? JSON.stringify(text) : text;
}

function asTie(value: unknown): Tie | null {
  if (!isObject(value) || typeof value.program !== "string" || typeof value.version !== "string" || !Array.isArray(value.command)) return null;
  return { program: value.program, version: value.version, command: value.command.map(String) };
}

/** A mark's kind, read from the text it was sent with. */
function markKind(description: string): "pass" | "fail" | "waiver" {
  if (description.startsWith("Failed")) return "fail";
  if (description.startsWith("Passed: review waived")) return "waiver";
  return "pass";
}

/** Makes the version 13 tables and moves every `audit` entry into them; then `audit` goes. */
export function upgradeAudit(db: Database, sql: string): AuditLeftBehind {
  db.run(sql);
  const left: AuditLeftBehind = { unmatchedMarks: 0, unmatchedMarkSends: 0, uncoveredCarries: 0, unknown: 0 };
  const entries = db.query("SELECT id, what, detail, created_at FROM audit ORDER BY id").all() as AuditRow[];
  let lastEvent = (db.query("SELECT max(id) AS id FROM events").get() as { id: string | null }).id ?? undefined;

  const event = (kind: string, recordId: string, type: "created" | "updated", data: Record<string, unknown>, at: string): void => {
    const id = newId(lastEvent);
    lastEvent = id;
    db.query(
      "INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, actor_source, at) VALUES (?, ?, ?, ?, ?, 'tmb', NULL, NULL, 'upgrade', ?)",
    ).run(id, kind, recordId, type, JSON.stringify(data), at);
  };
  const create = (kind: CreatedKind, data: Record<string, unknown>, at: string): string => {
    const recordId = newId(lastEvent);
    event(kind, recordId, "created", data, at);
    const { table, columns } = CREATED_COLUMNS[kind];
    const row: Record<string, SQLQueryBindings> = { id: recordId, created_by: UPGRADE_ACTOR, created_at: at };
    for (const column of columns) if (column in data) row[column] = columnValue(data[column]);
    const names = Object.keys(row);
    db.query(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => row[name]!));
    return recordId;
  };

  // How each review mode was chosen goes on the setting change it followed, written just before it.
  const chosenHow = new Map<string, { how: string; audit: string }>();
  let unpaired: string | null = null;
  for (const entry of entries) {
    if (entry.what === "setting:review_mode") unpaired = entry.id;
    else if (entry.what === "review_mode_chosen" && unpaired !== null) {
      chosenHow.set(unpaired, { how: entry.detail, audit: entry.id });
      unpaired = null;
    }
  }
  const paired = new Set([...chosenHow.values()].map((chosen) => chosen.audit));

  const settingNow = new Map<string, string>();
  let reposBefore: unknown = null;
  let tie: Tie | null = null;
  let tieText: string | null = null;
  const markIds = new Map<string, string>();

  const programRow = (next: Tie | null, at: string, extra: Record<string, unknown>): void => {
    const nextText = next === null ? null : JSON.stringify(next);
    create("setting_change", { key: "program", repo: null, old_value: tieText, new_value: nextText, how: null, ...extra }, at);
    tie = next;
    tieText = nextText;
  };

  for (const entry of entries) {
    const at = entry.created_at;
    const detail = parsed(entry.detail);
    const from = { audit_id: entry.id };
    if (entry.what.startsWith("setting:")) {
      const key = entry.what.slice("setting:".length);
      const value = jsonText(entry.detail);
      if (key === "repos") reposBefore = settingNow.has("repos") ? parsed(settingNow.get("repos")!) : null;
      const chosen = chosenHow.get(entry.id);
      create(
        "setting_change",
        { key, repo: null, old_value: settingNow.get(key) ?? null, new_value: value, how: chosen?.how ?? null, ...from, ...(chosen ? { chosen_audit_id: chosen.audit } : {}) },
        at,
      );
      settingNow.set(key, value);
    } else if (entry.what === "review_mode_chosen") {
      if (paired.has(entry.id)) continue;
      create("setting_change", { key: "review_mode", repo: null, old_value: null, new_value: null, how: entry.detail, ...from }, at);
    } else if (entry.what === "repo_review_mode_chosen" && isObject(detail) && typeof detail.repo === "string") {
      const before = isObject(reposBefore) && isObject(reposBefore[detail.repo]) ? (reposBefore[detail.repo] as Record<string, unknown>).review_mode : undefined;
      create(
        "setting_change",
        {
          key: "review_mode",
          repo: detail.repo,
          old_value: before === undefined || before === null ? null : JSON.stringify(before),
          new_value: detail.review_mode === undefined || detail.review_mode === null ? null : JSON.stringify(detail.review_mode),
          how: typeof detail.via === "string" ? detail.via : null,
          ...from,
        },
        at,
      );
    } else if (entry.what === "program") {
      programRow(asTie(detail), at, from);
    } else if (entry.what === "tmb-moved" && isObject(detail)) {
      // A move rewires nothing: the tie that wired the project stays in force, and the refresh after it writes the new one.
      programRow(tie, at, { ...from, moved: { program: detail.program, from: detail.from, to: detail.to } });
    } else if (entry.what === "host-refresh" && isObject(detail)) {
      // The refresh wired the project at the version it moved to, with the command of the tie in force.
      const wired = tie !== null && typeof detail.to === "string" ? { ...(tie as Tie), version: detail.to } : tie;
      programRow(wired, at, { ...from, refresh: { program: detail.program, from: detail.from, to: detail.to, hosts: detail.hosts, changed: detail.changed } });
    } else if (entry.what === "waiver" && isObject(detail) && waivable(db, "features", detail)) {
      create("waiver", { task_id: null, feature_id: detail.feature_id, carried_from: null, commit_sha: detail.commit, reason: detail.reason, feature: detail.feature, ...from }, at);
    } else if (entry.what === "task_waiver" && isObject(detail) && waivable(db, "tasks", { ...detail, feature_id: detail.task_id })) {
      create("waiver", { task_id: detail.task_id, feature_id: null, carried_from: null, commit_sha: detail.commit, reason: detail.reason, ...from }, at);
    } else if (entry.what === "review_carry" && isObject(detail)) {
      const carry = { from: detail.from, to: detail.to, onto: detail.onto, ...from };
      const review = db
        .query("SELECT id, verdict, findings FROM reviews WHERE target_kind = 'commit' AND target = ? AND commit_sha = ? ORDER BY id DESC LIMIT 1")
        .get(detail.task_id as string, detail.from as string) as { id: string; verdict: string; findings: string } | null;
      const waiver = db
        .query("SELECT id, reason FROM waivers WHERE task_id = ? AND commit_sha = ? ORDER BY id DESC LIMIT 1")
        .get(detail.task_id as string, detail.from as string) as { id: string; reason: string } | null;
      if (review === null && waiver === null) left.uncoveredCarries++;
      if (review !== null) {
        create(
          "review",
          {
            target_kind: "commit",
            target: detail.task_id,
            verdict: review.verdict,
            findings: JSON.parse(review.findings) as unknown,
            feature_id: null,
            commit_sha: detail.to,
            run_id: null,
            carried_from: review.id,
            ...carry,
          },
          at,
        );
      }
      if (waiver !== null) {
        create("waiver", { task_id: detail.task_id, feature_id: null, carried_from: waiver.id, commit_sha: detail.to, reason: waiver.reason, ...carry }, at);
      }
    } else if (entry.what === "review_mark" && isObject(detail) && typeof detail.commit === "string") {
      const description = String(detail.description ?? "");
      const kind = markKind(description);
      const parent = markParent(db, detail.commit, kind);
      if (parent === null) {
        left.unmatchedMarks++;
        continue;
      }
      const id = create(
        "review_mark",
        {
          task_id: parent.task_id,
          feature_id: parent.feature_id,
          commit_sha: detail.commit,
          kind,
          state: detail.state,
          sent_at: detail.sent === true ? at : null,
          description,
          ...(detail.why === undefined ? {} : { why: detail.why }),
          ...from,
        },
        at,
      );
      markIds.set(entry.id, id);
    } else if (entry.what === "review_mark_sent" && isObject(detail)) {
      const mark = markIds.get(String(detail.mark_id));
      if (mark === undefined) {
        left.unmatchedMarkSends++;
        continue;
      }
      event("review_mark", mark, "updated", { sent_at: at, ...from }, at);
      db.query("UPDATE review_marks SET sent_at = ? WHERE id = ?").run(at, mark);
    } else if (entry.what === "feature_update" && isObject(detail) && typeof detail.feature_id === "string") {
      const feature = db.query("SELECT updated_at FROM features WHERE id = ?").get(detail.feature_id) as { updated_at: string } | null;
      if (feature === null) {
        left.unknown++;
        continue;
      }
      // Never earlier than the branch's last change, so its updated_at does not go back.
      const when = feature.updated_at > at ? feature.updated_at : at;
      event("feature", detail.feature_id, "updated", { base_merged_commit: detail.base, feature: detail.feature, from: detail.from, to: detail.to, how: detail.how, ...from }, when);
      db.query("UPDATE features SET base_merged_commit = ?, updated_at = ? WHERE id = ?").run(columnValue(detail.base), when, detail.feature_id);
    } else if (entry.what === "feedback" && isObject(detail) && typeof detail.route === "string") {
      create("feedback_report", { route: detail.route, url: typeof detail.url === "string" ? detail.url : null, issue_id: null, title: detail.title, opened: detail.opened, ...from }, at);
    } else if (entry.what === "migration.plugin" && isObject(detail)) {
      create("import", { source: "plugin", repo: typeof detail.repo === "string" ? detail.repo : null, detail, ...from }, at);
    } else {
      left.unknown++;
    }
  }
  db.run("DROP TABLE audit");
  return left;
}

/** Whether an old waiver names a commit, a reason and a parent the record holds; one that does not stays an old event only. */
function waivable(db: Database, table: "tasks" | "features", detail: Record<string, unknown>): boolean {
  if (typeof detail.commit !== "string" || typeof detail.reason !== "string" || detail.reason.trim() === "" || typeof detail.feature_id !== "string") return false;
  return db.query(`SELECT 1 FROM ${table} WHERE id = ?`).get(detail.feature_id) !== null;
}

/** The task or feature branch a mark on `commit` was for: the waiver or review on that commit. */
function markParent(db: Database, commit: string, kind: "pass" | "fail" | "waiver"): { task_id: string | null; feature_id: string | null } | null {
  const waiver = db.query("SELECT task_id, feature_id FROM waivers WHERE commit_sha = ? ORDER BY id DESC LIMIT 1").get(commit) as {
    task_id: string | null;
    feature_id: string | null;
  } | null;
  // A task's review names the task as its target; a migrated review may name a commit there instead.
  const review = db
    .query(
      "SELECT r.feature_id, t.id AS task_id FROM reviews r LEFT JOIN tasks t ON r.target_kind = 'commit' AND t.id = r.target WHERE r.commit_sha = ? AND (r.feature_id IS NOT NULL OR t.id IS NOT NULL) ORDER BY r.id DESC LIMIT 1",
    )
    .get(commit) as { feature_id: string | null; task_id: string | null } | null;
  const fromReview = review === null ? null : review.feature_id !== null ? { task_id: null, feature_id: review.feature_id } : { task_id: review.task_id, feature_id: null };
  return kind === "waiver" ? (waiver ?? fromReview) : (fromReview ?? waiver);
}
