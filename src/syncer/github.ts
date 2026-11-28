// GitHub's answers turned into the reader's plain values. Everything GitHub-shaped stays in this
// file and in the paths below; nothing past it names the vendor.
import type { ListName, RemoteComment, RemoteIssue, RemoteItem, RemoteMilestone, RemotePullRequest } from "./types.ts";

type Json = Record<string, any>;

export type Repo = { host: string; owner: string; name: string };

/**
 * The one string that names a remote repository, and the value the record's `remote` column
 * holds: host, owner and name as origin gives them, joined by slashes. A rename on the remote
 * changes this address and never an item's `remoteId`.
 */
export const remoteName = (repo: Repo): string => `${repo.host}/${repo.owner}/${repo.name}`;

/** GitHub itself, or a host of its cloud. Any other host is GitHub only if it answers like it. */
export const isGithubHost = (host: string): boolean => /^(.+\.)?github\.com$|\.ghe\.com$/i.test(host);

const PAGE = 100;

/**
 * Each list's first page, newest change first where the remote can sort so. Its address never
 * changes, so the tag kept for it asks "has anything changed?". `openOnly` asks for the open
 * issues alone, as an import does when the Human chose only the open ones.
 */
export function firstPage(repo: Repo, list: ListName, openOnly = false): string {
  const root = `repos/${repo.owner}/${repo.name}`;
  switch (list) {
    case "issues":
      return `${root}/issues?state=${openOnly ? "open" : "all"}&sort=updated&direction=desc&per_page=${PAGE}`;
    case "comments":
      return `${root}/issues/comments?sort=updated&direction=desc&per_page=${PAGE}`;
    case "review_comments":
      return `${root}/pulls/comments?sort=updated&direction=desc&per_page=${PAGE}`;
    case "pull_requests":
      return `${root}/pulls?state=all&sort=updated&direction=desc&per_page=${PAGE}`;
    case "milestones":
      return `${root}/milestones?state=all&per_page=${PAGE}`;
  }
}

/** A later page of a list, by its number. */
export const laterPage = (repo: Repo, list: ListName, page: number): string => `${firstPage(repo, list)}&page=${page}`;

/** The lists that take "updated since", oldest change first, so a long read can resume. */
export function sincePage(repo: Repo, list: ListName, since: string | null, openOnly = false): string | null {
  if (list !== "issues" && list !== "comments" && list !== "review_comments") return null;
  const asked = firstPage(repo, list, openOnly).replace("direction=desc", "direction=asc");
  return since === null ? asked : `${asked}&since=${encodeURIComponent(since)}`;
}

/** Whether the list comes newest change first, so a read can stop at the kept time. */
export const newestFirst = (list: ListName): boolean => list !== "milestones";

export type ItemKind = "issue" | "pull_request" | "milestone" | "comment" | "review_comment";

/** One item's own address: by its number, or for a comment by the number the remote gave it. */
export function itemPath(repo: Repo, kind: ItemKind, number: number): string {
  const root = `repos/${repo.owner}/${repo.name}`;
  const under = { issue: "issues", pull_request: "pulls", milestone: "milestones", comment: "issues/comments", review_comment: "pulls/comments" }[kind];
  return `${root}/${under}/${number}`;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const login = (user: unknown): string | null => textOrNull((user as Json | null)?.login);
const names = (list: unknown, key: string): string[] => (Array.isArray(list) ? list.map((one) => text(one?.[key])).filter((name) => name !== "") : []);

/** `host/owner/name` from an item's page address, so a moved item names the repository it is in now. */
function remoteOf(url: string, fallback: string): string {
  const found = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:issues|pull|milestone)\//.exec(url);
  return found === null ? fallback : `${found[1]}/${found[2]}/${found[3]}`;
}

function base(raw: Json, remote: string, author: unknown): RemoteItem {
  const url = text(raw.html_url);
  return {
    remote: remoteOf(url, remote),
    remoteId: text(raw.node_id),
    remoteUpdatedAt: text(raw.updated_at),
    gone: false,
    url,
    author: login(author),
    createdAt: text(raw.created_at),
  };
}

/** The issues list also holds pull requests. They come from their own list, so they are skipped here. */
export const isPullRequestInIssues = (raw: Json): boolean => raw.pull_request !== undefined && raw.pull_request !== null;

export function toIssue(raw: Json, remote: string): RemoteIssue {
  return {
    ...base(raw, remote, raw.user),
    number: Number(raw.number),
    title: text(raw.title),
    body: text(raw.body),
    state: raw.state === "closed" ? "closed" : "open",
    stateReason: textOrNull(raw.state_reason),
    type: textOrNull(raw.type?.name),
    labels: Array.isArray(raw.labels) ? raw.labels.map((label: unknown) => (typeof label === "string" ? label : text((label as Json)?.name))).filter((name: string) => name !== "") : [],
    assignees: names(raw.assignees, "login"),
    milestoneRemoteId: textOrNull(raw.milestone?.node_id),
  };
}

export function toPullRequest(raw: Json, remote: string): RemotePullRequest {
  const host = remote.split("/")[0]!;
  const repoName = (side: Json | null | undefined): string | null => (textOrNull(side?.repo?.full_name) === null ? null : `${host}/${side!.repo.full_name}`);
  const merged = textOrNull(raw.merged_at) !== null || raw.merged === true;
  return {
    ...base(raw, remote, raw.user),
    number: Number(raw.number),
    title: text(raw.title),
    body: text(raw.body),
    state: merged ? "merged" : raw.state === "closed" ? "closed" : "open",
    draft: raw.draft === true,
    headCommit: textOrNull(raw.head?.sha),
    baseRemote: repoName(raw.base),
    headRemote: repoName(raw.head),
    baseBranch: textOrNull(raw.base?.ref),
    headBranch: textOrNull(raw.head?.ref),
    labels: names(raw.labels, "name"),
    assignees: names(raw.assignees, "login"),
    milestoneRemoteId: textOrNull(raw.milestone?.node_id),
  };
}

export function toMilestone(raw: Json, remote: string): RemoteMilestone {
  return {
    ...base(raw, remote, raw.creator),
    number: Number(raw.number),
    title: text(raw.title),
    description: text(raw.description),
    state: raw.state === "closed" ? "closed" : "open",
  };
}

export function toComment(raw: Json, remote: string, review: boolean): RemoteComment {
  const url = text(raw.html_url);
  const parent = /\/(issues|pull)\/(\d+)/.exec(url) ?? /\/(issues|pulls)\/(\d+)$/.exec(text(raw.issue_url ?? raw.pull_request_url));
  return {
    ...base(raw, remote, raw.user),
    body: text(raw.body),
    on: { kind: review || (parent !== null && parent[1] !== "issues") ? "pull_request" : "issue", number: parent === null ? 0 : Number(parent[2]) },
    review,
  };
}
