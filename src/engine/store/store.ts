// The record store: every write appends one event and applies it to the projections in
// the same transaction; reads come from the projections and return small pieces.
import type { Database } from "bun:sqlite";
import { newId } from "../ids.ts";
import { type Actor, type ActorColumns, type Role, actorColumns, actorFromColumns, assertActor } from "./actor.ts";
import { type EventType, type RecordKind, type StoredEvent, applyEvent } from "./projections.ts";
import { PROJECTION_TABLES } from "./schema.ts";

export const SNIPPET_MAX = 200;
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

export type NewIssue = { title: string; body?: string; milestone?: string | null };
export type IssueChanges = { title?: string; body?: string; state?: IssueState; milestone?: string | null };
export type NewDiscussion = { issueId: string; kind: DiscussionKind; body: string };
export type NewAuditEntry = { what: string; detail?: string };
export type NewTask = {
  issueId: string;
  title: string;
  spec?: string;
  state?: string;
  branch?: string | null;
  commitSha?: string | null;
};
export type NewRun = {
  taskId?: string | null;
  role: Role;
  startedAt?: string;
  endedAt?: string | null;
  outcome?: string | null;
  cost?: Record<string, unknown> | null;
};
export type NewCheckRun = {
  taskId: string;
  commitSha: string;
  startedAt?: string;
  endedAt?: string | null;
  result?: string | null;
};
export type NewReview = { target: { kind: "commit" | "branch"; ref: string }; verdict: string; findings?: unknown[] };
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

  // --- issues -------------------------------------------------------------------------

  createIssue(actor: Actor, issue: NewIssue): string {
    const id = newId();
    this.append(actor, "issue", id, "created", { title: issue.title, body: issue.body ?? "", milestone: issue.milestone ?? null });
    return id;
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
    const id = newId();
    this.append(actor, "discussion", id, "created", { issue_id: discussion.issueId, kind: discussion.kind, body: discussion.body });
    return id;
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

  recordAudit(actor: Actor, entry: NewAuditEntry): string {
    return this.create(actor, "audit", { what: entry.what, detail: entry.detail ?? "" });
  }

  appendTask(actor: Actor, task: NewTask): string {
    return this.create(actor, "task", {
      issue_id: task.issueId,
      title: task.title,
      spec: task.spec ?? "",
      state: task.state ?? "pending",
      branch: task.branch ?? null,
      commit_sha: task.commitSha ?? null,
    });
  }

  appendRun(actor: Actor, run: NewRun): string {
    return this.create(actor, "run", {
      task_id: run.taskId ?? null,
      role: run.role,
      started_at: run.startedAt ?? new Date().toISOString(),
      ended_at: run.endedAt ?? null,
      outcome: run.outcome ?? null,
      cost: run.cost ?? null,
    });
  }

  appendCheckRun(actor: Actor, check: NewCheckRun): string {
    return this.create(actor, "check_run", {
      task_id: check.taskId,
      commit_sha: check.commitSha,
      started_at: check.startedAt ?? new Date().toISOString(),
      ended_at: check.endedAt ?? null,
      result: check.result ?? null,
    });
  }

  appendReview(actor: Actor, review: NewReview): string {
    return this.create(actor, "review", {
      target_kind: review.target.kind,
      target: review.target.ref,
      verdict: review.verdict,
      findings: review.findings ?? [],
    });
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

  // --- the one write path -------------------------------------------------------------

  private create(actor: Actor, kind: RecordKind, data: Record<string, unknown>): string {
    const id = newId();
    this.append(actor, kind, id, "created", data);
    return id;
  }

  /**
   * Appends one event and applies it, in one transaction. The event id is made after the
   * newest stored one, so id order is the order events were applied in, which is the
   * order a rebuild replays them in.
   */
  private append(actor: Actor, recordKind: RecordKind, recordId: string, type: EventType, data: Record<string, unknown>): StoredEvent {
    assertActor(actor);
    return this.db
      .transaction(() => {
        const newest = this.db.query("SELECT max(id) AS id FROM events").get() as { id: string | null };
        const event: StoredEvent = {
          id: newId(newest.id ?? undefined),
          recordKind,
          recordId,
          type,
          data: asStoredData(data),
          actor,
          at: new Date().toISOString(),
        };
        const who = actorColumns(actor);
        this.db
          .query(
            `INSERT INTO events (id, record_kind, record_id, type, data, actor_kind, actor_role, actor_host, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(event.id, recordKind, recordId, type, JSON.stringify(event.data), who.actor_kind, who.actor_role, who.actor_host, event.at);
        applyEvent(this.db, { ...event, actor: actorFromColumns(who) });
        return event;
      })
      .immediate();
  }
}
