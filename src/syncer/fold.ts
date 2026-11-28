// The syncer's folding half: what the reader found on the remote, written into the record as
// events by tmb's syncer (trustmybot/tmb#70). A row is found by the remote's own id, so a rename
// or a transfer changes the row and never makes a second one. A held row that already says what
// the remote says gets no event, so a poll that finds nothing new writes nothing. A local row,
// with no remote id, is never found here and never changed; notes and decisions stay local.
import type { Actor, MirroredRow, Store } from "../engine/index.ts";
import type { Changes, RemoteComment, RemoteIssue, RemoteItem, RemoteMilestone, RemotePullRequest } from "./types.ts";

/** What one fold did. A comment whose issue the record does not hold is skipped, as is a blank one. */
export type FoldCount = { created: number; updated: number; skipped: number };

/** A blank title on the remote still makes an issue the record can show. */
export const UNTITLED = "(untitled)";

/** tmb's syncer, naming the remote account that made the change when the remote says who. */
export function syncerActor(account: string | null): Actor {
  return account === null || account === "" ? { kind: "tmb", source: "syncer" } : { kind: "tmb", source: "syncer", remote: account };
}

/** The remote columns every mirrored row keeps; a row seen again is no longer gone. */
function remoteColumns(item: RemoteItem): Record<string, unknown> {
  return { remote: item.remote, remote_id: item.remoteId, remote_updated_at: item.remoteUpdatedAt, remote_gone_at: null };
}

/** When the remote says an issue or a comment was opened; a row brought in before the column gets it at its next fold. */
const openedOnRemote = (item: RemoteItem): Record<string, unknown> => (item.createdAt === "" ? {} : { remote_created_at: item.createdAt });

/** The columns of `next` that differ from the held row; the remote's time alone is no change. */
function differences(held: MirroredRow, next: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(next)) {
    if (column === "remote_updated_at") continue;
    const stored = held[column] ?? null;
    const wanted = value === undefined ? null : typeof value === "boolean" ? Number(value) : typeof value === "object" && value !== null ? JSON.stringify(value) : value;
    if (stored !== wanted) changed[column] = value;
  }
  return changed;
}

/** The issue number in an issue's address on the remote. */
const NUMBER_IN_URL = /\/(?:issues|pull)\/(\d+)$/;
export function numberInUrl(url: string | null): number | null {
  const found = url === null ? null : NUMBER_IN_URL.exec(url);
  return found === null ? null : Number(found[1]);
}

export class Folder {
  readonly count: FoldCount = { created: 0, updated: 0, skipped: 0 };
  private repoId: string | null = null;

  /** `repoPath` is the repo's path in the project, `.` for the project folder itself. */
  constructor(
    private readonly store: Store,
    private readonly repoPath: string,
  ) {}

  /** Folds one answer in the order the rows refer to each other: milestones, issues, comments, pull requests. */
  fold(changes: Changes): FoldCount {
    this.store.transaction(() => {
      for (const milestone of changes.milestones) this.milestone(milestone);
      for (const issue of changes.issues) this.issue(issue);
      for (const comment of changes.comments) this.comment(comment);
      for (const pullRequest of changes.pullRequests) this.pullRequest(pullRequest);
    });
    return this.count;
  }

  /** Marks a held row gone from the remote: deleted, or out of reach. Nothing is deleted. */
  markGone(kind: "issue" | "milestone" | "pull_request", id: string, at: string): void {
    this.store.mirror.updateMirrored(syncerActor(null), kind, id, { remote_gone_at: at });
    this.count.updated += 1;
  }

  /** Writes a held row's move to another remote repository, found by asking for it directly. */
  moved(kind: "issue" | "pull_request", id: string, item: RemoteItem): void {
    const address = kind === "issue" ? "remote_url" : "url";
    this.store.mirror.updateMirrored(syncerActor(null), kind, id, { [address]: item.url, ...remoteColumns(item) });
    this.count.updated += 1;
  }

  private repo(): string {
    this.repoId ??= this.store.mirror.repoId(syncerActor(null), this.repoPath);
    return this.repoId;
  }

  /** Creates the row, or writes only the columns the remote changed; one event either way, or none. */
  private put(kind: "issue" | "discussion" | "milestone" | "pull_request", item: RemoteItem, next: Record<string, unknown>, firstOnly: Record<string, unknown> = {}): void {
    const held = this.store.mirror.findMirrored(kind, item.remoteId);
    if (held === null) {
      this.store.mirror.createMirrored(syncerActor(item.author), kind, { ...firstOnly, ...next });
      this.count.created += 1;
      return;
    }
    const changed = differences(held, next);
    if (Object.keys(changed).length === 0) return;
    // A list does not say who changed an item, only who wrote it, so an update names no account.
    // A discussion has no updated_at of its own, so a comment's edit carries the remote's time.
    const edited = kind === "discussion" && "body" in changed ? { updated_at: item.remoteUpdatedAt } : {};
    this.store.mirror.updateMirrored(syncerActor(null), kind, held.id, { ...changed, ...edited, remote_updated_at: item.remoteUpdatedAt });
    this.count.updated += 1;
  }

  private milestoneId(remoteId: string | null): string | null {
    return remoteId === null ? null : (this.store.mirror.findMirrored("milestone", remoteId)?.id ?? null);
  }

  private milestone(milestone: RemoteMilestone): void {
    const title = milestone.title.trim() === "" ? UNTITLED : milestone.title;
    this.put("milestone", milestone, { title, description: milestone.description, state: milestone.state, ...remoteColumns(milestone) }, { repo_id: this.repo() });
  }

  private issue(issue: RemoteIssue): void {
    this.put("issue", issue, {
      title: issue.title.trim() === "" ? UNTITLED : issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.stateReason,
      type: issue.type,
      labels: issue.labels,
      assignees: issue.assignees,
      milestone_id: this.milestoneId(issue.milestoneRemoteId),
      remote_url: issue.url,
      ...openedOnRemote(issue),
      ...remoteColumns(issue),
    });
  }

  private comment(comment: RemoteComment): void {
    // A comment on a pull request has no issue to sit under yet; one on a line of a change neither.
    // A held comment is found by its own id, so its issue's move does not lose it.
    const held = comment.on.kind === "issue" && !comment.review ? this.store.mirror.findMirrored("discussion", comment.remoteId) : null;
    const issueId = held !== null ? String(held.issue_id) : comment.on.kind === "issue" && !comment.review ? this.store.mirror.issueIdOn(comment.remote, comment.on.number) : null;
    if (issueId === null || comment.body.trim() === "") {
      this.count.skipped += 1;
      return;
    }
    this.put("discussion", comment, { body: comment.body, ...openedOnRemote(comment), ...remoteColumns(comment) }, { issue_id: issueId, kind: "comment", remote_author: comment.author });
  }

  private pullRequest(pullRequest: RemotePullRequest): void {
    const opener = this.store.mirror.openerOf(pullRequest.url);
    const ours = opener.featureId !== null || opener.taskId !== null;
    const held = this.store.mirror.findMirrored("pull_request", pullRequest.remoteId);
    // A pull request is linked once to the feature branch or task that opened it, and stays linked.
    const link = held === null || (held.feature_id === null && held.task_id === null) ? { feature_id: opener.featureId, task_id: opener.taskId } : {};
    this.put(
      "pull_request",
      pullRequest,
      {
        url: pullRequest.url,
        ...link,
        state: pullRequest.state,
        draft: pullRequest.draft,
        head_commit: pullRequest.headCommit,
        head_remote: pullRequest.headRemote,
        ...remoteColumns(pullRequest),
      },
      {
        repo_id: this.repo(),
        // tmb's own pull request names no author: the feature branch or task says who opened it.
        author: ours ? null : pullRequest.author,
        // Kept in the event only: what the remote said the pull request was when it came in.
        number: pullRequest.number,
        title: pullRequest.title,
        base_branch: pullRequest.baseBranch,
        head_branch: pullRequest.headBranch,
      },
    );
  }
}
