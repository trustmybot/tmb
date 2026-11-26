// The benchmark's scores and their arithmetic (trustmybot/tmb#244), as CODE_GRAPH.md's Benchmark
// section defines them. Nothing here reads a repo: the measures in typescript.ts, python.ts and go.ts
// count, and this file turns counts into shares and compares a run with the stored one.
import { surplus } from "../../src/engine/graph/languages/typescript/coverage.ts";

/** A share: n of `of`. Kept as counts, so two shares compare exactly. `note` says what a reader must know to read it. */
export type Ratio = { n: number; of: number; note?: string; fallAccepted?: FallAccepted };
/** A fall in links found accepted by `--write --accept-fall <issue>`: the issue that caused it and the score it fell from. */
export type FallAccepted = { issue: number; was: { n: number; of: number } };
/** A score that has no value, and why: never a zero. */
export type NotScored = { notScored: string };
export type Score = Ratio | NotScored;

/** The four scores, with links found two ways: from the call states, and against the reference. */
export const SCORE_NAMES = ["functionsFound", "linksRight", "linksFoundByState", "linksFoundByReference", "callsAccountedFor"] as const;
export type ScoreName = (typeof SCORE_NAMES)[number];

/**
 * The scores that may not fall. Links found is scored against the reference (CODE_GRAPH.md,
 * Benchmark); links found from the call states is shown beside it and never enforced, because
 * some calls not known reach outside the repo.
 */
export const ENFORCED: readonly ScoreName[] = SCORE_NAMES.filter((name) => name !== "linksFoundByState");

/** The missing links of the reference, counted by the kind of code that hides them. */
export type Causes = Record<string, number>;

export type WayScores = Record<ScoreName, Score> & { missesByCause: Causes | NotScored };

export const WAYS = ["A", "B"] as const;
export type Way = (typeof WAYS)[number];

export type Language = "typescript" | "python" | "go";

/** One repo's scores: the commit measured, the reference used, and one set per way. */
export type Entry = { repo: string; language: Language; commit: string; reference: string; ways: Record<Way, WayScores> };

/**
 * The version of each language's reference: raised when the reference changes what it counts, so
 * the scores stored before were measured against another reference.
 */
export type ReferenceVersions = Partial<Record<Language, number>>;

/** The version of a language's reference that stored scores with no version were measured against. */
export const FIRST_REFERENCE_VERSION = 1;

/**
 * The stored file: the command that alone writes it, each language's reference version, and one
 * entry per repo and language.
 */
export type Stored = { command: string; referenceVersions?: ReferenceVersions; entries: Entry[] };

const versionOf = (s: Stored, language: Language): number => s.referenceVersions?.[language] ?? FIRST_REFERENCE_VERSION;

/** What a score misses: the reference's items it does not have; for links right, the wrong links. */
const missesOf = (r: Ratio): number => r.of - r.n;

export const isRatio = (s: Score | Causes | NotScored): s is Ratio => "n" in s && "of" in s && typeof s.n === "number";
export const isNotScored = (s: Score | Causes | NotScored): s is NotScored => "notScored" in s;

/** Every score of a way that is not built, with why. */
export function notBuilt(why: string): WayScores {
  const none = { notScored: why };
  return { ...(Object.fromEntries(SCORE_NAMES.map((name) => [name, none])) as Record<ScoreName, Score>), missesByCause: none };
}

/** One repo's entry, with each way's scores. */
export function entry(of: Omit<Entry, "ways">, ways: Record<Way, WayScores>): Entry {
  return { ...of, ways };
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
export type ReferenceCall = { file: string; line: number; pos: number; names: string[]; decls: { file: string; spans: Span[] }[]; cause: string };
/** A call the graph links: its line and its position (where the name it calls is written), the name it records, and the declaration it links. */
export type GraphCall = { file: string; line: number; pos: number; name: string; dst: string; start: number; end: number };

/**
 * Links found against the reference: of the calls the reference declares in the repo, the share
 * the graph links to one of those declarations. A call is identified by its position in the file
 * (CODE_GRAPH.md, "Two ways to make links"): a link finds the reference's call at its file and
 * position, by one of the names the call may be recorded by, and finds one call at most. The
 * calls not found are counted by cause.
 */
export function linksFoundByReference(reference: readonly ReferenceCall[], graph: readonly GraphCall[]): Ratio & { misses: Causes; missed: ReferenceCall[] } {
  const place = (file: string, pos: number, name: string) => `${file}:${pos}:${name}`;
  const byPlace = new Map<string, GraphCall[]>();
  for (const g of graph) {
    const key = place(g.file, g.pos, g.name);
    byPlace.set(key, [...(byPlace.get(key) ?? []), g]);
  }
  const used = new Set<GraphCall>();
  const misses: Causes = {};
  const missed: ReferenceCall[] = [];
  let n = 0;
  for (const call of reference) {
    const overlaps = (g: GraphCall) => call.decls.some((d) => d.file === g.dst && d.spans.some((s) => s.start <= g.end && s.end >= g.start));
    let hit: GraphCall | undefined;
    for (const name of call.names) {
      hit = (byPlace.get(place(call.file, call.pos, name)) ?? []).find((g) => !used.has(g) && overlaps(g));
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
  const accepted = s.fallAccepted === undefined ? "" : `, a fall from ${s.fallAccepted.was.n}/${s.fallAccepted.was.of} accepted in #${s.fallAccepted.issue}`;
  return `${((s.n / s.of) * 100).toFixed(1)}% (${s.n}/${s.of})${s.note === undefined ? "" : `, ${s.note}`}${accepted}`;
}

/** -1, 0 or 1 as share a is below, equal to or above share b, compared exactly. */
function compare(a: Ratio, b: Ratio): number {
  const left = a.n * b.of;
  const right = b.n * a.of;
  return left < right ? -1 : left > right ? 1 : 0;
}

const keyOf = (e: Entry) => `${e.repo} ${e.language}`;

/** Each pair of stored and current scores, for the named scores, with whether the language's reference version changed. */
type Pair = { key: string; way: Way; name: ScoreName; where: string; before: Score; after: Score | undefined; newReference: boolean };
function pairs(stored: Stored, now: Stored, names: readonly ScoreName[]): Pair[] {
  const current = new Map(now.entries.map((e) => [keyOf(e), e]));
  const out: Pair[] = [];
  for (const e of stored.entries) {
    const c = current.get(keyOf(e));
    const newReference = versionOf(stored, e.language) !== versionOf(now, e.language);
    for (const way of WAYS) for (const name of names) out.push({ key: keyOf(e), way, name, where: `${keyOf(e)} way ${way} ${name}`, before: e.ways[way][name], after: c?.ways[way][name], newReference });
  }
  return out;
}

type Fall = { text: string; key?: string; way?: Way; name?: ScoreName; before?: Ratio };

/** Each enforced stored score the current run is below, with where it is; see `falls`. */
function fallsOf(stored: Stored, now: Stored): Fall[] {
  const current = new Set(now.entries.map(keyOf));
  const out: Fall[] = stored.entries.filter((e) => !current.has(keyOf(e))).map((e) => ({ text: `${keyOf(e)}: no longer measured` }));
  for (const { key, way, name, where, before, after, newReference } of pairs(stored, now, ENFORCED)) {
    if (!isRatio(before) || before.of === 0 || after === undefined) continue;
    const at = { key, way, name, before };
    if (!isRatio(after) || after.of === 0) out.push({ ...at, text: `${where}: was ${format(before)}, now ${format(after)}` });
    else if (newReference) {
      if (missesOf(after) > missesOf(before)) out.push({ ...at, text: `${where}: misses rose from ${missesOf(before)} to ${missesOf(after)} under a new reference (${format(before)} to ${format(after)})` });
    } else if (compare(after, before) < 0) out.push({ ...at, text: `${where}: fell from ${format(before)} to ${format(after)}` });
  }
  return out;
}

/**
 * Every enforced stored score the current run is below: a lower share, a share that is no longer
 * scored, or a repo no longer measured. A stored score with no value cannot fall. When the
 * language's reference version changed, the shares were measured against two references, so a
 * score falls only when it misses more than it did; the run is then that language's new baseline.
 */
export function falls(stored: Stored, now: Stored): string[] {
  return fallsOf(stored, now).map((f) => f.text);
}

/** The scores whose fall can be accepted: links found, when a fix removed links that were wrong. */
export const ACCEPTABLE_FALLS: readonly ScoreName[] = ["linksFoundByReference"];

const clone = (s: Stored): Stored => JSON.parse(JSON.stringify(s)) as Stored;

/**
 * The current run with each fall accepted for an issue: "the new score is recorded with the issue
 * that removed them, and links right must still be 100%." Refused when a fall is in a score that
 * cannot be accepted, or when links right is below 100% for the fallen score's repo and way.
 */
export function acceptFalls(stored: Stored, now: Stored, issue: number): { stored: Stored; accepted: string[] } | { refused: string[] } {
  const out = carryAccepted(stored, now);
  const byKey = new Map(out.entries.map((e) => [keyOf(e), e]));
  const refused: string[] = [];
  const accepted: string[] = [];
  for (const f of fallsOf(stored, now)) {
    const e = f.key === undefined ? undefined : byKey.get(f.key);
    if (e === undefined || f.way === undefined || f.name === undefined || f.before === undefined || !ACCEPTABLE_FALLS.includes(f.name)) {
      refused.push(`${f.text}: only a fall in ${ACCEPTABLE_FALLS.join(", ")} can be accepted`);
      continue;
    }
    const right = e.ways[f.way].linksRight;
    if (!isRatio(right) || right.of === 0 || right.n !== right.of) {
      refused.push(`${f.key} way ${f.way} linksRight is ${format(right)}, not 100%, so the fall in ${f.name} is not accepted`);
      continue;
    }
    const after = e.ways[f.way][f.name];
    if (!isRatio(after)) {
      refused.push(`${f.text}: no score to record`);
      continue;
    }
    e.ways[f.way][f.name] = { ...after, fallAccepted: { issue, was: { n: f.before.n, of: f.before.of } } };
    accepted.push(`${f.text}, accepted in #${issue}`);
  }
  return refused.length > 0 ? { refused } : { stored: out, accepted };
}

/** The issue number after `--accept-fall`, null when the flag is absent, or an error. */
export function acceptFallIssue(args: string[]): number | null | { error: string } {
  const at = args.indexOf("--accept-fall");
  if (at < 0) return null;
  const issue = args[at + 1];
  if (issue === undefined || !/^[1-9][0-9]*$/.test(issue)) return { error: "--accept-fall needs the issue number that caused the fall" };
  if (!args.includes("--write")) return { error: "--accept-fall is given with --write" };
  return Number(issue);
}

/** The current run, with each stored accepted fall kept on the score it was recorded on while that score is unchanged. */
export function carryAccepted(stored: Stored, now: Stored): Stored {
  const out = clone(now);
  const before = new Map(stored.entries.map((e) => [keyOf(e), e]));
  for (const e of out.entries) {
    const b = before.get(keyOf(e));
    if (b === undefined) continue;
    for (const way of WAYS)
      for (const name of SCORE_NAMES) {
        const was = b.ways[way][name];
        const is = e.ways[way][name];
        if (isRatio(was) && isRatio(is) && was.fallAccepted !== undefined && was.n === is.n && was.of === is.of) e.ways[way][name] = { ...is, fallAccepted: was.fallAccepted };
      }
  }
  return out;
}

/** Every stored score the current run is above, which the pull request that stores it shows the run for. */
export function rises(stored: Stored, now: Stored): string[] {
  const out: string[] = [];
  for (const { where, before, after } of pairs(stored, now, SCORE_NAMES)) {
    if (after === undefined || !isRatio(after) || after.of === 0) continue;
    if (!isRatio(before) || before.of === 0) out.push(`${where}: now ${format(after)}, was ${format(before)}`);
    else if (compare(after, before) > 0) out.push(`${where}: rose from ${format(before)} to ${format(after)}`);
  }
  return out;
}
