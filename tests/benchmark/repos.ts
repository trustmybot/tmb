// The benchmark's set (trustmybot/tmb#244), as CODE_GRAPH.md's Benchmark section names it: tmb's
// own repo and public repos at fixed commits, one language each. A language with no module is not
// scored, so Go joins when its module does (trustmybot/tmb#141). The repos are named here and in
// tests/lib/pinned-repo.ts only, never in the graph's code.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PINNED_DATASETTE, PINNED_FLASK, PINNED_HONO, type PinnedRepo, pinnedRepo } from "../lib/pinned-repo.ts";
import type { Language } from "./score.ts";

/** tmb's own repo, whose history holds its pinned commit. */
export const TMB_REPO = path.resolve(import.meta.dir, "../..");

/**
 * tmb's own pin. Every repo is at a fixed commit, tmb's own included (CODE_GRAPH.md, Benchmark):
 * new code in tmb would otherwise move the scores with no change to the graph. The pin moves only
 * in a pull request that runs `bun tests/benchmark/run.ts --write`.
 */
export const TMB_PIN = { name: "tmb", commit: "8ee804de3ced5ccd6555237be8dac8815c70ce04" } as const;

/** A repo of the set: its pinned commit, and the public copy to fetch, or none for tmb's own history. */
export type BenchRepo = { repo: string; language: Language; pinned: { name: string; commit: string }; fetched: PinnedRepo | null };

export const BENCH_REPOS: readonly BenchRepo[] = [
  { repo: TMB_PIN.name, language: "typescript", pinned: TMB_PIN, fetched: null },
  { repo: PINNED_HONO.name, language: "typescript", pinned: PINNED_HONO, fetched: PINNED_HONO },
  { repo: PINNED_FLASK.name, language: "python", pinned: PINNED_FLASK, fetched: PINNED_FLASK },
  { repo: PINNED_DATASETTE.name, language: "python", pinned: PINNED_DATASETTE, fetched: PINNED_DATASETTE },
];

/** Whether a git repo holds a commit. */
function hasCommit(folder: string, commit: string): boolean {
  return spawnSync("git", ["-C", folder, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" }).status === 0;
}

/**
 * Where a repo of the set is, and the commit to measure; or why it cannot be measured. tmb is read
 * from its own history at the pin, never from the working tree. A missing copy or commit is an
 * error: the benchmark never skips a repo and never falls back to another commit.
 */
export function locate(r: BenchRepo): { folder: string; ref: string } | { error: string } {
  if (r.fetched === null) {
    if (hasCommit(TMB_REPO, r.pinned.commit)) return { folder: TMB_REPO, ref: r.pinned.commit };
    return { error: `${TMB_REPO} has no commit ${r.pinned.commit}; fetch tmb's full history (git fetch --unshallow origin)` };
  }
  const found = pinnedRepo(r.fetched);
  if ("folder" in found) return { folder: found.folder, ref: r.pinned.commit };
  return { error: "skip" in found ? found.skip : found.error };
}
