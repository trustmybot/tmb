// The record's operations, one function each. Every way into the engine (the tool server,
// the command line) calls these, so a rule here holds whichever way a request came in.
import {
  type Actor,
  type Discussion,
  type Issue,
  type IssueChanges,
  type IssueState,
  type IssueSummary,
  SEARCH_LIMIT_MAX,
  type SearchHit,
  type Store,
  type StoredEvent,
} from "../store/index.ts";
import { HandlerError } from "./errors.ts";
import { type InputSchema, NOT_BLANK, RECORD_ID, validateInput } from "./input.ts";

const ISSUE_STATES = ["open", "closed"] as const;
const DISCUSSION_KINDS = ["note", "decision"] as const;

function requireIssue(store: Store, id: string): Issue {
  const issue = store.getIssue(id);
  if (!issue) throw new HandlerError("not_found", `no issue ${id} in the record`);
  return issue;
}

/** A blank milestone means none. */
function milestoneOf(text: string | undefined): string | null {
  return text === undefined || text.trim() === "" ? null : text;
}

// --- issue_create -------------------------------------------------------------------------

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

export function issueCreate(store: Store, actor: Actor, input: unknown): Issue {
  const { title, body, milestone } = validateInput<{ title: string; body?: string; milestone?: string }>(
    "issue_create",
    issueCreateSchema,
    input,
  );
  const id = store.createIssue(actor, { title, body: body ?? "", milestone: milestoneOf(milestone) });
  return requireIssue(store, id);
}

// --- issue_list ---------------------------------------------------------------------------

export const issueListSchema: InputSchema = {
  type: "object",
  properties: { state: { type: "string", description: "Only issues in this state; all issues when left out.", enum: ISSUE_STATES } },
  required: [],
  additionalProperties: false,
};

export function issueList(store: Store, _actor: Actor, input: unknown): IssueSummary[] {
  const { state } = validateInput<{ state?: IssueState }>("issue_list", issueListSchema, input);
  return store.listIssues(state === undefined ? {} : { state });
}

// --- issue_get ----------------------------------------------------------------------------

export const issueGetSchema: InputSchema = {
  type: "object",
  properties: { id: { type: "string", description: "The issue's id.", pattern: RECORD_ID } },
  required: ["id"],
  additionalProperties: false,
};

export type IssueDetail = { issue: Issue; discussions: Discussion[]; newestDecision: Discussion | null };

export function issueGet(store: Store, _actor: Actor, input: unknown): IssueDetail {
  const { id } = validateInput<{ id: string }>("issue_get", issueGetSchema, input);
  const issue = requireIssue(store, id);
  return { issue, discussions: store.listDiscussions(id), newestDecision: store.newestDecision(id) };
}

// --- issue_update -------------------------------------------------------------------------

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

const UPDATABLE = ["state", "title", "body", "milestone"] as const;

export type IssueUpdateResult = { issue: Issue; changed: (keyof IssueChanges)[] };

/** Records only the fields that differ; a request that changes nothing records nothing. */
export function issueUpdate(store: Store, actor: Actor, input: unknown): IssueUpdateResult {
  const request = validateInput<{ id: string } & Omit<IssueChanges, "milestone"> & { milestone?: string }>(
    "issue_update",
    issueUpdateSchema,
    input,
  );
  if (!UPDATABLE.some((field) => request[field] !== undefined)) {
    throw new HandlerError("invalid_input", `issue_update needs at least one of ${UPDATABLE.join(", ")}`);
  }
  const current = requireIssue(store, request.id);
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
  store.updateIssue(actor, request.id, changes);
  return { issue: requireIssue(store, request.id), changed };
}

// --- discussion_append --------------------------------------------------------------------

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

export function discussionAppend(store: Store, actor: Actor, input: unknown): Discussion {
  const { issue_id: issueId, body, kind } = validateInput<{ issue_id: string; body: string; kind: Discussion["kind"] }>(
    "discussion_append",
    discussionAppendSchema,
    input,
  );
  requireIssue(store, issueId);
  const id = store.appendDiscussion(actor, { issueId, kind, body });
  return store.listDiscussions(issueId).find((discussion) => discussion.id === id)!;
}

// --- search -------------------------------------------------------------------------------

export const searchSchema: InputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "The words to look for; every word must match.", pattern: NOT_BLANK },
    limit: { type: "integer", description: "At most this many hits; 10 when left out.", minimum: 1, maximum: SEARCH_LIMIT_MAX },
  },
  required: ["query"],
  additionalProperties: false,
};

export function search(store: Store, _actor: Actor, input: unknown): SearchHit[] {
  const { query, limit } = validateInput<{ query: string; limit?: number }>("search", searchSchema, input);
  return store.search(query, limit);
}

// --- history ------------------------------------------------------------------------------

export const historySchema: InputSchema = {
  type: "object",
  properties: { id: { type: "string", description: "The id of an issue or a discussion entry.", pattern: RECORD_ID } },
  required: ["id"],
  additionalProperties: false,
};

export function history(store: Store, _actor: Actor, input: unknown): StoredEvent[] {
  const { id } = validateInput<{ id: string }>("history", historySchema, input);
  const events = store.history(id);
  if (events.length === 0) throw new HandlerError("not_found", `no record ${id}`);
  return events;
}
