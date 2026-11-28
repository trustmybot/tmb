// One poll of the project's remotes into the record (trustmybot/tmb#70): for each repo whose
// origin is on GitHub, take the short claim, read what changed since the kept tags, fold it in as
// events, and keep where the read stopped. It fails soft: no gh, no GitHub origin, no network or a
// rate limit leaves the record as it is, and the reason is kept for tmb doctor, never thrown.
import os from "node:os";
import {
  emptySyncRow,
  githubRepoOf,
  issueSyncOf,
  openProjectStore,
  readSettings,
  repoDirOf,
  type Store,
  type SyncRow,
  workingRepos,
  workspaceRepos,
} from "../engine/index.ts";
import { Folder, type FoldCount, numberInUrl } from "./fold.ts";
import type { Repo } from "./github.ts";
import { FLOOR_MS, readItem, readRemote } from "./reader.ts";
import { type Ask, askThroughGh } from "./transport.ts";
import { type Cannot, type Kept, LISTS, type ListName, type ReadAnswer, type RemoteIssue } from "./types.ts";

/** How often the issues, pull requests and milestones are read whole, to find what was deleted. */
export const FULL_PASS_MS = 7 * 24 * 60 * 60_000;
/** How many held items one poll asks for one by one, to learn whether each is gone. */
export const GONE_CHECKS_MAX = 50;
/** The lists a full pass reads from the start. Comments are found gone only with their issue. */
const FULL_PASS_LISTS: readonly ListName[] = ["issues", "pull_requests", "milestones"];

export type SyncOptions = {
  /** Skips the floor between reads, never a live claim or the remote's own wait. */
  force?: boolean;
  now?: () => Date;
  /** How a repo's remote is asked; the user's own gh unless a test records the answers. */
  askFor?: (repoDir: string) => Ask;
  pageLimit?: number;
  /** Who holds the claim while the poll runs. */
  by?: string;
};

/** What one poll did for one repo. `off` is the Human's setting; `held` is another poll's claim or the floor, until the time it names. */
export type SyncOutcome =
  | { repo: string; remote: string; ok: true; changed: boolean; count: FoldCount; incomplete: ListName[]; fullPass: boolean }
  | { repo: string; remote: string | null; ok: false; cannot: "held"; why: string; until: string }
  | { repo: string; remote: string | null; ok: false; cannot: Cannot | "off" | "no_record"; why: string };

const iso = (date: Date): string => date.toISOString();

/** The kept read state of one remote, from its sync_state rows. */
export function keptOf(rows: readonly SyncRow[]): Kept {
  const kept: Kept = { lists: {}, notBefore: null, waitUntil: null };
  for (const row of rows) {
    if ((LISTS as readonly string[]).includes(row.list)) kept.lists[row.list as ListName] = { tag: row.tag, since: row.since, resume: row.resume };
    if (row.waitUntil !== null && (kept.waitUntil === null || row.waitUntil > kept.waitUntil)) kept.waitUntil = row.waitUntil;
  }
  return kept;
}

/**
 * Whether the remote is due a full pass: never had one, the last one started a week ago, or the
 * Human chose all issues since it, so the closed ones an import of the open ones left out come in.
 */
function fullPassDue(rows: readonly SyncRow[], now: Date, allChosenAt: string | null): boolean {
  const started = rows.find((row) => row.list === "issues")?.fullPassAt ?? null;
  return started === null || now.getTime() - Date.parse(started) >= FULL_PASS_MS || (allChosenAt !== null && allChosenAt > started);
}

/** When the Human last chose all issues, or null when the current choice is not all. */
function allChosenAt(store: Store): string | null {
  const change = store.newestSettingChange("issue_sync", null, true);
  return change !== null && issueSyncOf(readSettings(store)) === "all" ? change.createdAt : null;
}

/** Polls every repo of the project tmb works in. Never throws. */
export async function syncProject(projectDir: string, options: SyncOptions = {}): Promise<SyncOutcome[]> {
  let opened: ReturnType<typeof openProjectStore>;
  try {
    opened = openProjectStore(projectDir, { create: false });
  } catch (error) {
    return [{ repo: ".", remote: null, ok: false, cannot: "no_record", why: String(error) }];
  }
  if (!opened.ok) return [{ repo: ".", remote: null, ok: false, cannot: "no_record", why: opened.error.message }];
  const store = opened.store;
  try {
    const mode = issueSyncOf(readSettings(store));
    if (mode === "off") return [{ repo: ".", remote: null, ok: false, cannot: "off", why: "issue sync is off" }];
    const policies = workspaceRepos(store);
    const repos = policies === null ? [{ path: ".", dir: projectDir }] : workingRepos(policies).map((name) => ({ path: name, dir: repoDirOf(projectDir, name) }));
    const outcomes: SyncOutcome[] = [];
    for (const repo of repos) outcomes.push(await syncRepo(store, repo.path, repo.dir, options, mode === "open"));
    return outcomes;
  } catch (error) {
    return [{ repo: ".", remote: null, ok: false, cannot: "failed", why: error instanceof Error ? error.message : String(error) }];
  } finally {
    store.close();
  }
}

/** `openOnly`: the Human chose only the open issues, so closed ones never held are not copied in. */
async function syncRepo(store: Store, path: string, dir: string, options: SyncOptions, openOnly: boolean): Promise<SyncOutcome> {
  const clock = options.now ?? (() => new Date());
  const repo: Repo | null = githubRepoOf(dir);
  if (repo === null) return { repo: path, remote: null, ok: false, cannot: "not_github", why: "origin names no GitHub repository" };
  const remote = `${repo.host}/${repo.owner}/${repo.name}`;
  const started = clock();
  const by = options.by ?? `${process.pid}@${os.hostname()}`;
  const refused = store.mirror.claim(remote, LISTS, by, iso(new Date(started.getTime() + FLOOR_MS)), iso(started), options.force === true);
  if (refused !== null) return { repo: path, remote, ok: false, cannot: "held", why: `${refused.held} until ${refused.until}`, until: refused.until };

  const rows = store.mirror.syncRows(remote);
  const fullPass = fullPassDue(rows, started, allChosenAt(store));
  const kept = keptOf(rows);
  if (fullPass) for (const list of FULL_PASS_LISTS) delete kept.lists[list];
  const ask = (options.askFor ?? askThroughGh)(dir);
  let answer: ReadAnswer;
  try {
    // The claim already kept the floor, so the reader is not asked to keep it again.
    answer = await readRemote({ repo, kept, ask, now: started, force: true, pageLimit: options.pageLimit, openIssuesOnly: openOnly });
  } catch (error) {
    answer = { ok: false, cannot: "failed", why: error instanceof Error ? error.message : String(error), keep: kept };
  }
  const floor = iso(new Date(clock().getTime() + FLOOR_MS));
  const byList = new Map(rows.map((row) => [row.list, row]));
  if (!answer.ok) {
    for (const list of LISTS) {
      const row = byList.get(list) ?? emptySyncRow(remote, list);
      store.mirror.putSyncRow({ ...row, waitUntil: answer.keep.waitUntil, claimedBy: null, claimUntil: floor, lastError: `${answer.cannot}: ${answer.why}` });
    }
    return { repo: path, remote, ok: false, cannot: answer.cannot, why: answer.why };
  }

  const folder = new Folder(store, path, openOnly);
  let lastError: string | null = null;
  try {
    folder.fold(answer);
    if (fullPass && !FULL_PASS_LISTS.some((list) => answer.incomplete.includes(list))) await checkGone(store, folder, repo, remote, ask, answer, iso(clock()), openOnly);
  } catch (error) {
    lastError = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const finished = iso(clock());
  for (const list of LISTS) {
    const row = byList.get(list) ?? emptySyncRow(remote, list);
    // A comment whose issue is not in the record yet comes again with the next read, not never.
    const keepOld = lastError !== null || (list === "comments" && answer.incomplete.includes("issues"));
    const next = keepOld ? { tag: row.tag, since: row.since, resume: row.resume } : (answer.keep.lists[list] ?? { tag: null, since: null });
    store.mirror.putSyncRow({
      ...row,
      tag: next.tag,
      since: next.since,
      resume: next.resume ?? null,
      syncedAt: lastError === null ? finished : row.syncedAt,
      fullPassAt: fullPass && lastError === null ? iso(started) : row.fullPassAt,
      waitUntil: answer.keep.waitUntil,
      claimedBy: null,
      claimUntil: floor,
      lastError,
    });
  }
  if (lastError !== null) return { repo: path, remote, ok: false, cannot: "failed", why: lastError };
  return { repo: path, remote, ok: true, changed: answer.changed, count: folder.count, incomplete: answer.incomplete, fullPass };
}

/**
 * After a whole read, the held rows the remote no longer listed: each issue and pull request is asked
 * for directly, since only that tells deleted from moved, up to GONE_CHECKS_MAX a poll. A milestone
 * missing from the whole list is gone. When only the open issues were read, a held closed issue is
 * not looked for, and one held open that is there and closed takes its close.
 */
async function checkGone(store: Store, folder: Folder, repo: Repo, remote: string, ask: Ask, answer: Extract<ReadAnswer, { ok: true }>, at: string, openOnly: boolean): Promise<void> {
  const seen = new Set([...answer.issues, ...answer.pullRequests, ...answer.milestones].map((item) => item.remoteId));
  for (const milestone of store.mirror.presentMirrored("milestone", remote)) {
    if (!seen.has(milestone.remoteId)) folder.markGone("milestone", milestone.id, at);
  }
  let asked = 0;
  for (const kind of ["issue", "pull_request"] as const) {
    for (const held of store.mirror.presentMirrored(kind, remote)) {
      if (seen.has(held.remoteId) || (openOnly && kind === "issue" && held.state !== "open")) continue;
      const number = numberInUrl(held.url);
      if (number === null || asked >= GONE_CHECKS_MAX) continue;
      asked += 1;
      const item = await readItem({ repo, ask, kind, number });
      if (!item.ok) return;
      if (item.gone) folder.markGone(kind, held.id, at);
      else if (item.item.remote !== remote) folder.moved(kind, held.id, item.item);
      else if (kind === "issue") folder.fold({ issues: [item.item as RemoteIssue], comments: [], pullRequests: [], milestones: [] });
    }
  }
}

/**
 * Runs polls for one process at most one at a time and no more often than the floor, so a trigger
 * on every read of the record costs nothing between polls. Each trigger returns the poll in flight.
 * A poll held back by the record's floor or another session's claim waits only until that ends:
 * a session started inside another's floor must not add a floor of its own (trustmybot/tmb#513).
 */
export function syncTrigger(options: SyncOptions = {}): (projectDir: string) => Promise<void> {
  let running: Promise<void> | null = null;
  let nextAt = 0;
  return (projectDir) => {
    if (running !== null) return running;
    if (Date.now() < nextAt) return Promise.resolve();
    running = syncProject(projectDir, options)
      .then(
        (outcomes) => {
          // The soonest any repo may be read again: a held one when its hold ends, any other a floor from now.
          const floor = Date.now() + FLOOR_MS;
          nextAt = Math.min(floor, ...outcomes.map((outcome) => (!outcome.ok && outcome.cannot === "held" ? Date.parse(outcome.until) || floor : floor)));
        },
        () => {
          nextAt = Date.now() + FLOOR_MS;
        },
      )
      .finally(() => {
        running = null;
      });
    return running;
  };
}

/** A poll a short-lived process waited for: whether it has ended, and how to give it up. */
export type BriefSync = {
  /** True once the poll ended, whatever it found. */
  readonly ended: () => boolean;
  /**
   * Gives up a poll that has not ended: stops its ask of the remote and gives its claim back, so
   * the next trigger polls at once. Returns false, and does nothing, when the poll had ended. Never throws.
   */
  readonly giveUp: () => boolean;
};

/**
 * One poll for a process that ends soon, such as a hook: under the same floor and claim as any
 * other, waited for `waitMs` at most. The caller gives up one still running before it ends itself,
 * so nothing runs on after it. Never throws.
 */
export async function syncBriefly(projectDir: string, waitMs: number, options: SyncOptions = {}): Promise<BriefSync> {
  const stop = new AbortController();
  const by = options.by ?? `${process.pid}@${os.hostname()}`;
  let ended = false;
  const poll = syncProject(projectDir, { askFor: (repoDir) => askThroughGh(repoDir, stop.signal), ...options, by }).then(
    () => void (ended = true),
    () => void (ended = true),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([poll, new Promise<void>((resolve) => void (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
  return {
    ended: () => ended,
    giveUp: () => {
      if (ended) return false;
      stop.abort();
      try {
        const opened = openProjectStore(projectDir, { create: false });
        if (opened.ok) {
          try {
            opened.store.mirror.releaseClaims(by);
          } finally {
            opened.store.close();
          }
        }
      } catch {
        // A claim left behind runs out by itself.
      }
      return true;
    },
  };
}
