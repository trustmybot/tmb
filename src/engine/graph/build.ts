// Indexing: reads and parses one commit of the repo, resolves its references, and applies the
// whole layer in one transaction, so a read never sees half a graph. Each file is parsed once
// per blob: a later commit reparses only the files it changed.
import type { Database } from "bun:sqlite";
import { basename, posix } from "node:path";
import { type Extraction, extractFile, inSymbolScope, languageOf, needsParser, type SourceLanguage, splitWords, symbolTerms } from "./extract.ts";
import { BASE_LAYER, dropLayer, layerRow } from "./db.ts";
import { listTree, readBlobs, type TreeEntry } from "./git-source.ts";
import { loadParsers, type Parsers } from "./loader.ts";
import { type Candidate, NAME_ONLY_EDGES, Resolver, shortName } from "./resolve.ts";
import { fileSummary, isReadme, readmeSummary } from "./summary.ts";
import { laneOf } from "./test-paths.ts";
import { recheckConcepts } from "./concepts.ts";

/** Bumped whenever extraction changes what it returns, so cached parses and built layers are redone. */
export const EXTRACTOR_VERSION = 1;
const MAX_PARSE_BYTES = 1_000_000;
const MAX_ERROR_CHARS = 200;

export type BuildStats = { layer: string; commit: string; files: number; parsed: number; reused: number; symbols: number; edges: number; unresolved: number };

type FilePlan = {
  entry: TreeEntry;
  lang: SourceLanguage | null;
  extraction: Extraction | null;
  error: string | null;
  summary: string;
};

const dirOf = (file: string): string => {
  const dir = posix.dirname(file);
  return dir === "" ? "." : dir;
};

function cachedParse(db: Database, blob: string, lang: string): { extraction: Extraction | null; error: string | null } | null {
  const row = db.query("SELECT extraction, error FROM parsed WHERE blob = ? AND lang = ? AND extractor = ?").get(blob, lang, EXTRACTOR_VERSION) as {
    extraction: string | null;
    error: string | null;
  } | null;
  if (row === null) return null;
  return { extraction: row.extraction === null ? null : (JSON.parse(row.extraction) as Extraction), error: row.error };
}

function parseOne(parsers: Parsers, entry: TreeEntry, lang: SourceLanguage, text: string): { extraction: Extraction | null; error: string | null } {
  try {
    const { symbols, edges } = extractFile(needsParser(lang) ? parsers : null, entry.path, lang, text);
    return { extraction: { symbols, edges }, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { extraction: null, error: message.slice(0, MAX_ERROR_CHARS) };
  }
}

/** Reads and parses every file of `commit`, reusing the parse of each blob seen before. */
async function planCommit(
  db: Database,
  repoDir: string,
  commit: string,
): Promise<{ plans: FilePlan[]; readmes: Map<string, string>; parsed: number; reused: number }> {
  const entries = listTree(repoDir, commit).filter((entry) => inSymbolScope(entry.path));
  const byExtension = new Map<string, SourceLanguage | null>();
  const needText: string[] = [];
  const plans: FilePlan[] = [];
  const readmes = new Map<string, string>();
  let reused = 0;
  for (const entry of entries) {
    let headless = false;
    const lang = languageOf(entry.path, () => {
      headless = true;
      return "";
    });
    byExtension.set(entry.path, headless ? null : lang);
    const cached = lang !== null && !headless ? cachedParse(db, entry.blob, lang) : null;
    if (cached) reused++;
    plans.push({ entry, lang: headless ? null : lang, extraction: cached?.extraction ?? null, error: cached?.error ?? null, summary: "" });
    const parseable = entry.size <= MAX_PARSE_BYTES;
    const wantsText = parseable && ((lang !== null && !cached) || headless || isReadme(entry.path) || /\.(md|markdown)$/i.test(entry.path));
    if (wantsText) needText.push(entry.blob);
  }
  const texts = readBlobs(repoDir, needText);
  const parsers = await loadParsers();
  let parsed = 0;
  const cache = db.prepare("INSERT OR REPLACE INTO parsed (blob, lang, extractor, extraction, error) VALUES (?, ?, ?, ?, ?)");
  for (const plan of plans) {
    const text = texts.get(plan.entry.blob) ?? null;
    if (plan.lang === null && text !== null && byExtension.get(plan.entry.path) === null) {
      plan.lang = languageOf(plan.entry.path, () => text.slice(0, 120));
    }
    if (plan.lang !== null && plan.extraction === null && plan.error === null) {
      if (plan.entry.size > MAX_PARSE_BYTES) {
        plan.error = `larger than ${MAX_PARSE_BYTES} bytes; not parsed`;
      } else if (text !== null) {
        const result = parseOne(parsers, plan.entry, plan.lang, text);
        plan.extraction = result.extraction;
        plan.error = result.error;
        parsed++;
        cache.run(plan.entry.blob, plan.lang, EXTRACTOR_VERSION, result.extraction === null ? null : JSON.stringify(result.extraction), result.error);
      }
    }
    const moduleDoc = plan.extraction?.symbols.find((s) => s.kind === "module")?.doc ?? null;
    plan.summary = fileSummary(plan.entry.path, moduleDoc, text);
    if (isReadme(plan.entry.path) && text !== null) readmes.set(dirOf(plan.entry.path), readmeSummary(text));
  }
  return { plans, readmes, parsed, reused };
}

function ancestorsOf(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; d !== "."; d = dirOf(d)) out.push(d);
  out.push(".");
  return out;
}

/** Writes one whole layer, replacing what it held. */
function applyLayer(db: Database, layer: string, commit: string, plans: FilePlan[], readmeByDir: Map<string, string>): Omit<BuildStats, "parsed" | "reused"> {
  dropLayer(db, layer);
  const dirFiles = new Map<string, number>();
  for (const plan of plans) {
    for (const dir of ancestorsOf(dirOf(plan.entry.path))) dirFiles.set(dir, (dirFiles.get(dir) ?? 0) + 1);
  }
  const insertDir = db.prepare("INSERT INTO dirs (layer, path, parent, depth, summary, summary_source, file_count) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertDirFts = db.prepare("INSERT INTO dirs_fts (layer, path, terms, summary) VALUES (?, ?, ?, ?)");
  for (const [dir, count] of dirFiles) {
    const summary = readmeByDir.get(dir) ?? "";
    insertDir.run(layer, dir, dir === "." ? null : dirOf(dir), dir === "." ? 0 : dir.split("/").length, summary, summary ? "readme" : "none", count);
    insertDirFts.run(layer, dir, splitWords(dir), summary);
  }

  const insertFile = db.prepare(
    "INSERT INTO files (layer, path, dir, lang, blob, size, lane, summary, summary_source, parse_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFileFts = db.prepare("INSERT INTO files_fts (layer, path, terms, summary) VALUES (?, ?, ?, ?)");
  type Pending = { file: string; symbolIndex: number; edge: Extraction["edges"][number] };
  const candidates: Candidate[] = [];
  const pending: Pending[] = [];
  const symbolRows: { file: string; s: Extraction["symbols"][number] }[] = [];
  for (const plan of plans) {
    const file = plan.entry.path;
    const source = plan.summary === "" ? "none" : plan.extraction ? "header" : "heading";
    insertFile.run(layer, file, dirOf(file), plan.lang, plan.entry.blob, plan.entry.size, laneOf(file), plan.summary, source, plan.error);
    insertFileFts.run(layer, file, `${splitWords(file)} ${splitWords(basename(file))}`, plan.summary);
    if (!plan.extraction) continue;
    const offset = symbolRows.length;
    for (const s of plan.extraction.symbols) {
      candidates.push({ id: symbolRows.length, path: file, kind: s.kind, qualified_name: s.qualified_name });
      symbolRows.push({ file, s });
    }
    for (const edge of plan.extraction.edges) pending.push({ file, symbolIndex: offset + edge.src, edge });
  }

  const insertSymbol = db.prepare(
    "INSERT INTO symbols (layer, path, kind, qualified_name, name, signature, doc, start_line, end_line, exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSymbolFts = db.prepare("INSERT INTO symbols_fts (symbol_id, layer, terms, doc) VALUES (?, ?, ?, ?)");
  const ids = symbolRows.map(({ file, s }) => {
    const id = Number(
      insertSymbol.run(layer, file, s.kind, s.qualified_name, shortName(s.kind, s.qualified_name), s.signature, s.doc, s.start_line, s.end_line, s.exported)
        .lastInsertRowid,
    );
    insertSymbolFts.run(id, layer, symbolTerms(s.kind, s.qualified_name, file), s.doc);
    return id;
  });

  const resolver = new Resolver(candidates, pending.map(({ file, edge }) => ({ from: file, edge })));
  const insertEdge = db.prepare("INSERT INTO edges (layer, src_id, dst_id, dst_name, kind, resolution, line, hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let unresolved = 0;
  for (const { file, symbolIndex, edge } of pending) {
    const link = resolver.resolve(file, edge);
    if (!link && !NAME_ONLY_EDGES.has(edge.kind)) unresolved++;
    insertEdge.run(layer, ids[symbolIndex]!, link ? ids[link.dst]! : null, edge.dst_name, edge.kind, link ? link.how : "unresolved", edge.line, edge.hint);
  }
  const stats = { layer, commit, files: plans.length, symbols: ids.length, edges: pending.length, unresolved };
  db.run("INSERT INTO layers (layer, commit_sha, extractor, built_at, files, symbols, edges, unresolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    layer,
    commit,
    EXTRACTOR_VERSION,
    new Date().toISOString(),
    stats.files,
    stats.symbols,
    stats.edges,
    stats.unresolved,
  ]);
  return stats;
}

/**
 * Indexes the repo at `commit` into `layer`, replacing it in one step, unless the layer is
 * already at `commit` and `force` is not set. A base layer then re-checks every concept.
 */
export async function buildLayer(db: Database, repoDir: string, commit: string, layer: string, options: { force?: boolean } = {}): Promise<BuildStats> {
  const { plans, readmes: readmeByDir, parsed, reused } = await planCommit(db, repoDir, commit);
  const stats = db
    .transaction(() => {
      // Another process may have applied this very commit while this one parsed: keep its layer.
      const current = layerRow(db, layer);
      if (options.force !== true && current !== null && current.commit_sha === commit && current.extractor === EXTRACTOR_VERSION) {
        return { layer, commit, files: current.files, symbols: current.symbols, edges: current.edges, unresolved: current.unresolved };
      }
      const applied = applyLayer(db, layer, commit, plans, readmeByDir);
      if (layer === BASE_LAYER) recheckConcepts(db, commit);
      return applied;
    })
    .immediate();
  return { ...stats, parsed, reused };
}
