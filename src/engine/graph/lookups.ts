// The lookups: what the project looks like, where X lives, and what calls or imports X and
// which tests cover it. Each answers from one layer of the graph, and a reference that could
// not be proven is reported as unresolved, never guessed.
import type { Database } from "bun:sqlite";
import { STOPWORDS, splitWords } from "./extract.ts";
import type { Actor } from "../store/index.ts";
import { type Concept, conceptsOn } from "./concepts.ts";

export const MAP_MAX_NODES = 500;
export const FIND_MAX = 50;
const CARD_LIST_MAX = 50;
const SYMBOL_MATCHES_MAX = 10;
const MIN_AND_HITS = 3;
const CALL_EDGES = ["calls", "instantiates", "runs", "sources"];

export type FileNode = { path: string; lane: string; summary: string; lang: string | null; symbols: number };
export type DirNode = { path: string; summary: string; fileCount: number; files?: FileNode[] };
export type MapResult = { root: string; depth: number; dirs: DirNode[]; truncated: boolean };

export type Hit =
  | { kind: "symbol"; name: string; qualifiedName: string; symbolKind: string; path: string; line: number | null; signature: string; doc: string }
  | { kind: "file"; path: string; summary: string; lane: string }
  | { kind: "dir"; path: string; summary: string };

export type SymbolRef = { qualifiedName: string; kind: string; path: string; line: number | null };

export type SymbolCard = {
  symbol: { kind: string; qualifiedName: string; path: string; startLine: number | null; endLine: number | null; signature: string; doc: string; exported: boolean };
  /** Proven references that call, construct, run or source it. */
  callers: SymbolRef[];
  /** Proven imports of it, or of its file when it is a file. */
  importers: SymbolRef[];
  /** What it references, each linked to its definition only on proof. */
  callees: { name: string; edge: string; line: number | null; resolution: string; target: { qualifiedName: string; path: string } | null }[];
  /** Test files that reach it through a proven reference, directly or through one caller. */
  tests: string[];
  /** References that name it but could not be proven to mean it: possible callers, not facts. */
  unresolved: { count: number; sample: SymbolRef[] };
  concepts: { name: string; status: string }[];
};

export type ScopeFile = { path: string; lane: string; summary: string; via: string[] };
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
    "SELECT f.path, f.lane, f.summary, f.lang, (SELECT count(*) FROM symbols s WHERE s.layer = f.layer AND s.path = f.path AND s.kind <> 'module') AS symbols FROM files f WHERE f.layer = ? AND f.dir = ? ORDER BY f.path",
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
    if (row.kind === "module") continue;
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

/** Symbols named `name`, by qualified or short name, ignoring case; modules left out. */
export function symbolsNamed(db: Database, layer: string, name: string, path?: string): SymbolRow[] {
  const rows = db
    .query(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.layer = ? AND s.kind <> 'module'
         AND (s.qualified_name = ? COLLATE NOCASE OR s.name = ? COLLATE NOCASE)
       ORDER BY s.qualified_name = ? DESC, s.name = ? DESC, s.exported DESC, s.path`,
    )
    .all(layer, name, name, name, name) as SymbolRow[];
  return path === undefined ? rows : rows.filter((row) => row.path === path);
}

function moduleOf(db: Database, layer: string, path: string): SymbolRow | null {
  return db.query(`SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.layer = ? AND s.path = ? AND s.kind = 'module'`).get(layer, path) as SymbolRow | null;
}

function fileRow(db: Database, layer: string, path: string): { path: string; summary: string; lane: string } | null {
  return db.query("SELECT path, summary, lane FROM files WHERE layer = ? AND path = ?").get(layer, path) as { path: string; summary: string; lane: string } | null;
}

/** Where X lives: exact names and paths first, then a full-text match over symbols, files and directory summaries. */
export function find(db: Database, layer: string, query: string, k = 10): Hit[] {
  const limit = Math.min(Math.max(k, 1), FIND_MAX);
  const seen = new Set<string>();
  const hits: Hit[] = [];
  const add = (hit: Hit) => {
    const key = hitKey(hit);
    if (seen.has(key) || hits.length >= limit) return;
    seen.add(key);
    hits.push(hit);
  };
  const trimmed = query.trim();
  for (const row of symbolsNamed(db, layer, trimmed)) add(symbolHit(row));
  const file = fileRow(db, layer, trimmed.replace(/^\.\//, ""));
  if (file) add({ kind: "file", ...file });
  const words = queryWords(trimmed);
  if (words.length > 0) {
    let ranked = ftsHits(db, layer, words, "AND", limit * 2);
    if (ranked.length < MIN_AND_HITS && words.length > 1) {
      const more = ftsHits(db, layer, words, "OR", limit * 2);
      ranked = [...ranked, ...more];
    }
    for (const { hit } of ranked) add(hit);
  }
  return hits;
}

// --- symbol card ---

function refsInto(db: Database, ids: readonly number[], kinds: readonly string[]): (SymbolRef & { id: number })[] {
  if (ids.length === 0) return [];
  const rows = db
    .query(
      `SELECT DISTINCT s.id, s.qualified_name, s.kind, s.path, e.line FROM edges e JOIN symbols s ON s.id = e.src_id
        WHERE e.dst_id IN (${placeholders(ids)}) AND e.kind IN (${placeholders(kinds)}) ORDER BY s.path, e.line`,
    )
    .all(...ids, ...kinds) as { id: number; qualified_name: string; kind: string; path: string; line: number | null }[];
  return rows.map((r) => ({ id: r.id, qualifiedName: r.qualified_name, kind: r.kind, path: r.path, line: r.line }));
}

const strip = ({ id: _id, ...ref }: SymbolRef & { id: number }): SymbolRef => ref;

function isTestFile(db: Database, layer: string, path: string): boolean {
  return fileRow(db, layer, path)?.lane === "test";
}

export function symbolCard(db: Database, layer: string, row: SymbolRow): SymbolCard {
  const isModule = row.kind === "module";
  const targetIds = isModule ? (db.query("SELECT id FROM symbols WHERE layer = ? AND path = ?").all(layer, row.path) as { id: number }[]).map((r) => r.id) : [row.id];
  const callers = refsInto(db, isModule ? [row.id] : targetIds, CALL_EDGES).filter((r) => !targetIds.includes(r.id) || !isModule);
  const importers = refsInto(db, targetIds, ["imports"]).filter((r) => r.path !== row.path);
  const callees = (
    db
      .query(
        `SELECT e.dst_name, e.kind, e.line, e.resolution, d.qualified_name AS target_name, d.path AS target_path
           FROM edges e LEFT JOIN symbols d ON d.id = e.dst_id WHERE e.src_id = ? ORDER BY e.line LIMIT ?`,
      )
      .all(row.id, CARD_LIST_MAX) as { dst_name: string; kind: string; line: number | null; resolution: string; target_name: string | null; target_path: string | null }[]
  ).map((e) => ({
    name: e.dst_name,
    edge: e.kind,
    line: e.line,
    resolution: e.resolution,
    target: e.target_name === null ? null : { qualifiedName: e.target_name, path: e.target_path! },
  }));

  const tests = new Set<string>();
  const direct = [...callers, ...importers];
  for (const ref of direct) if (isTestFile(db, layer, ref.path)) tests.add(ref.path);
  const productCallers = direct.filter((ref) => !isTestFile(db, layer, ref.path) && ref.kind !== "module").map((ref) => ref.id);
  for (const ref of refsInto(db, productCallers, [...CALL_EDGES, "imports"])) if (isTestFile(db, layer, ref.path)) tests.add(ref.path);

  const unresolvedRows = isModule
    ? []
    : (db
        .query(
          `SELECT s.qualified_name, s.kind, s.path, e.line FROM edges e JOIN symbols s ON s.id = e.src_id
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
    callers: callers.slice(0, CARD_LIST_MAX).map(strip),
    importers: importers.slice(0, CARD_LIST_MAX).map(strip),
    callees,
    tests: [...tests].sort(),
    unresolved: {
      count: unresolvedRows.length,
      sample: unresolvedRows.slice(0, CARD_LIST_MAX).map((r) => ({ qualifiedName: r.qualified_name, kind: r.kind, path: r.path, line: r.line })),
    },
    concepts: concepts.map((c: Concept) => ({ name: c.name, status: c.status })),
  };
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
export function scope(db: Database, layer: string, input: { objective: string; anchors: string[]; k?: number }): ScopeResult {
  const k = input.k ?? 8;
  const byPath = new Map<string, Set<string>>();
  const add = (path: string, via: string) => {
    const set = byPath.get(path) ?? new Set<string>();
    set.add(via);
    byPath.set(path, set);
  };
  const widen = (row: SymbolRow) => {
    const card = symbolCard(db, layer, row);
    const label = row.kind === "module" ? row.path : row.qualified_name;
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
    const hits = find(db, layer, input.objective, k);
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

  const entries: ScopeFile[] = [];
  for (const [path, via] of byPath) {
    const file = fileRow(db, layer, path);
    if (file) entries.push({ path, lane: file.lane, summary: file.summary, via: [...via].sort() });
  }
  const weight = (f: ScopeFile) => (f.via.includes("anchor") ? 100 : 0) + (f.via.includes("search") ? 10 : 0) + f.via.length;
  entries.sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path));
  const files = entries.filter((f) => f.lane !== "test");
  const tests = entries.filter((f) => f.lane === "test");
  const concepts = conceptsOn(db, files.map((f) => f.path)).map((c) => ({ name: c.name, kind: c.kind, status: c.status, statusReason: c.statusReason }));
  return { files, tests, unresolvedAnchors, concepts, draft: { files: files.map((f) => f.path), tests: tests.map((f) => f.path) } };
}
