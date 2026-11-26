// The benchmark's set (trustmybot/tmb#244), as CODE_GRAPH.md's Benchmark section names it: tmb's
// own repo and public repos at fixed commits, one language each. A language with no module is not
// scored, so Go joins when its module does (trustmybot/tmb#141). The repos are named here and in
// tests/lib/pinned-repo.ts only, never in the graph's code.
import path from "node:path";
import { PINNED_DATASETTE, PINNED_FLASK, PINNED_HONO, type PinnedRepo, pinnedRepo } from "../lib/pinned-repo.ts";
import type { Language } from "./score.ts";

/** tmb's own repo, measured at its HEAD. */
export const TMB_REPO = path.resolve(import.meta.dir, "../..");

export type BenchRepo = { repo: string; language: Language; pinned: PinnedRepo | null };

export const BENCH_REPOS: readonly BenchRepo[] = [
  { repo: "tmb", language: "typescript", pinned: null },
  { repo: PINNED_HONO.name, language: "typescript", pinned: PINNED_HONO },
  { repo: PINNED_FLASK.name, language: "python", pinned: PINNED_FLASK },
  { repo: PINNED_DATASETTE.name, language: "python", pinned: PINNED_DATASETTE },
];

/** Where a repo of the set is, and at which commit to measure it; or why it cannot be measured. A missing copy is an error: the benchmark never skips a repo. */
export function locate(r: BenchRepo): { folder: string; ref: string } | { error: string } {
  if (r.pinned === null) return { folder: TMB_REPO, ref: "HEAD" };
  const found = pinnedRepo(r.pinned);
  if ("folder" in found) return { folder: found.folder, ref: r.pinned.commit };
  return { error: "skip" in found ? found.skip : found.error };
}
