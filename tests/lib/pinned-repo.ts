// The public repo the code graph's coverage test also runs on (trustmybot/tmb#247), pinned to
// one commit, so a form of TypeScript tmb's own code does not use is still caught.
//
//   bun tests/lib/pinned-repo.ts [folder]   fetch it at the pinned commit (one shallow fetch)
//
// The test reads it from TMB_PINNED_HONO when set, else from the cache folder below, and is
// skipped, saying why, when the variable is unset and the cache folder missing. The test itself
// never uses the network: CI fetches the repo in a step before `bun test` (.github/workflows/ci.yml).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const PINNED_HONO = {
  url: "https://github.com/honojs/hono.git",
  commit: "75ff8e3ea18485589816881c6278bc9783e56602",
} as const;

/** Where the test looks for the repo: TMB_PINNED_HONO, else the cache folder. */
export function pinnedHonoFolder(): string {
  const fromEnv = process.env.TMB_PINNED_HONO?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(homedir(), ".cache", "tmb", "pinned", `hono-${PINNED_HONO.commit.slice(0, 7)}`);
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 300_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/**
 * The repo's folder when it holds the pinned commit, else why the test cannot run on it: the
 * cache folder missing is a skip; a folder TMB_PINNED_HONO names missing, or one at another
 * commit, is an error.
 */
export function pinnedHono(): { folder: string } | { skip: string } | { error: string } {
  const folder = pinnedHonoFolder();
  const how = `run \`bun tests/lib/pinned-repo.ts\` to fetch it, or set TMB_PINNED_HONO to a checkout of ${PINNED_HONO.url} at ${PINNED_HONO.commit.slice(0, 7)}`;
  if (!existsSync(folder)) {
    // Named on purpose, as CI does: a missing copy is then an error, never a quiet skip.
    if (process.env.TMB_PINNED_HONO?.trim()) return { error: `TMB_PINNED_HONO names ${folder}, which does not exist; ${how}` };
    return { skip: `no copy of hono at ${folder}; ${how}` };
  }
  const head = git(folder, ["rev-parse", "HEAD"]);
  if (!head.ok) return { error: `${folder} is not a git checkout (${head.out}); ${how}` };
  if (head.out !== PINNED_HONO.commit) return { error: `${folder} is at ${head.out.slice(0, 7)}, not the pinned ${PINNED_HONO.commit.slice(0, 7)}; ${how}` };
  return { folder };
}

/** Fetches the pinned commit alone into the folder and checks it out. */
export function fetchPinnedHono(folder = pinnedHonoFolder()): void {
  mkdirSync(folder, { recursive: true });
  const steps: string[][] = [
    ["init", "--quiet"],
    ["fetch", "--quiet", "--depth", "1", PINNED_HONO.url, PINNED_HONO.commit],
    ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "FETCH_HEAD"],
  ];
  if (git(folder, ["rev-parse", "HEAD"]).out === PINNED_HONO.commit) return;
  for (const args of steps) {
    const r = git(folder, args);
    if (!r.ok) throw new Error(`git ${args.join(" ")} failed in ${folder}: ${r.out}`);
  }
}

if (import.meta.main) {
  const folder = process.argv[2] ? path.resolve(process.argv[2]) : pinnedHonoFolder();
  fetchPinnedHono(folder);
  console.log(`hono ${PINNED_HONO.commit.slice(0, 7)} is in ${folder}`);
}
