// The read: what changed on the remote since the last one. Cheapest first — one conditional
// request per list, and a list that answers "not modified" costs nothing. Requests go one after
// another, a wait the remote asks for is handed back to be obeyed, and nothing here throws.
import { firstPage, isGithubHost, isPullRequestInIssues, itemPath, newestFirst, remoteName, sincePage, toComment, toIssue, toMilestone, toPullRequest } from "./github.ts";
import type { ItemKind, Repo } from "./github.ts";
import { nextPage, waitAsked } from "./transport.ts";
import type { Answer, Ask } from "./transport.ts";
import { LISTS } from "./types.ts";
import type { Cannot, Changes, ItemAnswer, Kept, ListKept, ListName, ReadAnswer } from "./types.ts";

/** No triggered read sooner than this after the last one. */
export const FLOOR_MS = 2 * 60_000;
const PAGE_LIMIT = 100;

export type ReadOptions = {
  /** The repository to read, or null when origin names none. */
  repo: Repo | null;
  kept: Kept;
  ask: Ask;
  now?: Date;
  /** A read someone asked for by hand: it ignores the floor, never the remote's wait. */
  force?: boolean;
  /** The most pages one list may take in one read. */
  pageLimit?: number;
};

type Refusal = { cannot: Cannot; why: string; waitUntil: string | null };
type Raw = Record<string, any>;

export async function readRemote(options: ReadOptions): Promise<ReadAnswer> {
  const { repo, kept, ask } = options;
  const now = options.now ?? new Date();
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  if (repo === null) return { ok: false, cannot: "not_github", why: "origin names no GitHub repository", keep: kept };
  if (kept.waitUntil !== null && now.getTime() < Date.parse(kept.waitUntil)) {
    return { ok: false, cannot: "too_soon", why: `the remote asked for a wait until ${kept.waitUntil}`, keep: kept };
  }
  if (!options.force && kept.notBefore !== null && now.getTime() < Date.parse(kept.notBefore)) {
    return { ok: false, cannot: "too_soon", why: `read less than two minutes ago; next at ${kept.notBefore}`, keep: kept };
  }

  const remote = remoteName(repo);
  const notBefore = new Date(now.getTime() + FLOOR_MS).toISOString();
  const lists: Partial<Record<ListName, ListKept>> = {};
  const raws: Record<ListName, Raw[]> = { issues: [], comments: [], review_comments: [], pull_requests: [], milestones: [] };
  const incomplete: ListName[] = [];
  let requests = 0;
  let changed = false;

  for (const list of LISTS) {
    const before = kept.lists[list] ?? { tag: null, since: null };
    const read = await readList(repo, list, before, ask, now, pageLimit);
    requests += read.requests;
    if ("refusal" in read) {
      // Nothing is half kept: the lists stay where they were, so the next read asks again.
      const { cannot, why, waitUntil } = read.refusal;
      return { ok: false, cannot, why, keep: { lists: kept.lists, notBefore, waitUntil: waitUntil ?? null } };
    }
    lists[list] = read.keep;
    if (read.modified) changed = true;
    if (!read.complete) incomplete.push(list);
    raws[list] = read.items;
  }

  const changes: Changes = {
    issues: raws.issues.filter((raw) => !isPullRequestInIssues(raw)).map((raw) => toIssue(raw, remote)),
    comments: [...raws.comments.map((raw) => toComment(raw, remote, false)), ...raws.review_comments.map((raw) => toComment(raw, remote, true))],
    pullRequests: raws.pull_requests.map((raw) => toPullRequest(raw, remote)),
    milestones: raws.milestones.map((raw) => toMilestone(raw, remote)),
  };
  return { ok: true, remote, changed, incomplete, requests, keep: { lists, notBefore, waitUntil: null }, ...changes };
}

type ListRead = { requests: number } & ({ refusal: Refusal } | { modified: boolean; complete: boolean; items: Raw[]; keep: ListKept });

async function readList(repo: Repo, list: ListName, before: ListKept, ask: Ask, now: Date, pageLimit: number): Promise<ListRead> {
  let requests = 0;
  const page = async (path: string, tag: string | null): Promise<{ refusal: Refusal } | { notModified: true } | { items: Raw[]; tag: string | null; next: string | null }> => {
    const answer = await ask({ host: repo.host, path, tag });
    if (answer.sent && answer.status === 304) return { notModified: true };
    requests += 1;
    const refusal = refusalOf(answer, repo, now);
    if (refusal !== null) return { refusal };
    const sent = answer as Extract<Answer, { sent: true }>;
    let items: unknown;
    try {
      items = JSON.parse(sent.body);
    } catch {
      items = null;
    }
    if (!Array.isArray(items)) return { refusal: { cannot: isGithubHost(repo.host) ? "failed" : "not_github", why: "the remote's answer was not a list", waitUntil: null } };
    return { items: items as Raw[], tag: sent.headers["etag"] ?? null, next: nextPage(sent.headers) };
  };
  const fresh = (items: Raw[]): Raw[] => items.filter((item) => before.since === null || String(item.updated_at) >= before.since);
  const latest = (items: Raw[]): string | null => items.reduce<string | null>((max, item) => (typeof item.updated_at === "string" && (max === null || item.updated_at > max) ? item.updated_at : max), before.since);

  const first = await page(firstPage(repo, list), before.tag);
  if ("refusal" in first) return { requests, refusal: first.refusal };
  if ("notModified" in first) return { requests, modified: false, complete: true, items: [], keep: before };

  const oldest = first.items.reduce<string | null>((min, item) => (typeof item.updated_at === "string" && (min === null || item.updated_at < min) ? item.updated_at : min), null);
  const holdsAll = first.next === null || (newestFirst(list) && before.since !== null && oldest !== null && oldest < before.since);
  if (holdsAll) {
    const items = fresh(first.items);
    return { requests, modified: true, complete: true, items, keep: { tag: first.tag, since: latest(items) } };
  }

  // More than one page changed. A list that takes "updated since" is read oldest change first,
  // so a read cut short moves its since-time forward and the next one carries on from there.
  const resumable = sincePage(repo, list, before.since);
  const items: Raw[] = resumable === null ? [...first.items] : [];
  let next: string | null = resumable ?? first.next;
  let pages = 1;
  let reachedKept = false;
  while (next !== null && !reachedKept && pages < pageLimit) {
    const more = await page(next, null);
    if ("refusal" in more) return { requests, refusal: more.refusal };
    if ("notModified" in more) break;
    items.push(...more.items);
    next = more.next;
    pages += 1;
    reachedKept = resumable === null && newestFirst(list) && before.since !== null && more.items.some((item) => String(item.updated_at) < before.since!);
  }
  const complete = next === null || reachedKept;
  const kept = fresh(items);
  if (resumable !== null) return { requests, modified: true, complete, items: kept, keep: { tag: complete ? first.tag : null, since: latest(kept) } };
  // Newest first and cut short leaves older changes unread, so the since-time must not move.
  // A list in no order of change spans pages its first page's tag does not cover: no tag is kept.
  return { requests, modified: true, complete, items: kept, keep: { tag: complete && newestFirst(list) ? first.tag : null, since: complete ? latest(kept) : before.since } };
}

/** Why an answer is no good, or null when it is one. */
function refusalOf(answer: Answer, repo: Repo, now: Date): Refusal | null {
  const github = isGithubHost(repo.host);
  if (!answer.sent) {
    if (answer.why === "no_network" || github) return { cannot: answer.why, why: answer.said, waitUntil: null };
    return { cannot: "not_github", why: `${repo.host} did not answer as GitHub: ${answer.said}`, waitUntil: null };
  }
  if (answer.status === 200) return null;
  const waitUntil = waitAsked(answer, now);
  if (waitUntil !== null) return { cannot: "rate_limited", why: `the remote asked for a wait until ${waitUntil}`, waitUntil };
  if (!github) return { cannot: "not_github", why: `${repo.host} answered ${answer.status}`, waitUntil: null };
  if (answer.status === 401) return { cannot: "no_sign_in", why: "the remote refused the sign-in (401)", waitUntil: null };
  const message = messageOf(answer.body);
  return { cannot: "failed", why: `the remote answered ${answer.status}${message === "" ? "" : `: ${message}`}`, waitUntil: null };
}

function messageOf(body: string): string {
  try {
    const message = (JSON.parse(body) as Raw).message;
    return typeof message === "string" ? message.slice(0, 200) : "";
  } catch {
    return "";
  }
}

/**
 * Asks for one item directly: the only way to learn it was deleted. An item that moved to another
 * repository comes back naming the repository it is in now.
 */
export async function readItem(options: { repo: Repo; ask: Ask; kind: ItemKind; number: number; now?: Date }): Promise<ItemAnswer> {
  const { repo, ask, kind, number } = options;
  const answer = await ask({ host: repo.host, path: itemPath(repo, kind, number) });
  if (answer.sent && (answer.status === 404 || answer.status === 410)) return { ok: true, gone: true };
  const refusal = refusalOf(answer, repo, options.now ?? new Date());
  if (refusal !== null) return { ok: false, ...refusal };
  let raw: unknown;
  try {
    raw = JSON.parse((answer as Extract<Answer, { sent: true }>).body);
  } catch {
    raw = null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, cannot: "failed", why: "the remote's answer was not an item", waitUntil: null };
  const remote = remoteName(repo);
  const item =
    kind === "issue" ? toIssue(raw as Raw, remote)
    : kind === "pull_request" ? toPullRequest(raw as Raw, remote)
    : kind === "milestone" ? toMilestone(raw as Raw, remote)
    : toComment(raw as Raw, remote, kind === "review_comment");
  return { ok: true, gone: false, item };
}
