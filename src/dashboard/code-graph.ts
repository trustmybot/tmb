// The code graph page's data: the project's graph at its base branch, one level at a time.
// Folders, then a folder's files, then a file's classes and functions with the ones inside them,
// and one function with its callers and what it calls. Nothing here draws every function at
// once, and nothing here writes: the page reads the same graph the agents' lookups read.
import type { Database } from "bun:sqlite";
import { areasOf, type CallCounts, type CallState, countsOf, FUNCTION_KINDS, listAreas, SYMBOL_KINDS, type SymbolCard, symbolCard } from "../engine/index.ts";

const KIND_LIST = [...FUNCTION_KINDS];
const FUNCTION_IN = KIND_LIST.map(() => "?").join(", ");
/** The links drawn between folders and files: proven calls and proven imports. */
const CALL_KINDS = ["calls", "instantiates", "runs", "sources"];
const LINK_KINDS = [...CALL_KINDS, "imports"];
export const SEARCH_MAX = 30;

/**
 * A child's area is its main area: for a file the first of its areas, for a folder the one main
 * area every file under it shares, else null. The page draws each area as a box around its children.
 */
export type TreeChild =
  | { kind: "dir"; path: string; name: string; files: number; functions: number; area: string | null }
  | { kind: "file"; path: string; name: string; lang: string | null; lane: string; functions: number; notParsed: string | null; area: string | null };

/** Proven links between two children of the folder: calls and imports, counted. */
export type TreeLink = { from: string; to: string; calls: number; imports: number };

export type TreeArea = { name: string; purpose: string; parent: string | null; status: string };

export type TreeResult = { path: string; functions: number; children: TreeChild[]; links: TreeLink[]; areas: TreeArea[] };

export type FileSymbol = {
  id: number;
  kind: string;
  name: string;
  qualifiedName: string;
  unnamed: boolean;
  /** The class or function it sits inside; null at the top of the file. */
  parent: number | null;
  startLine: number | null;
  endLine: number | null;
  signature: string;
  /** Calls made inside it that could not be proven to mean one definition. */
  unresolved: number;
  /** Proven calls made inside it to definitions in other files. */
  callsOut: number;
  /** The calls written in it, not in the unnamed functions inside it, by state (trustmybot/tmb#252). */
  calls: CallCounts;
};

export type FileResult = {
  path: string;
  lang: string | null;
  lane: string;
  notParsed: string | null;
  /** The file's areas, its main one first; each of its functions is in them too. */
  areas: string[];
  functions: number;
  symbols: FileSymbol[];
  /** Proven calls between the symbols of this file. */
  links: { from: number; to: number; count: number }[];
};

/** One caller or callee, listed once with its lines (the first few, and a count of the rest), and the id to open it by. */
export type NodeRef = { id: number | null; qualifiedName: string; kind: string; path: string; lines: number[]; moreLines: number };

export type FunctionResult = {
  id: number;
  name: string;
  unnamed: boolean;
  parent: number | null;
  card: SymbolCard;
  /** The card's callers, each with the id to open it by; a file-level caller has no id. */
  callers: NodeRef[];
  /** The card's proven callees, each with its id. */
  callees: NodeRef[];
  /** How many distinct callers and callees the card left out past its cap. */
  more: { callers: number; callees: number };
  /** References made inside it that could not be proven. */
  unresolved: number;
};

export type SearchHit = { id: number; name: string; qualifiedName: string; kind: string; path: string; line: number | null; unnamed: boolean };

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The child of `dir` that holds `path`, or null when `path` is not under `dir`. */
export function childOf(dir: string, path: string): string | null {
  if (dir === ".") {
    const slash = path.indexOf("/");
    return slash === -1 ? path : path.slice(0, slash);
  }
  if (!path.startsWith(`${dir}/`)) return null;
  const slash = path.indexOf("/", dir.length + 1);
  return slash === -1 ? path : path.slice(0, slash);
}

function functionCounts(db: Database, layer: string): Map<string, number> {
  const rows = db.query(`SELECT path, count(*) AS n FROM symbols WHERE layer = ? AND kind IN (${FUNCTION_IN}) GROUP BY path`).all(layer, ...KIND_LIST) as { path: string; n: number }[];
  return new Map(rows.map((r) => [r.path, r.n]));
}

/** Why a file of a known language holds no symbols, or null when it was parsed. */
function notParsedReason(db: Database, layer: string, file: { path: string; lang: string | null; parse_error: string | null }): string | null {
  if (file.lang === null) return null;
  const module = db.query(`SELECT 1 FROM symbols WHERE layer = ? AND path = ? AND kind = '${SYMBOL_KINDS.file}'`).get(layer, file.path);
  return module ? null : (file.parse_error ?? "not parsed");
}

/** One folder: its subfolders and files, how many functions each holds, and the proven links between them. */
export function tree(db: Database, layer: string, dir: string): TreeResult | null {
  const path = dir === "" ? "." : dir.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!db.query("SELECT 1 FROM dirs WHERE layer = ? AND path = ?").get(layer, path)) return null;
  const counts = functionCounts(db, layer);
  const byChild = new Map<string, number>();
  let total = 0;
  for (const [file, n] of counts) {
    const child = childOf(path, file);
    if (child === null) continue;
    byChild.set(child, (byChild.get(child) ?? 0) + n);
    total += n;
  }
  const dirs = db.query("SELECT path, file_count FROM dirs WHERE layer = ? AND parent = ? ORDER BY path").all(layer, path) as { path: string; file_count: number }[];
  const files = db.query("SELECT path, lang, lane, parse_error FROM files WHERE layer = ? AND dir = ? ORDER BY path").all(layer, path) as {
    path: string;
    lang: string | null;
    lane: string;
    parse_error: string | null;
  }[];
  // Every file under the folder, by the child it is under, to name each child's main area.
  const under = db.query(path === "." ? "SELECT path FROM files WHERE layer = ?" : "SELECT path FROM files WHERE layer = ? AND substr(path, 1, ?) = ?");
  const below = (path === "." ? under.all(layer) : under.all(layer, path.length + 1, `${path}/`)) as { path: string }[];
  const mainArea = new Map([...areasOf(db, below.map((r) => r.path))].map(([file, areas]) => [file, areas[0] ?? null]));
  const childArea = new Map<string, string | null>();
  for (const { path: file } of below) {
    const child = childOf(path, file);
    if (child === null) continue;
    const area = mainArea.get(file) ?? null;
    childArea.set(child, childArea.has(child) && childArea.get(child) !== area ? null : area);
  }
  const children: TreeChild[] = [
    ...dirs.map((d): TreeChild => ({ kind: "dir", path: d.path, name: baseName(d.path), files: d.file_count, functions: byChild.get(d.path) ?? 0, area: childArea.get(d.path) ?? null })),
    ...files.map(
      (f): TreeChild => ({
        kind: "file",
        path: f.path,
        name: baseName(f.path),
        lang: f.lang,
        lane: f.lane,
        functions: byChild.get(f.path) ?? 0,
        notParsed: notParsedReason(db, layer, f),
        area: childArea.get(f.path) ?? null,
      }),
    ),
  ];
  const shown = new Set(children.map((c) => c.area));
  const areas = listAreas(db)
    .filter((a) => shown.has(a.name))
    .map((a): TreeArea => ({ name: a.name, purpose: a.purpose, parent: a.parent, status: a.status }));

  const edges = db
    .query(
      `SELECT s.path AS src, d.path AS dst, e.kind, count(*) AS n FROM edges e
         JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.dst_id IS NOT NULL AND e.kind IN (${LINK_KINDS.map(() => "?").join(", ")}) AND s.path <> d.path
        GROUP BY s.path, d.path, e.kind`,
    )
    .all(layer, ...LINK_KINDS) as { src: string; dst: string; kind: string; n: number }[];
  const links = new Map<string, TreeLink>();
  for (const e of edges) {
    const from = childOf(path, e.src);
    const to = childOf(path, e.dst);
    if (from === null || to === null || from === to) continue;
    const key = `${from}\0${to}`;
    const link = links.get(key) ?? { from, to, calls: 0, imports: 0 };
    if (e.kind === "imports") link.imports += e.n;
    else link.calls += e.n;
    links.set(key, link);
  }
  return { path, functions: total, children, links: [...links.values()], areas };
}

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
  parent_id: number | null;
  unnamed: number;
};

const SYMBOL_COLUMNS = "s.id, s.path, s.kind, s.qualified_name, s.name, s.signature, s.doc, s.start_line, s.end_line, s.exported, s.parent_id, s.unnamed";

/** Kinds drawn on a file's view: the functions and the types that hold them. */
const DRAWN_KINDS = [...KIND_LIST, SYMBOL_KINDS.type];

/** One file: its types and functions, each inside its container, with the proven calls between them. */
export function file(db: Database, layer: string, filePath: string): FileResult | null {
  const path = filePath.replace(/^\.\//, "");
  const row = db.query("SELECT path, lang, lane, parse_error FROM files WHERE layer = ? AND path = ?").get(layer, path) as {
    path: string;
    lang: string | null;
    lane: string;
    parse_error: string | null;
  } | null;
  if (!row) return null;
  const rows = db
    .query(`SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.layer = ? AND s.path = ? AND s.kind IN (${DRAWN_KINDS.map(() => "?").join(", ")}) ORDER BY s.start_line, s.id`)
    .all(layer, path, ...DRAWN_KINDS) as SymbolRow[];
  const drawn = new Set(rows.map((r) => r.id));
  const counts = new Map<number, { unresolved: number; callsOut: number }>();
  const tallies = db
    .query(
      `SELECT e.src_id AS id,
              sum(e.resolution = 'unresolved' AND e.kind <> 'imports') AS unresolved,
              sum(e.dst_id IS NOT NULL AND e.kind IN (${CALL_KINDS.map(() => "?").join(", ")}) AND d.path <> ?) AS calls_out
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE s.layer = ? AND s.path = ? GROUP BY e.src_id`,
    )
    .all(...CALL_KINDS, path, layer, path) as { id: number; unresolved: number; calls_out: number }[];
  for (const t of tallies) counts.set(t.id, { unresolved: t.unresolved ?? 0, callsOut: t.calls_out ?? 0 });
  const states = db
    .query(
      `SELECT e.src_id AS id, e.call_state AS state, count(*) AS n FROM edges e JOIN symbols s ON s.id = e.src_id
        WHERE s.layer = ? AND s.path = ? AND e.call_state IS NOT NULL GROUP BY e.src_id, e.call_state`,
    )
    .all(layer, path) as { id: number; state: CallState; n: number }[];
  const callsOf = (id: number): CallCounts => countsOf(states.filter((r) => r.id === id));
  const symbols = rows.map(
    (r): FileSymbol => ({
      id: r.id,
      kind: r.kind,
      name: r.unnamed === 1 ? r.qualified_name : r.name,
      qualifiedName: r.qualified_name,
      unnamed: r.unnamed === 1,
      parent: r.parent_id !== null && drawn.has(r.parent_id) ? r.parent_id : null,
      startLine: r.start_line,
      endLine: r.end_line,
      signature: r.signature,
      unresolved: counts.get(r.id)?.unresolved ?? 0,
      callsOut: counts.get(r.id)?.callsOut ?? 0,
      calls: callsOf(r.id),
    }),
  );
  const internal = db
    .query(
      `SELECT e.src_id AS src, e.dst_id AS dst, count(*) AS n FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
        WHERE s.layer = ? AND s.path = ? AND d.path = ? AND e.kind IN (${CALL_KINDS.map(() => "?").join(", ")}) GROUP BY e.src_id, e.dst_id`,
    )
    .all(layer, path, path, ...CALL_KINDS) as { src: number; dst: number; n: number }[];
  return {
    path,
    lang: row.lang,
    lane: row.lane,
    notParsed: notParsedReason(db, layer, row),
    areas: areasOf(db, [path]).get(path) ?? [],
    functions: symbols.filter((s) => FUNCTION_KINDS.has(s.kind)).length,
    symbols,
    links: internal.filter((l) => drawn.has(l.src) && drawn.has(l.dst) && l.src !== l.dst).map((l) => ({ from: l.src, to: l.dst, count: l.n })),
  };
}

function idOf(db: Database, layer: string, path: string, qualifiedName: string, kind?: string): number | null {
  const row = db
    .query(
      `SELECT id FROM symbols WHERE layer = ? AND path = ? AND qualified_name = ? AND unnamed = 0 ${kind === undefined ? "" : "AND kind = ?"} ORDER BY id LIMIT 1`,
    )
    .get(...([layer, path, qualifiedName, ...(kind === undefined ? [] : [kind])] as string[])) as { id: number } | null;
  return row?.id ?? null;
}

/** One symbol with its callers and what it calls: the same card the agents' lookup gives, with ids to open each. */
export function functionView(db: Database, layer: string, id: number): FunctionResult | null {
  const row = db.query(`SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.layer = ? AND s.id = ? AND s.kind <> '${SYMBOL_KINDS.file}'`).get(layer, id) as SymbolRow | null;
  if (!row) return null;
  const card = symbolCard(db, layer, row);
  const callers = card.callers.map((c): NodeRef => ({ ...c, id: c.kind === SYMBOL_KINDS.file ? null : idOf(db, layer, c.path, c.qualifiedName, c.kind) }));
  const callees = card.callees
    .filter((c) => c.target !== null)
    .map((c): NodeRef => ({
      id: idOf(db, layer, c.target!.path, c.target!.qualifiedName),
      qualifiedName: c.target!.qualifiedName,
      kind: c.edge,
      path: c.target!.path,
      lines: c.lines,
      moreLines: c.moreLines,
    }));
  const parentRow = row.parent_id === null ? null : (db.query("SELECT kind FROM symbols WHERE id = ?").get(row.parent_id) as { kind: string } | null);
  return {
    id: row.id,
    name: row.unnamed === 1 ? row.qualified_name : row.name,
    unnamed: row.unnamed === 1,
    parent: parentRow !== null && parentRow.kind !== SYMBOL_KINDS.file ? row.parent_id : null,
    card,
    callers,
    callees,
    more: { callers: card.more.callers, callees: card.more.callees },
    unresolved: card.callees.filter((c) => c.resolution === "unresolved" && c.edge !== "imports").length,
  };
}

/** Functions and classes whose name holds `query`, named ones first. */
export function search(db: Database, layer: string, query: string): SearchHit[] {
  const q = query.trim();
  if (q === "") return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db
    .query(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.layer = ? AND s.kind IN (${DRAWN_KINDS.map(() => "?").join(", ")})
          AND (s.qualified_name LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')
        ORDER BY s.unnamed, s.name = ? COLLATE NOCASE DESC, length(s.qualified_name), s.path LIMIT ?`,
    )
    .all(layer, ...DRAWN_KINDS, like, like, q, SEARCH_MAX) as SymbolRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.unnamed === 1 ? r.qualified_name : r.name,
    qualifiedName: r.qualified_name,
    kind: r.kind,
    path: r.path,
    line: r.start_line,
    unnamed: r.unnamed === 1,
  }));
}
