// What the syncer's reader hands back: the remote's issues, comments, pull requests and
// milestones as plain values that name no vendor, and what the caller keeps for the next read.
// The reader only reads. It writes nothing to the remote and nothing to the record.

/** What every mirrored item carries, matching the record's remote columns. */
export type RemoteItem = {
  /** The remote repository the item is in, as `host/owner/name`. */
  remote: string;
  /** The remote's own id for the item, which a rename or a transfer does not change. */
  remoteId: string;
  /** The remote's time of last change, ISO 8601. */
  remoteUpdatedAt: string;
  /** True when the remote no longer has it. A list never says so; only a direct ask does. */
  gone: boolean;
  /** Its address on the remote. */
  url: string;
  /** The remote account that wrote it, or null when the remote names none. */
  author: string | null;
  createdAt: string;
};

export type RemoteIssue = RemoteItem & {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** Why it closed, in the remote's words. */
  stateReason: string | null;
  /** The kind of work, in the remote's words. */
  type: string | null;
  labels: string[];
  assignees: string[];
  /** The remote id of its milestone. */
  milestoneRemoteId: string | null;
};

export type RemoteComment = RemoteItem & {
  body: string;
  /** What it is written on. A list names the parent by number, not by remote id. */
  on: { kind: "issue" | "pull_request"; number: number };
  /** A review comment is written on a line of a pull request's change. */
  review: boolean;
};

export type RemotePullRequest = RemoteItem & {
  number: number;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** The commit at its tip. */
  headCommit: string | null;
  /** The repository it merges into, and the one its branch is in. They differ for a fork. */
  baseRemote: string | null;
  headRemote: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  labels: string[];
  assignees: string[];
  milestoneRemoteId: string | null;
};

export type RemoteMilestone = RemoteItem & {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
};

/** The lists the reader asks for, each with its own tag and since-time. */
export const LISTS = ["issues", "comments", "review_comments", "pull_requests", "milestones"] as const;
export type ListName = (typeof LISTS)[number];

/** Where one list stopped: the tag the remote gave, and the time the next read asks from. */
export type ListKept = { tag: string | null; since: string | null };

/** What the caller keeps between reads. A lost one costs one read of everything. */
export type Kept = {
  lists: Partial<Record<ListName, ListKept>>;
  /** The floor: no triggered read before this time. A forced read ignores it. */
  notBefore: string | null;
  /** Set when the remote asked for a wait. No read at all before it, forced or not. */
  waitUntil: string | null;
};

export const NOTHING_KEPT: Kept = { lists: {}, notBefore: null, waitUntil: null };

/** Why the remote was not read. `too_soon` is the floor or the remote's wait, not a failure. */
export type Cannot = "not_github" | "no_sign_in" | "no_network" | "rate_limited" | "too_soon" | "failed";

export type Changes = {
  issues: RemoteIssue[];
  comments: RemoteComment[];
  pullRequests: RemotePullRequest[];
  milestones: RemoteMilestone[];
};

export type ReadAnswer =
  | ({
      ok: true;
      remote: string;
      /** False when nothing changed: every list answered "not modified". */
      changed: boolean;
      /** Lists cut short by the page limit. Their since-time still moved where it safely could. */
      incomplete: ListName[];
      /** How many requests counted against the remote's hourly limit. */
      requests: number;
      keep: Kept;
    } & Changes)
  | { ok: false; cannot: Cannot; why: string; keep: Kept };

/** One item asked for directly, which is the only way to learn it was deleted or moved. */
export type ItemAnswer =
  | { ok: true; gone: true }
  | { ok: true; gone: false; item: RemoteIssue | RemotePullRequest | RemoteMilestone | RemoteComment }
  | { ok: false; cannot: Cannot; why: string; waitUntil: string | null };
