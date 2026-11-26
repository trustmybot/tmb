// The public repos the code graph's tests read, each pinned to one commit: hono for the coverage
// test (trustmybot/tmb#247) and the link check (trustmybot/tmb#242), so a form of TypeScript tmb's
// own code does not use is still caught, and flask and datasette for the benchmark's Python
// (trustmybot/tmb#244).
//
//   bun tests/lib/pinned-repo.ts [folder]          fetch hono at the pinned commit (one shallow fetch)
//   bun tests/lib/pinned-repo.ts <name> [folder]   fetch the pinned repo of that name
//
// A test reads a repo from its variable (TMB_PINNED_HONO, TMB_PINNED_FLASK, TMB_PINNED_DATASETTE)
// when set, else from the cache folder below, and is skipped, saying why, when the variable is
// unset and the cache folder missing. The tests never use the network: CI fetches the repo in a
// step before the test runs (.github/workflows/ci.yml).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type PinnedRepo = { name: string; url: string; commit: string; env: string };

export const PINNED_HONO: PinnedRepo = {
  name: "hono",
  url: "https://github.com/honojs/hono.git",
  commit: "75ff8e3ea18485589816881c6278bc9783e56602",
  env: "TMB_PINNED_HONO",
};

export const PINNED_FLASK: PinnedRepo = {
  name: "flask",
  url: "https://github.com/pallets/flask.git",
  commit: "49943b5a94413a530761350f04e896f76e8d620e",
  env: "TMB_PINNED_FLASK",
};

export const PINNED_DATASETTE: PinnedRepo = {
  name: "datasette",
  url: "https://github.com/simonw/datasette.git",
  commit: "b91f2668004b3c115a8672474739a88f08945605",
  env: "TMB_PINNED_DATASETTE",
};

/** Every pinned repo, by name. */
export const PINNED: Readonly<Record<string, PinnedRepo>> = Object.fromEntries([PINNED_HONO, PINNED_FLASK, PINNED_DATASETTE].map((r) => [r.name, r]));

/** Where a test looks for the repo: its variable, else the cache folder. */
export function pinnedFolder(repo: PinnedRepo): string {
  const fromEnv = process.env[repo.env]?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(homedir(), ".cache", "tmb", "pinned", `${repo.name}-${repo.commit.slice(0, 7)}`);
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 300_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/**
 * The repo's folder when it holds the pinned commit, else why a test cannot run on it: the cache
 * folder missing is a skip; a folder the variable names missing, or one at another commit, is an
 * error.
 */
export function pinnedRepo(repo: PinnedRepo): { folder: string } | { skip: string } | { error: string } {
  const folder = pinnedFolder(repo);
  const how = `run \`bun tests/lib/pinned-repo.ts ${repo.name}\` to fetch it, or set ${repo.env} to a checkout of ${repo.url} at ${repo.commit.slice(0, 7)}`;
  if (!existsSync(folder)) {
    // Named on purpose, as CI does: a missing copy is then an error, never a quiet skip.
    if (process.env[repo.env]?.trim()) return { error: `${repo.env} names ${folder}, which does not exist; ${how}` };
    return { skip: `no copy of ${repo.name} at ${folder}; ${how}` };
  }
  const head = git(folder, ["rev-parse", "HEAD"]);
  if (!head.ok) return { error: `${folder} is not a git checkout (${head.out}); ${how}` };
  if (head.out !== repo.commit) return { error: `${folder} is at ${head.out.slice(0, 7)}, not the pinned ${repo.commit.slice(0, 7)}; ${how}` };
  return { folder };
}

/** Fetches the pinned commit alone into the folder and checks it out. */
export function fetchPinned(repo: PinnedRepo, folder = pinnedFolder(repo)): void {
  mkdirSync(folder, { recursive: true });
  const steps: string[][] = [
    ["init", "--quiet"],
    ["fetch", "--quiet", "--depth", "1", repo.url, repo.commit],
    ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "FETCH_HEAD"],
  ];
  if (git(folder, ["rev-parse", "HEAD"]).out === repo.commit) return;
  for (const args of steps) {
    const r = git(folder, args);
    if (!r.ok) throw new Error(`git ${args.join(" ")} failed in ${folder}: ${r.out}`);
  }
}

/** Where the tests look for hono. */
export const pinnedHonoFolder = (): string => pinnedFolder(PINNED_HONO);
/** hono's folder when it holds the pinned commit, else why a test cannot run on it. */
export const pinnedHono = (): ReturnType<typeof pinnedRepo> => pinnedRepo(PINNED_HONO);
/** Fetches hono at the pinned commit. */
export const fetchPinnedHono = (folder = pinnedHonoFolder()): void => fetchPinned(PINNED_HONO, folder);

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  // A first argument that names a pinned repo picks it; else it is hono's folder, as CI passes it.
  const named = first === undefined ? undefined : PINNED[first];
  const repo = named ?? PINNED_HONO;
  const given = named === undefined ? first : second;
  const folder = given ? path.resolve(given) : pinnedFolder(repo);
  fetchPinned(repo, folder);
  console.log(`${repo.name} ${repo.commit.slice(0, 7)} is in ${folder}`);
}
