// Issues, their discussions, and the word search over both.
import type { Actor } from "./actor.ts";
import { type EventLog, actorOf } from "./event-log.ts";
import { ValueError } from "./values.ts";

export const SNIPPET_MAX = 200;
export const SEARCH_LIMIT_MAX = 50;
/** How many hits a search returns when it names no limit. */
export const SEARCH_LIMIT_DEFAULT = 10;

export type IssueState = "open" | "closed";
/** A note and a decision are local; a comment is mirrored from the remote. */
export type DiscussionKind = "note" | "decision" | "comment";

export type Issue = {
  id: string;
  title: string;
  body: string;
  state: IssueState;
  milestone: string | null;
  /** The remote's labels on a mirrored issue; empty for a local one. */
  labels: string[];
  /** Where the issue lives on the remote; null while it is local. */
  remoteUrl: string | null;
  /** When the syncer found the issue deleted or out of reach on the remote. */
  remoteGoneAt: string | null;
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
  /** The remote account that wrote a mirrored comment. */
  remoteAuthor: string | null;
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
export type NewDiscussion = { id?: string; issueId: string; kind: Exclude<DiscussionKind, "comment">; body: string };

type IssueRow = {
  id: string;
  title: string;
  body: string;
  state: IssueState;
  milestone: string | null;
  labels: string;
  remote_url: string | null;
  remote_gone_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type DiscussionRow = { id: string; issue_id: string; kind: DiscussionKind; body: string; remote_author: string | null; created_by: string; created_at: string };

/** An issue's milestone by name: a mirrored milestone's title, else the name the issue was given. */
const ISSUE_COLUMNS = "issues.id, issues.title, issues.body, issues.state, COALESCE(milestones.title, issues.milestone) AS milestone, issues.labels, issues.remote_url, issues.remote_gone_at, issues.created_by, issues.created_at, issues.updated_at";
const SUMMARY_COLUMNS = "issues.id, issues.title, issues.state, COALESCE(milestones.title, issues.milestone) AS milestone, issues.body";
const ISSUES_FROM = "issues LEFT JOIN milestones ON milestones.id = issues.milestone_id";

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

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    state: row.state,
    milestone: row.milestone,
    labels: JSON.parse(row.labels) as string[],
    remoteUrl: row.remote_url,
    remoteGoneAt: row.remote_gone_at,
    createdBy: actorOf(row.created_by),
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
    remoteAuthor: row.remote_author,
    createdBy: actorOf(row.created_by),
    createdAt: row.created_at,
  };
}

export class IssueRepository {
  constructor(private readonly log: EventLog) {}

  createIssue(actor: Actor, issue: NewIssue): string {
    return this.log.create(actor, "issue", { title: issue.title, body: issue.body ?? "", milestone: issue.milestone ?? null }, issue.id);
  }

  updateIssue(actor: Actor, id: string, changes: IssueChanges): void {
    this.log.update(actor, "issue", id, { ...changes });
  }

  getIssue(id: string): Issue | null {
    const row = this.log.db.query(`SELECT ${ISSUE_COLUMNS} FROM ${ISSUES_FROM} WHERE issues.id = ?`).get(id) as IssueRow | null;
    return row ? toIssue(row) : null;
  }

  listIssues(filter: { state?: IssueState } = {}): IssueSummary[] {
    const rows = (
      filter.state === undefined
        ? this.log.db.query(`SELECT ${SUMMARY_COLUMNS} FROM ${ISSUES_FROM} ORDER BY issues.id`).all()
        : this.log.db.query(`SELECT ${SUMMARY_COLUMNS} FROM ${ISSUES_FROM} WHERE issues.state = ? ORDER BY issues.id`).all(filter.state)
    ) as Pick<IssueRow, "id" | "title" | "state" | "milestone" | "body">[];
    return rows.map(({ body, ...summary }) => ({ ...summary, snippet: clip(body) }));
  }

  /** A note or a decision; a comment comes only from the remote, through the syncer. */
  appendDiscussion(actor: Actor, discussion: NewDiscussion): string {
    if (discussion.kind !== "note" && discussion.kind !== "decision") throw new ValueError(`a discussion appended in the record is a note or a decision, got ${JSON.stringify(discussion.kind)}`);
    return this.log.create(actor, "discussion", { issue_id: discussion.issueId, kind: discussion.kind, body: discussion.body }, discussion.id);
  }

  /** The issue's discussion, oldest first. */
  listDiscussions(issueId: string): Discussion[] {
    const rows = this.log.db.query("SELECT * FROM discussions WHERE issue_id = ? ORDER BY id").all(issueId) as DiscussionRow[];
    return rows.map(toDiscussion);
  }

  /** The decision in force on an issue: its newest one. */
  newestDecision(issueId: string): Discussion | null {
    const row = this.log.db
      .query("SELECT * FROM discussions WHERE issue_id = ? AND kind = 'decision' ORDER BY id DESC LIMIT 1")
      .get(issueId) as DiscussionRow | null;
    return row ? toDiscussion(row) : null;
  }

  /** Ranked snippets from issue titles and bodies and discussion bodies. */
  search(query: string, limit = SEARCH_LIMIT_DEFAULT): SearchHit[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
      throw new RangeError(`search limit must be an integer from 1 to ${SEARCH_LIMIT_MAX}, got ${limit}`);
    }
    const match = toMatchQuery(query);
    if (match === null) return [];
    const rows = this.log.db
      .query(
        `SELECT search.record_kind AS kind, search.record_id AS id, search.issue_id AS issueId,
                issues.title AS title, issues.state AS state, snippet(search, -1, '', '', '…', 32) AS snippet
           FROM search JOIN issues ON issues.id = search.issue_id
          WHERE search MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as SearchHit[];
    return rows.map((hit) => ({ ...hit, snippet: clip(hit.snippet) }));
  }
}
