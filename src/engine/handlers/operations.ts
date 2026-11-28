// The record's issue operations: issues, their notes and decisions, search and history. Every
// way into the engine (the tool server, the command line) calls these, so a rule here holds
// whichever way a request came in.
import {
  type Actor,
  type Discussion,
  type Issue,
  type IssueChanges,
  type IssueState,
  type IssueSummary,
  type MirroredRow,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type SearchHit,
  type Store,
  type StoredEvent,
} from "../store/index.ts";
import type { OperationContext, RemoteIssueEdit, RemoteIssueWriter } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { type InputSchema, NOT_BLANK, RECORD_ID, validateInput } from "./input.ts";

const ISSUE_STATES = ["open", "closed"] as const;
const DISCUSSION_KINDS = ["note", "decision"] as const;
const UPDATABLE = ["state", "title", "body", "milestone"] as const;

/** A blank milestone means none. */
function milestoneOf(text: string | undefined): string | null {
  return text === undefined || text.trim() === "" ? null : text;
}

export const issueCreateSchema: InputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short title for the issue.", pattern: NOT_BLANK },
    body: { type: "string", description: "What the issue is about: the goal and any context." },
    milestone: { type: "string", description: "The milestone it belongs to, if any." },
  },
  required: ["title"],
  additionalProperties: false,
};

export const issueListSchema: InputSchema = {
  type: "object",
  properties: { state: { type: "string", description: "Only issues in this state; all issues when left out.", enum: ISSUE_STATES } },
  required: [],
  additionalProperties: false,
};

export const issueGetSchema: InputSchema = {
  type: "object",
  properties: { id: { type: "string", description: "The issue's id.", pattern: RECORD_ID } },
  required: ["id"],
  additionalProperties: false,
};

export const issueUpdateSchema: InputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The issue's id.", pattern: RECORD_ID },
    state: { type: "string", description: "open, or closed when its work is done or dropped.", enum: ISSUE_STATES },
    title: { type: "string", description: "A new title.", pattern: NOT_BLANK },
    body: { type: "string", description: "A new body, replacing the old one." },
    milestone: { type: "string", description: "A new milestone; an empty string clears it." },
  },
  required: ["id"],
  additionalProperties: false,
};

export const discussionAppendSchema: InputSchema = {
  type: "object",
  properties: {
    issue_id: { type: "string", description: "The id of the issue it is about.", pattern: RECORD_ID },
    body: { type: "string", description: "The note or the decision, in full.", pattern: NOT_BLANK },
    kind: { type: "string", description: "note, or decision for what was settled.", enum: DISCUSSION_KINDS },
  },
  required: ["issue_id", "body", "kind"],
  additionalProperties: false,
};

export const searchSchema: InputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "The words to look for; every word must match.", pattern: NOT_BLANK },
    limit: { type: "integer", description: `At most this many hits; ${SEARCH_LIMIT_DEFAULT} when left out.`, minimum: 1, maximum: SEARCH_LIMIT_MAX },
  },
  required: ["query"],
  additionalProperties: false,
};

export const historySchema: InputSchema = {
  type: "object",
  properties: { id: { type: "string", description: "The id of an issue or a discussion entry.", pattern: RECORD_ID } },
  required: ["id"],
  additionalProperties: false,
};

export type IssueDetail = { issue: Issue; discussions: Discussion[]; newestDecision: Discussion | null };
export type IssueUpdateResult = { issue: Issue; changed: (keyof IssueChanges)[] };

/** Issues, their notes and decisions, and the reads across them, for one caller. */
export class IssueService {
  constructor(
    private readonly store: Store,
    private readonly actor: Actor,
    /** Writes a change to a mirrored issue on its remote; without it, a mirrored issue is not changed. */
    private readonly remoteIssues?: RemoteIssueWriter,
  ) {}

  create(input: unknown): Issue {
    const { title, body, milestone } = validateInput<{ title: string; body?: string; milestone?: string }>("issue_create", issueCreateSchema, input);
    const id = this.store.createIssue(this.actor, { title, body: body ?? "", milestone: milestoneOf(milestone) });
    return this.requireIssue(id);
  }

  list(input: unknown): IssueSummary[] {
    const { state } = validateInput<{ state?: IssueState }>("issue_list", issueListSchema, input);
    return this.store.listIssues(state === undefined ? {} : { state });
  }

  get(input: unknown): IssueDetail {
    const { id } = validateInput<{ id: string }>("issue_get", issueGetSchema, input);
    const issue = this.requireIssue(id);
    return { issue, discussions: this.store.listDiscussions(id), newestDecision: this.store.newestDecision(id) };
  }

  /**
   * Records only the fields that differ; a request that changes nothing records nothing. A change
   * to a mirrored issue is written to its remote first and recorded only once the remote took it.
   */
  async update(input: unknown): Promise<IssueUpdateResult> {
    const request = validateInput<{ id: string } & Omit<IssueChanges, "milestone"> & { milestone?: string }>("issue_update", issueUpdateSchema, input);
    if (!UPDATABLE.some((field) => request[field] !== undefined)) {
      throw new HandlerError("invalid_input", `issue_update needs at least one of ${UPDATABLE.join(", ")}`);
    }
    const current = this.requireIssue(request.id);
    const wanted: IssueChanges = {
      state: request.state,
      title: request.title,
      body: request.body,
      milestone: request.milestone === undefined ? undefined : milestoneOf(request.milestone),
    };
    const changes: IssueChanges = {};
    for (const field of UPDATABLE) {
      if (wanted[field] !== undefined && wanted[field] !== current[field]) Object.assign(changes, { [field]: wanted[field] });
    }
    const changed = Object.keys(changes) as (keyof IssueChanges)[];
    if (changed.length === 0) return { issue: current, changed };
    const row = this.store.mirror.rowOf("issue", request.id);
    if (row !== null && row.remote_id !== null) await this.updateMirrored(row, changes);
    else this.store.updateIssue(this.actor, request.id, changes);
    return { issue: this.requireIssue(request.id), changed };
  }

  /**
   * The remote is the truth for a mirrored issue: the change goes to the remote first, and the
   * record then takes what the remote holds after it, so the next poll finds nothing new. A change
   * the remote did not take is refused and leaves the record as it was.
   */
  private async updateMirrored(row: MirroredRow, changes: IssueChanges): Promise<void> {
    const id = row.id;
    const remote = String(row.remote);
    const url = String(row.remote_url ?? "");
    const refuse = (why: string): never => {
      throw new HandlerError("refused", `issue ${id} is mirrored from ${remote} and was not changed: ${why}. The record is unchanged.`);
    };
    if (row.remote_gone_at !== null) refuse("it is gone from the remote, deleted or out of reach");
    if (this.remoteIssues === undefined) refuse("this way into tmb cannot reach the remote; change it from the dashboard or the planner's chat");
    const edit: RemoteIssueEdit = { title: changes.title, body: changes.body, state: changes.state };
    if (changes.milestone === null) edit.milestone = null;
    else if (changes.milestone !== undefined) {
      const milestone = this.store.mirror.milestoneTitled(remote, changes.milestone);
      if (milestone === null) refuse(`the remote has no milestone named ${JSON.stringify(changes.milestone)} that the record knows of; make it on the remote first, or pick one it has`);
      edit.milestone = { remoteId: String(milestone!.remote_id) };
    }
    const answer = await this.remoteIssues!({ remote, url }, edit);
    if (!answer.ok) return refuse(answer.why);
    const held = answer.issue;
    const after: Record<string, unknown> = {};
    if (changes.title !== undefined) after.title = held.title;
    if (changes.body !== undefined) after.body = held.body;
    if (changes.state !== undefined) Object.assign(after, { state: held.state, state_reason: held.stateReason });
    if (changes.milestone !== undefined) {
      after.milestone_id = held.milestoneRemoteId === null ? null : (this.store.mirror.findMirrored("milestone", held.milestoneRemoteId)?.id ?? null);
    }
    // Read again after the wait: a poll may have brought the same change in meanwhile.
    const now = this.store.mirror.rowOf("issue", id) ?? row;
    const data = Object.fromEntries(Object.entries(after).filter(([column, value]) => (now[column] ?? null) !== value));
    if (Object.keys(data).length === 0) return;
    this.store.mirror.updateMirrored(this.actor, "issue", id, { ...data, remote_updated_at: held.remoteUpdatedAt });
  }

  appendDiscussion(input: unknown): Discussion {
    const { issue_id: issueId, body, kind } = validateInput<{ issue_id: string; body: string; kind: (typeof DISCUSSION_KINDS)[number] }>("discussion_append", discussionAppendSchema, input);
    this.requireIssue(issueId);
    const id = this.store.appendDiscussion(this.actor, { issueId, kind, body });
    return this.store.listDiscussions(issueId).find((discussion) => discussion.id === id)!;
  }

  search(input: unknown): SearchHit[] {
    const { query, limit } = validateInput<{ query: string; limit?: number }>("search", searchSchema, input);
    return this.store.search(query, limit);
  }

  history(input: unknown): StoredEvent[] {
    const { id } = validateInput<{ id: string }>("history", historySchema, input);
    const events = this.store.history(id);
    if (events.length === 0) throw new HandlerError("not_found", `no record ${id}`);
    return events;
  }

  private requireIssue(id: string): Issue {
    const issue = this.store.getIssue(id);
    if (!issue) throw new HandlerError("not_found", `no issue ${id} in the record`);
    return issue;
  }
}

// The operations as the operation table and the command line call them.
export const issueCreate = (store: Store, actor: Actor, input: unknown): Issue => new IssueService(store, actor).create(input);
export const issueList = (store: Store, actor: Actor, input: unknown): IssueSummary[] => new IssueService(store, actor).list(input);
export const issueGet = (store: Store, actor: Actor, input: unknown): IssueDetail => new IssueService(store, actor).get(input);
export const issueUpdate = (store: Store, actor: Actor, input: unknown, context?: OperationContext): Promise<IssueUpdateResult> =>
  new IssueService(store, actor, context?.remoteIssues).update(input);
export const discussionAppend = (store: Store, actor: Actor, input: unknown): Discussion => new IssueService(store, actor).appendDiscussion(input);
export const search = (store: Store, actor: Actor, input: unknown): SearchHit[] => new IssueService(store, actor).search(input);
export const history = (store: Store, actor: Actor, input: unknown): StoredEvent[] => new IssueService(store, actor).history(input);
