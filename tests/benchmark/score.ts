// The benchmark's scores and their arithmetic (trustmybot/tmb#244), as CODE_GRAPH.md's Benchmark
// section defines them. Nothing here reads a repo: the measures in typescript.ts and python.ts
// count, and this file turns counts into shares and compares a run with the stored one.
import { surplus } from "../../src/engine/graph/languages/typescript/coverage.ts";

/** A share: n of `of`. Kept as counts, so two shares compare exactly. */
export type Ratio = { n: number; of: number };
/** A score that has no value, and why: never a zero. */
export type NotScored = { notScored: string };
export type Score = Ratio | NotScored;

/** Why way B has no scores yet. */
export const NOT_BUILT = "not built (trustmybot/tmb#311)";

/** The four scores, with links found two ways: from the call states, and against the reference. */
export const SCORE_NAMES = ["functionsFound", "linksRight", "linksFoundByState", "linksFoundByReference", "callsAccountedFor"] as const;
export type ScoreName = (typeof SCORE_NAMES)[number];

/** The missing links of the reference, counted by the kind of code that hides them. */
export type Causes = Record<string, number>;

export type WayScores = Record<ScoreName, Score> & { missesByCause: Causes | NotScored };

export const WAYS = ["A", "B"] as const;
export type Way = (typeof WAYS)[number];

export type Language = "typescript" | "python";

/** One repo's scores: the commit measured, the reference used, and one set per way. */
export type Entry = { repo: string; language: Language; commit: string; reference: string; ways: Record<Way, WayScores> };

/** The stored file: the command that alone writes it, and one entry per repo and language. */
export type Stored = { command: string; entries: Entry[] };

export const isRatio = (s: Score | Causes | NotScored): s is Ratio => "n" in s && "of" in s && typeof s.n === "number";
export const isNotScored = (s: Score | Causes | NotScored): s is NotScored => "notScored" in s;

/** Every score of a way that is not built. */
export function notBuilt(): WayScores {
  const none = { notScored: NOT_BUILT };
  return { ...(Object.fromEntries(SCORE_NAMES.map((name) => [name, none])) as Record<ScoreName, Score>), missesByCause: none };
}

/** One repo's entry, with way A measured and way B not built. */
export function entry(of: Omit<Entry, "ways">, wayA: WayScores): Entry {
  return { ...of, ways: { A: wayA, B: notBuilt() } };
}

/** Links found from the call states: linked of linked plus not known. A call outside the repo can never link, so it is left out. */
export function linksFoundByState(states: { linked: number; outside: number; notKnown: number }): Ratio {
  return { n: states.linked, of: states.linked + states.notKnown };
}

/**
 * Calls accounted for: of the calls the reference finds in each function (or outside every
 * function, for the file), those the graph holds a state for in the same place, less the calls it
 * puts outside the repo that the reference declares in it.
 */
export function callsAccountedFor(reference: ReadonlyMap<string, number>, graph: ReadonlyMap<string, number>, outsideWrong = 0): Ratio {
  let n = 0;
  let of = 0;
  for (const [where, calls] of reference) {
    of += calls;
    n += Math.min(calls, graph.get(where) ?? 0);
  }
  return { n: Math.max(0, n - outsideWrong), of };
}

/** Functions found: of the reference's functions, by file and lines, the share the graph has. */
export function functionsFound(reference: ReadonlyMap<string, readonly string[]>, graph: ReadonlyMap<string, readonly string[]>): Ratio {
  let n = 0;
  let of = 0;
  for (const [file, want] of reference) {
    of += want.length;
    n += want.length - surplus(want, graph.get(file) ?? []).length;
  }
  return { n, of };
}

type Span = { start: number; end: number };

/** A call the reference declares in the repo: where it is, the names the graph may record it by, its declarations, and the kind of code it is. */
export type ReferenceCall = { file: string; lines: number[]; names: string[]; decls: { file: string; spans: Span[] }[]; cause: string };
/** A call the graph links: where it is written, the name it records, and the declaration it links. */
export type GraphCall = { file: string; line: number; name: string; dst: string; start: number; end: number };

/**
 * Links found against the reference: of the calls the reference declares in the repo, the share
 * the graph links to one of those declarations. Each link of the graph finds one call at most. The
 * calls not found are counted by cause.
 */
export function linksFoundByReference(reference: readonly ReferenceCall[], graph: readonly GraphCall[]): Ratio & { misses: Causes; missed: ReferenceCall[] } {
  const byPlace = new Map<string, GraphCall[]>();
  for (const g of graph) {
    const key = `${g.file}:${g.line}:${g.name}`;
    byPlace.set(key, [...(byPlace.get(key) ?? []), g]);
  }
  const used = new Set<GraphCall>();
  const misses: Causes = {};
  const missed: ReferenceCall[] = [];
  let n = 0;
  for (const call of reference) {
    const overlaps = (g: GraphCall) => call.decls.some((d) => d.file === g.dst && d.spans.some((s) => s.start <= g.end && s.end >= g.start));
    let hit: GraphCall | undefined;
    for (const line of call.lines) {
      for (const name of call.names) {
        hit = (byPlace.get(`${call.file}:${line}:${name}`) ?? []).find((g) => !used.has(g) && overlaps(g));
        if (hit !== undefined) break;
      }
      if (hit !== undefined) break;
    }
    if (hit !== undefined) {
      used.add(hit);
      n++;
    } else {
      misses[call.cause] = (misses[call.cause] ?? 0) + 1;
      missed.push(call);
    }
  }
  return { n, of: reference.length, misses: sortCauses(misses), missed };
}

/** Causes, largest first, so the next fix is chosen by size. */
export function sortCauses(causes: Causes): Causes {
  return Object.fromEntries(Object.entries(causes).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)));
}

/** A score for a reader: a share with its counts, "none" for a share of nothing, else why it has no value. */
export function format(s: Score): string {
  if (!isRatio(s)) return s.notScored;
  if (s.of === 0) return "none";
  return `${((s.n / s.of) * 100).toFixed(1)}% (${s.n}/${s.of})`;
}

/** -1, 0 or 1 as share a is below, equal to or above share b, compared exactly. */
function compare(a: Ratio, b: Ratio): number {
  const left = a.n * b.of;
  const right = b.n * a.of;
  return left < right ? -1 : left > right ? 1 : 0;
}

const keyOf = (e: Entry) => `${e.repo} ${e.language}`;

/** Each pair of stored and current scores that both hold a share. */
function pairs(stored: Stored, now: Stored): { where: string; before: Score; after: Score | undefined }[] {
  const current = new Map(now.entries.map((e) => [keyOf(e), e]));
  const out: { where: string; before: Score; after: Score | undefined }[] = [];
  for (const e of stored.entries) {
    const c = current.get(keyOf(e));
    for (const way of WAYS) for (const name of SCORE_NAMES) out.push({ where: `${keyOf(e)} way ${way} ${name}`, before: e.ways[way][name], after: c?.ways[way][name] });
  }
  return out;
}

/**
 * Every stored score the current run is below: a lower share, a share that is no longer scored, or
 * a repo no longer measured. A stored score with no value cannot fall.
 */
export function falls(stored: Stored, now: Stored): string[] {
  const current = new Set(now.entries.map(keyOf));
  const out = stored.entries.filter((e) => !current.has(keyOf(e))).map((e) => `${keyOf(e)}: no longer measured`);
  for (const { where, before, after } of pairs(stored, now)) {
    if (!isRatio(before) || before.of === 0 || after === undefined) continue;
    if (!isRatio(after) || after.of === 0) out.push(`${where}: was ${format(before)}, now ${format(after)}`);
    else if (compare(after, before) < 0) out.push(`${where}: fell from ${format(before)} to ${format(after)}`);
  }
  return out;
}

/** Every stored score the current run is above, which the pull request that stores it shows the run for. */
export function rises(stored: Stored, now: Stored): string[] {
  const out: string[] = [];
  for (const { where, before, after } of pairs(stored, now)) {
    if (after === undefined || !isRatio(after) || after.of === 0) continue;
    if (!isRatio(before) || before.of === 0) out.push(`${where}: now ${format(after)}, was ${format(before)}`);
    else if (compare(after, before) > 0) out.push(`${where}: rose from ${format(before)} to ${format(after)}`);
  }
  return out;
}
