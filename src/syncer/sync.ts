// One poll of the project's remotes into the record (trustmybot/tmb#70): for each repo whose
// origin is on GitHub, take the short claim, read what changed since the kept tags, fold it in as
// events, and keep where the read stopped. It fails soft: no gh, no GitHub origin, no network or a
// rate limit leaves the record as it is, and the reason is kept for tmb doctor, never thrown.
import os from "node:os";
import {
  emptySyncRow,
  githubRepoOf,
  issueSyncOn,
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
import { type Cannot, type Kept, LISTS, type ListName, type ReadAnswer } from "./types.ts";

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

/** What one poll did for one repo. `off` is the Human's setting; `held` is another poll's claim or the floor. */
export type SyncOutcome =
  | { repo: string; remote: string; ok: true; changed: boolean; count: FoldCount; incomplete: ListName[]; fullPass: boolean }
  | { repo: string; remote: string | null; ok: false; cannot: Cannot | "off" | "no_record" | "held"; why: string };

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

/** Whether the remote is due a full pass: never had one, or the last one started a week ago. */
function fullPassDue(rows: readonly SyncRow[], now: Date): boolean {
  const started = rows.find((row) => row.list === "issues")?.fullPassAt ?? null;
  return started === null || now.getTime() - Date.parse(started) >= FULL_PASS_MS;
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
    if (!issueSyncOn(readSettings(store))) return [{ repo: ".", remote: null, ok: false, cannot: "off", why: "issue sync is off" }];
    const policies = workspaceRepos(store);
    const repos = policies === null ? [{ path: ".", dir: projectDir }] : workingRepos(policies).map((name) => ({ path: name, dir: repoDirOf(projectDir, name) }));
    const outcomes: SyncOutcome[] = [];
    for (const repo of repos) outcomes.push(await syncRepo(store, repo.path, repo.dir, options));
    return outcomes;
  } catch (error) {
    return [{ repo: ".", remote: null, ok: false, cannot: "failed", why: error instanceof Error ? error.message : String(error) }];
  } finally {
    store.close();
  }
}

async function syncRepo(store: Store, path: string, dir: string, options: SyncOptions): Promise<SyncOutcome> {
  const clock = options.now ?? (() => new Date());
  const repo: Repo | null = githubRepoOf(dir);
  if (repo === null) return { repo: path, remote: null, ok: false, cannot: "not_github", why: "origin names no GitHub repository" };
  const remote = `${repo.host}/${repo.owner}/${repo.name}`;
  const started = clock();
  const by = options.by ?? `${process.pid}@${os.hostname()}`;
  const refused = store.mirror.claim(remote, LISTS, by, iso(new Date(started.getTime() + FLOOR_MS)), iso(started), options.force === true);
  if (refused !== null) return { repo: path, remote, ok: false, cannot: "held", why: `${refused.held} until ${refused.until}` };

  const rows = store.mirror.syncRows(remote);
  const fullPass = fullPassDue(rows, started);
  const kept = keptOf(rows);
  if (fullPass) for (const list of FULL_PASS_LISTS) delete kept.lists[list];
  const ask = (options.askFor ?? askThroughGh)(dir);
  let answer: ReadAnswer;
  try {
    // The claim already kept the floor, so the reader is not asked to keep it again.
    answer = await readRemote({ repo, kept, ask, now: started, force: true, pageLimit: options.pageLimit });
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

  const folder = new Folder(store, path);
  let lastError: string | null = null;
  try {
    folder.fold(answer);
    if (fullPass && !FULL_PASS_LISTS.some((list) => answer.incomplete.includes(list))) await checkGone(store, folder, repo, remote, ask, answer, iso(clock()));
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
 * missing from the whole list is gone.
 */
async function checkGone(store: Store, folder: Folder, repo: Repo, remote: string, ask: Ask, answer: Extract<ReadAnswer, { ok: true }>, at: string): Promise<void> {
  const seen = new Set([...answer.issues, ...answer.pullRequests, ...answer.milestones].map((item) => item.remoteId));
  for (const milestone of store.mirror.presentMirrored("milestone", remote)) {
    if (!seen.has(milestone.remoteId)) folder.markGone("milestone", milestone.id, at);
  }
  let asked = 0;
  for (const kind of ["issue", "pull_request"] as const) {
    for (const held of store.mirror.presentMirrored(kind, remote)) {
      if (seen.has(held.remoteId)) continue;
      const number = numberInUrl(held.url);
      if (number === null || asked >= GONE_CHECKS_MAX) continue;
      asked += 1;
      const item = await readItem({ repo, ask, kind, number });
      if (!item.ok) return;
      if (item.gone) folder.markGone(kind, held.id, at);
      else if (item.item.remote !== remote) folder.moved(kind, held.id, item.item);
    }
  }
}

/**
 * Runs polls for one process at most one at a time and no more often than the floor, so a trigger
 * on every read of the record costs nothing between polls. Each trigger returns the poll in flight.
 */
export function syncTrigger(options: SyncOptions = {}): (projectDir: string) => Promise<void> {
  let running: Promise<void> | null = null;
  let nextAt = 0;
  return (projectDir) => {
    if (running !== null) return running;
    if (Date.now() < nextAt) return Promise.resolve();
    running = syncProject(projectDir, options)
      .then(() => undefined, () => undefined)
      .finally(() => {
        nextAt = Date.now() + FLOOR_MS;
        running = null;
      });
    return running;
  };
}
