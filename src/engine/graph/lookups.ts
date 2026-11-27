// The lookups: what the project looks like, where X lives, and what calls or imports X and
// which tests cover it. Each answers from one layer of the graph, and a reference that could
// not be proven is reported as unresolved, never guessed.
import type { Database } from "bun:sqlite";
import { STOPWORDS, splitWords } from "./extract.ts";
import { SYMBOL_KINDS } from "./languages/contract.ts";
import type { Actor } from "../store/index.ts";
import { areasOf } from "./areas.ts";
import { type Concept, conceptsOn } from "./concepts.ts";
import type { CallState } from "./resolve.ts";

export const MAP_MAX_NODES = 500;
export const FIND_MAX = 50;
/** The most rows of distinct callers, importers or callees a card lists; the rest are counted. */
export const CARD_LIST_MAX = 50;
/** The most lines one row lists; the rest are counted. */
export const ROW_LINES_MAX = 10;
const SYMBOL_MATCHES_MAX = 10;
const MIN_AND_HITS = 3;
const CALL_EDGES = ["calls", "instantiates", "runs", "sources"];

export type FileNode = { path: string; lane: string; summary: string; lang: string | null; symbols: number };
export type DirNode = { path: string; summary: string; fileCount: number; files?: FileNode[] };
export type MapResult = { root: string; depth: number; dirs: DirNode[]; truncated: boolean };

/** Keeps a path in a search or a scope; built from the areas to look in and to leave out. */
export type PathFilter = (path: string) => boolean;

/** Hits on a symbol or a file name the file's areas, its main area first. */
export type Hit =
  | { kind: "symbol"; name: string; qualifiedName: string; symbolKind: string; path: string; line: number | null; signature: string; doc: string; areas?: string[] }
  | { kind: "file"; path: string; summary: string; lane: string; areas?: string[] }
  | { kind: "dir"; path: string; summary: string };

export type SymbolRef = { qualifiedName: string; kind: string; path: string; line: number | null };

/** One caller or importer, listed once with the lines it refers from: the first few, and a count of the rest. */
export type RefRow = { qualifiedName: string; kind: string; path: string; lines: number[]; moreLines: number };

/** One thing a symbol refers to, listed once with the lines it is referred to on. */
export type CalleeRow = {
  name: string;
  edge: string;
  resolution: string;
  target: { qualifiedName: string; path: string } | null;
  lines: number[];
  moreLines: number;
};

/** The calls written in a symbol, by state (trustmybot/tmb#252); the three add up to every call written there. */
export type CallCounts = { linked: number; outside: number; notKnown: number };

export type SymbolCard = {
  symbol: { kind: string; qualifiedName: string; path: string; startLine: number | null; endLine: number | null; signature: string; doc: string; exported: boolean };
  /** Proven references that call, construct, run or source it, one row per caller. */
  callers: RefRow[];
  /** Proven imports of it, or of its file when it is a file, one row per importer. */
  importers: RefRow[];
  /** What it references, one row each, linked to its definition only on proof. */
  callees: CalleeRow[];
  /** How many distinct callers, importers and callees were left out past the cap. */
  more: { callers: number; importers: number; callees: number };
  /**
   * The calls written in it and in the unnamed functions inside it, by state: linked to the repo's
   * code, to code outside the repo (built-ins and packages), and not known (trustmybot/tmb#252).
   */
  calls: CallCounts;
  /** One line when some of its calls are not known, so the reader searches its body for the rest. */
  callsNote?: string;
  /** Test files that reach it through a proven reference, directly or through one caller. */
  tests: string[];
  /** References that name it but could not be proven to mean it: possible callers, not facts. */
  unresolved: { count: number; sample: SymbolRef[] };
  concepts: { name: string; status: string }[];
  /** The areas of its file, the main one first; a symbol takes its file's areas. */
  areas: string[];
};

export type ScopeFile = { path: string; lane: string; summary: string; via: string[]; areas: string[] };
export type ScopeResult = {
  files: ScopeFile[];
  tests: ScopeFile[];
  unresolvedAnchors: string[];
  concepts: { name: string; kind: string; status: string; statusReason: string | null }[];
  /** A first draft of the task's files, to check and edit before task_start. */
  draft: { files: string[]; tests: string[] };
};

type SymbolRow = {
  id: number;
  path: string;
  kind: string;
  qualified_name: string;
  name: string;
  signature: string;
  doc: string;
  start_line: number | null;
  end_line: number | null;
  exported: number;
};

const SYMBOL_COLUMNS = "s.id, s.path, s.kind, s.qualified_name, s.name, s.signature, s.doc, s.start_line, s.end_line, s.exported";

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

/** Records a lookup that found nothing, or an answer an agent reports as wrong, so the graph's value can be measured. */
export function recordMiss(db: Database, actor: Actor, lookup: string, query: string, detail = ""): void {
  db.run("INSERT INTO misses (at, lookup, query, detail, actor) VALUES (?, ?, ?, ?, ?)", [new Date().toISOString(), lookup, query, detail, JSON.stringify(actor)]);
}

export function countMisses(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM misses").get() as { n: number }).n;
}

// --- map ---

export function projectMap(db: Database, layer: string, options: { path?: string; depth?: number }): MapResult {
  const root = (options.path ?? ".").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  const depth = options.depth ?? 2;
  const rootRow = db.query("SELECT depth FROM dirs WHERE layer = ? AND path = ?").get(layer, root) as { depth: number } | null;
  if (rootRow === null) return { root, depth, dirs: [], truncated: false };
  const prefix = root === "." ? "" : `${root}/`;
  const rows = db
    .query("SELECT path, summary, file_count, depth FROM dirs WHERE layer = ? AND (path = ? OR path LIKE ? ESCAPE '\\') AND depth <= ? ORDER BY path")
    .all(layer, root, `${prefix.replace(/[\\%_]/g, "\\$&")}%`, rootRow.depth + depth - 1) as { path: string; summary: string; file_count: number; depth: number }[];
  const fileQuery = db.query(
    `SELECT f.path, f.lane, f.summary, f.lang, (SELECT count(*) FROM symbols s WHERE s.layer = f.layer AND s.path = f.path AND s.kind <> '${SYMBOL_KINDS.file}' AND s.unnamed = 0) AS symbols FROM files f WHERE f.layer = ? AND f.dir = ? ORDER BY f.path`,
  );
  const dirs: DirNode[] = [];
  let nodes = 0;
  let truncated = false;
  for (const row of rows) {
    if (nodes >= MAP_MAX_NODES) {
      truncated = true;
      break;
    }
    const node: DirNode = { path: row.path, summary: row.summary, fileCount: row.file_count };
    nodes++;
    if (row.depth < rootRow.depth + depth - 1 || depth === 1) {
      const files = fileQuery.all(layer, row.path) as FileNode[];
      const room = Math.max(0, MAP_MAX_NODES - nodes);
      if (files.length > room) truncated = true;
      node.files = files.slice(0, room);
      nodes += node.files.length;
    }
    dirs.push(node);
  }
  return { root, depth, dirs, truncated };
}

// --- find ---

function queryWords(query: string): string[] {
  return [...new Set(splitWords(query).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}

function ftsQuery(words: string[], joiner: "AND" | "OR"): string {
  return words.map((w) => `"${w}"*`).join(` ${joiner} `);
}

function symbolHit(row: SymbolRow): Hit {
  return { kind: "symbol", name: row.name, qualifiedName: row.qualified_name, symbolKind: row.kind, path: row.path, line: row.start_line, signature: row.signature, doc: row.doc };
}

function hitKey(hit: Hit): string {
  return hit.kind === "symbol" ? `s:${hit.path}#${hit.qualifiedName}` : `${hit.kind}:${hit.path}`;
}

function ftsHits(db: Database, layer: string, words: string[], joiner: "AND" | "OR", limit: number): { hit: Hit; rank: number }[] {
  const match = ftsQuery(words, joiner);
  const out: { hit: Hit; rank: number }[] = [];
  const symbols = db
    .query(
      `SELECT ${SYMBOL_COLUMNS}, bm25(symbols_fts) AS rank FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.symbol_id
        WHERE symbols_fts MATCH ? AND symbols_fts.layer = ? ORDER BY rank LIMIT ?`,
    )
    .all(match, layer, limit) as (SymbolRow & { rank: number })[];
  for (const row of symbols) {
    if (row.kind === SYMBOL_KINDS.file) continue;
    out.push({ hit: symbolHit(row), rank: row.rank });
  }
  const files = db
    .query(
      `SELECT f.path, f.summary, f.lane, bm25(files_fts) AS rank FROM files_fts JOIN files f ON f.layer = files_fts.layer AND f.path = files_fts.path
        WHERE files_fts MATCH ? AND files_fts.layer = ? ORDER BY rank LIMIT ?`,
    )
    .all(match, layer, limit) as { path: string; summary: string; lane: string; rank: number }[];
  for (const row of files) out.push({ hit: { kind: "file", path: row.path, summary: row.summary, lane: row.lane }, rank: row.rank });
  const dirs = db
    .query(
      `SELECT d.path, d.summary, bm25(dirs_fts) AS rank FROM dirs_fts JOIN dirs d ON d.layer = dirs_fts.layer AND d.path = dirs_fts.path
        WHERE dirs_fts MATCH ? AND dirs_fts.layer = ? ORDER BY rank LIMIT ?`,
    )
    .all(match, layer, limit) as { path: string; summary: string; rank: number }[];
  for (const row of dirs) out.push({ hit: { kind: "dir", path: row.path, summary: row.summary }, rank: row.rank });
  return out.sort((a, b) => a.rank - b.rank);
}

/** Symbols named `name`, by qualified or short name, ignoring case; files and unnamed functions left out. */
export function symbolsNamed(db: Database, layer: string, name: string, path?: string): SymbolRow[] {
  const rows = db
    .query(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.layer = ? AND s.kind <> '${SYMBOL_KINDS.file}' AND s.unnamed = 0
         AND (s.qualified_name = ? COLLATE NOCASE OR s.name = ? COLLATE NOCASE)
       ORDER BY s.qualified_name = ? DESC, s.name = ? DESC, s.exported DESC, s.path`,
    )
    .all(layer, name, name, name, name) as SymbolRow[];
  return path === undefined ? rows : rows.filter((row) => row.path === path);
}

function moduleOf(db: Database, layer: string, path: string): SymbolRow | null {
  return db.query(`SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.layer = ? AND s.path = ? AND s.kind = '${SYMBOL_KINDS.file}'`).get(layer, path) as SymbolRow | null;
}

function fileRow(db: Database, layer: string, path: string): { path: string; summary: string; lane: string } | null {
  return db.query("SELECT path, summary, lane FROM files WHERE layer = ? AND path = ?").get(layer, path) as { path: string; summary: string; lane: string } | null;
}

/** Where X lives: exact names and paths first, then a full-text match over symbols, files and directory summaries. */
export function find(db: Database, layer: string, query: string, k = 10, filter: PathFilter | null = null): Hit[] {
  const limit = Math.min(Math.max(k, 1), FIND_MAX);
  // A filter drops hits after ranking, so it ranks more of them to fill the list.
  const ranked = filter === null ? limit * 2 : limit * 8;
  const seen = new Set<string>();
  const hits: Hit[] = [];
  const add = (hit: Hit) => {
    const key = hitKey(hit);
    if (seen.has(key) || hits.length >= limit) return;
    // A directory is in no area; a search narrowed to areas lists files and symbols only.
    if (filter !== null && (hit.kind === "dir" || !filter(hit.path))) return;
    seen.add(key);
    hits.push(hit);
  };
  const trimmed = query.trim();
  for (const row of symbolsNamed(db, layer, trimmed)) add(symbolHit(row));
  const file = fileRow(db, layer, trimmed.replace(/^\.\//, ""));
  if (file) add({ kind: "file", ...file });
  const words = queryWords(trimmed);
  if (words.length > 0) {
    let found = ftsHits(db, layer, words, "AND", ranked);
    if (found.length < MIN_AND_HITS && words.length > 1) {
      const more = ftsHits(db, layer, words, "OR", ranked);
      found = [...found, ...more];
    }
    for (const { hit } of found) add(hit);
  }
  const areas = areasOf(db, [...new Set(hits.filter((h) => h.kind !== "dir").map((h) => h.path))]);
  return hits.map((hit) => (hit.kind === "dir" ? hit : { ...hit, areas: areas.get(hit.path) ?? [] }));
}

// --- symbol card ---

// A reference made inside an unnamed function is reported from the nearest named symbol around it.
const NAMED_SOURCE = "JOIN symbols src ON src.id = e.src_id JOIN symbols s ON s.id = COALESCE(src.named_id, src.id)";

function refsInto(db: Database, ids: readonly number[], kinds: readonly string[]): (SymbolRef & { id: number })[] {
  if (ids.length === 0) return [];
  const rows = db
    .query(
      `SELECT DISTINCT s.id, s.qualified_name, s.kind, s.path, e.line FROM edges e ${NAMED_SOURCE}
        WHERE e.dst_id IN (${placeholders(ids)}) AND e.kind IN (${placeholders(kinds)}) ORDER BY s.path, e.line`,
    )
    .all(...ids, ...kinds) as { id: number; qualified_name: string; kind: string; path: string; line: number | null }[];
  return rows.map((r) => ({ id: r.id, qualifiedName: r.qualified_name, kind: r.kind, path: r.path, line: r.line }));
}

/** Groups rows by key, keeping first-seen order, each group with its distinct lines in order. */
function grouped<T>(rows: readonly T[], key: (row: T) => string, line: (row: T) => number | null): { first: T; lines: number[] }[] {
  const groups = new Map<string, { first: T; lines: Set<number> }>();
  for (const row of rows) {
    const k = key(row);
    let group = groups.get(k);
    if (group === undefined) {
      group = { first: row, lines: new Set() };
      groups.set(k, group);
    }
    const at = line(row);
    if (at !== null) group.lines.add(at);
  }
  return [...groups.values()].map((g) => ({ first: g.first, lines: [...g.lines].sort((a, b) => a - b) }));
}

const cutLines = (lines: number[]): { lines: number[]; moreLines: number } => ({ lines: lines.slice(0, ROW_LINES_MAX), moreLines: Math.max(0, lines.length - ROW_LINES_MAX) });

/** One row per referring symbol (or file), with its lines. */
function refRows(refs: readonly (SymbolRef & { id: number })[]): RefRow[] {
  return grouped(refs, (r) => String(r.id), (r) => r.line).map(({ first, lines }) => ({
    qualifiedName: first.qualifiedName,
    kind: first.kind,
    path: first.path,
    ...cutLines(lines),
  }));
}

function isTestFile(db: Database, layer: string, path: string): boolean {
  return fileRow(db, layer, path)?.lane === "test";
}

export function symbolCard(db: Database, layer: string, row: SymbolRow): SymbolCard {
  const isModule = row.kind === SYMBOL_KINDS.file;
  const targetIds = isModule ? (db.query("SELECT id FROM symbols WHERE layer = ? AND path = ?").all(layer, row.path) as { id: number }[]).map((r) => r.id) : [row.id];
  const callers = refsInto(db, isModule ? [row.id] : targetIds, CALL_EDGES).filter((r) => !targetIds.includes(r.id) || !isModule);
  const importers = refsInto(db, targetIds, ["imports"]).filter((r) => r.path !== row.path);
  const calleeEdges = db
    .query(
      `SELECT e.dst_name, e.kind, e.line, e.resolution, e.dst_id, d.qualified_name AS target_name, d.path AS target_path
         FROM edges e LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE e.src_id = ? OR e.src_id IN (SELECT id FROM symbols WHERE named_id = ?) ORDER BY e.line`,
    )
    .all(row.id, row.id) as { dst_name: string; kind: string; line: number | null; resolution: string; dst_id: number | null; target_name: string | null; target_path: string | null }[];
  const callees = grouped(
    calleeEdges,
    (e) => JSON.stringify([e.dst_name, e.kind, e.resolution, e.dst_id]),
    (e) => e.line,
  ).map(({ first: e, lines }): CalleeRow => ({
    name: e.dst_name,
    edge: e.kind,
    resolution: e.resolution,
    target: e.target_name === null ? null : { qualifiedName: e.target_name, path: e.target_path! },
    ...cutLines(lines),
  }));
  const calls = callCounts(db, row.id);
  const callerRows = refRows(callers);
  const importerRows = refRows(importers);

  const tests = new Set<string>();
  const direct = [...callers, ...importers];
  for (const ref of direct) if (isTestFile(db, layer, ref.path)) tests.add(ref.path);
  const productCallers = direct.filter((ref) => !isTestFile(db, layer, ref.path) && ref.kind !== SYMBOL_KINDS.file).map((ref) => ref.id);
  for (const ref of refsInto(db, productCallers, [...CALL_EDGES, "imports"])) if (isTestFile(db, layer, ref.path)) tests.add(ref.path);

  const unresolvedRows = isModule
    ? []
    : (db
        .query(
          `SELECT s.qualified_name, s.kind, s.path, e.line FROM edges e ${NAMED_SOURCE}
            WHERE e.layer = ? AND e.dst_name = ? AND e.resolution = 'unresolved' AND e.kind <> 'imports' ORDER BY s.path, e.line`,
        )
        .all(layer, row.name) as { qualified_name: string; kind: string; path: string; line: number | null }[]);
  const concepts = conceptsOn(db, [row.path]).filter((c) => isModule || c.anchors.some((a) => a.path === row.path && (a.qualifiedName === "" || a.qualifiedName === row.qualified_name)));
  return {
    symbol: {
      kind: row.kind,
      qualifiedName: row.qualified_name,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      signature: row.signature,
      doc: row.doc,
      exported: row.exported === 1,
    },
    callers: callerRows.slice(0, CARD_LIST_MAX),
    importers: importerRows.slice(0, CARD_LIST_MAX),
    callees: callees.slice(0, CARD_LIST_MAX),
    more: {
      callers: Math.max(0, callerRows.length - CARD_LIST_MAX),
      importers: Math.max(0, importerRows.length - CARD_LIST_MAX),
      callees: Math.max(0, callees.length - CARD_LIST_MAX),
    },
    calls,
    ...(calls.notKnown > 0 ? { callsNote: callsNote(calls) } : {}),
    tests: [...tests].sort(),
    unresolved: {
      count: unresolvedRows.length,
      sample: unresolvedRows.slice(0, CARD_LIST_MAX).map((r) => ({ qualifiedName: r.qualified_name, kind: r.kind, path: r.path, line: r.line })),
    },
    concepts: concepts.map((c: Concept) => ({ name: c.name, status: c.status })),
    areas: areasOf(db, [row.path]).get(row.path) ?? [],
  };
}

/**
 * The calls written in a symbol and in the unnamed functions it owns, by state (trustmybot/tmb#252):
 * a call in an unnamed function is that function's own, and its owner's answer sums them.
 */
export function callCounts(db: Database, id: number): CallCounts {
  const rows = db
    .query(
      `SELECT call_state AS state, count(*) AS n FROM edges
        WHERE (src_id = ? OR src_id IN (SELECT id FROM symbols WHERE named_id = ?)) AND call_state IS NOT NULL GROUP BY call_state`,
    )
    .all(id, id) as { state: CallState; n: number }[];
  return countsOf(rows);
}

/** Call counts from rows of a call state and how many calls are in it. */
export function countsOf(rows: { state: CallState; n: number }[]): CallCounts {
  const n = (state: CallState) => rows.find((r) => r.state === state)?.n ?? 0;
  return { linked: n("linked"), outside: n("outside"), notKnown: n("not_known") };
}

/** "Calls not known: 3 of 10. …", for a symbol with calls not known. */
export function callsNote(calls: CallCounts): string {
  const total = calls.linked + calls.outside + calls.notKnown;
  return `Calls not known: ${calls.notKnown} of ${total}. The graph could not prove where they go; search its body by text for them.`;
}

/** Cards for every symbol named `name` (or the file at that path), at most ten. */
export function lookupSymbol(db: Database, layer: string, name: string, path?: string): { cards: SymbolCard[]; more: number } {
  const trimmed = name.trim().replace(/^\.\//, "");
  const module = moduleOf(db, layer, trimmed);
  const rows = module ? [module] : symbolsNamed(db, layer, trimmed, path);
  return { cards: rows.slice(0, SYMBOL_MATCHES_MAX).map((row) => symbolCard(db, layer, row)), more: Math.max(0, rows.length - SYMBOL_MATCHES_MAX) };
}

// --- scope ---

/** The files in scope for a task: seeded by the objective's search and by named anchors, widened by their callers, importers and tests. */
export function scope(db: Database, layer: string, input: { objective: string; anchors: string[]; k?: number; filter?: PathFilter | null }): ScopeResult {
  const filter = input.filter ?? null;
  const k = input.k ?? 8;
  const byPath = new Map<string, Set<string>>();
  const add = (path: string, via: string) => {
    const set = byPath.get(path) ?? new Set<string>();
    set.add(via);
    byPath.set(path, set);
  };
  const widen = (row: SymbolRow) => {
    const card = symbolCard(db, layer, row);
    const label = row.kind === SYMBOL_KINDS.file ? row.path : row.qualified_name;
    for (const ref of card.callers) add(ref.path, `caller:${label}`);
    for (const ref of card.importers) add(ref.path, `import:${label}`);
    for (const test of card.tests) add(test, `test:${label}`);
  };

  const unresolvedAnchors: string[] = [];
  for (const anchor of input.anchors) {
    const text = anchor.trim().replace(/^\.\//, "");
    const module = moduleOf(db, layer, text);
    const file = fileRow(db, layer, text);
    if (module || file) {
      add(text, "anchor");
      if (module) widen(module);
      continue;
    }
    const hash = text.indexOf("#");
    const rows = hash > 0 ? symbolsNamed(db, layer, text.slice(hash + 1), text.slice(0, hash)) : symbolsNamed(db, layer, text);
    if (rows.length === 0) {
      unresolvedAnchors.push(anchor);
      continue;
    }
    for (const row of rows.slice(0, SYMBOL_MATCHES_MAX)) {
      add(row.path, "anchor");
      widen(row);
    }
  }

  if (input.objective.trim() !== "") {
    const hits = find(db, layer, input.objective, k, filter);
    let widened = 0;
    for (const hit of hits) {
      if (hit.kind === "dir") continue;
      add(hit.path, "search");
      if (hit.kind === "symbol" && widened < 3) {
        const row = symbolsNamed(db, layer, hit.qualifiedName, hit.path)[0];
        if (row) {
          widen(row);
          widened++;
        }
      }
    }
  }

  // Anchors are named on purpose and stay; the files they bring in are kept to the asked areas.
  const kept = [...byPath].filter(([path, via]) => filter === null || via.has("anchor") || filter(path));
  const areas = areasOf(db, kept.map(([path]) => path));
  const entries: ScopeFile[] = [];
  for (const [path, via] of kept) {
    const file = fileRow(db, layer, path);
    if (file) entries.push({ path, lane: file.lane, summary: file.summary, via: [...via].sort(), areas: areas.get(path) ?? [] });
  }
  const weight = (f: ScopeFile) => (f.via.includes("anchor") ? 100 : 0) + (f.via.includes("search") ? 10 : 0) + f.via.length;
  entries.sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path));
  const files = entries.filter((f) => f.lane !== "test");
  const tests = entries.filter((f) => f.lane === "test");
  const concepts = conceptsOn(db, files.map((f) => f.path)).map((c) => ({ name: c.name, kind: c.kind, status: c.status, statusReason: c.statusReason }));
  return { files, tests, unresolvedAnchors, concepts, draft: { files: files.map((f) => f.path), tests: tests.map((f) => f.path) } };
}
