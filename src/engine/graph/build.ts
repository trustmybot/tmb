// Indexing: reads and parses one commit of the repo, resolves its references, and applies the
// whole layer in one transaction, so a read never sees half a graph. Each file is parsed once
// per blob: a later commit reparses only the files it changed.
import type { Database } from "bun:sqlite";
import { basename, posix } from "node:path";
import { type ExtractedExport, type Extraction, extractFile, languageOf, leftOutRule, type SourceLanguage, splitWords, symbolTerms } from "./extract.ts";
import { BASE_LAYER, dropLayer, layerRow } from "./db.ts";
import { listTree, readBlobs, type TreeEntry } from "./git-source.ts";
import { languageNamed } from "./languages/registry.ts";
import { unreadLanguageOf } from "./languages/unread.ts";
import { loadParsers, type Parsers } from "./loader.ts";
import { ImportConfig, isImportConfigPath } from "./import-config.ts";
import { type Candidate, callState, NAME_ONLY_EDGES, Resolver, shortName } from "./resolve.ts";
import { fileSummary, isReadme, readmeSummary } from "./summary.ts";
import { laneOf } from "./test-paths.ts";
import { recheckAreas } from "./areas.ts";
import { recheckConcepts } from "./concepts.ts";

/** Bumped whenever extraction changes what it returns, so cached parses and built layers are redone. */
export const EXTRACTOR_VERSION = 12;
/** Files larger than this are kept as files and not parsed. */
export const MAX_PARSE_BYTES = 1_000_000;
/** Why a minified bundle has no symbols: by design, so the doctor does not count it as a problem. */
export const MINIFIED = "minified; not parsed";
const MAX_ERROR_CHARS = 200;

export type BuildStats = {
  layer: string;
  commit: string;
  files: number;
  parsed: number;
  reused: number;
  symbols: number;
  edges: number;
  unresolved: number;
  /** Imports that name the repo's own code and link no file; an installed package's import is not one (trustmybot/tmb#147). */
  unresolvedImports: number;
  /** Functions and methods, unnamed ones included. */
  functions: number;
  /** Files in a language tmb parses that could not be parsed; each is in the graph with its reason. */
  notParsed: number;
  /** What the graph does not read: code in languages tmb has no module for, and files left out by rule (trustmybot/tmb#234). */
  notRead: NotRead;
};

/** Files of a commit the graph does not read, with counts, most first. */
export type NotRead = {
  /** Files of each programming language tmb has no module for; they are in the graph as files, with no symbols. */
  languages: { name: string; files: number }[];
  /** Files each rule leaves out of the graph altogether, such as dist/ or lockfiles. */
  leftOut: { rule: string; files: number }[];
};

export const NOTHING_UNREAD: NotRead = { languages: [], leftOut: [] };

/** Counts, most first, then by name. */
const sortedCounts = (counts: Map<string, number>): [string, number][] => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** The layer's stored counts of what it does not read. */
export function parseNotRead(text: string | null | undefined): NotRead {
  if (text === null || text === undefined) return NOTHING_UNREAD;
  try {
    const value = JSON.parse(text) as Partial<NotRead>;
    return { languages: value.languages ?? [], leftOut: value.leftOut ?? [] };
  } catch {
    return NOTHING_UNREAD;
  }
}

/** The symbol kinds that are functions. */
export const FUNCTION_KINDS: ReadonlySet<string> = new Set(["function", "method", "sh_function"]);

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
    const { symbols, edges, exports } = extractFile(parsers, entry.path, lang, text);
    return { extraction: { symbols, edges, ...(exports && exports.length > 0 ? { exports } : {}) }, error: null };
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
): Promise<{ plans: FilePlan[]; readmes: Map<string, string>; configs: Map<string, string>; parsed: number; reused: number; leftOut: Map<string, number> }> {
  const leftOut = new Map<string, number>();
  const entries = listTree(repoDir, commit).filter((entry) => {
    const rule = leftOutRule(entry.path);
    if (rule !== null) leftOut.set(rule, (leftOut.get(rule) ?? 0) + 1);
    return rule === null;
  });
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
    const wantsText =
      parseable && ((lang !== null && !cached) || headless || isReadme(entry.path) || /\.(md|markdown)$/i.test(entry.path) || isImportConfigPath(entry.path));
    if (wantsText) needText.push(entry.blob);
  }
  const texts = readBlobs(repoDir, needText);
  const configs = new Map<string, string>();
  for (const { entry } of plans) {
    const text = isImportConfigPath(entry.path) ? texts.get(entry.blob) : undefined;
    if (text !== undefined) configs.set(entry.path, text);
  }
  for (const plan of plans) {
    const text = texts.get(plan.entry.blob) ?? null;
    if (plan.lang === null && text !== null && byExtension.get(plan.entry.path) === null) {
      plan.lang = languageOf(plan.entry.path, () => text.slice(0, 120));
    }
  }
  // Only the grammars of the files this commit parses anew are loaded (trustmybot/tmb#157).
  const toParse = plans.filter((p) => p.lang !== null && p.extraction === null && p.error === null && p.entry.size <= MAX_PARSE_BYTES);
  const parsers = await loadParsers(toParse.map((p) => p.lang as SourceLanguage));
  let parsed = 0;
  const cache = db.prepare("INSERT OR REPLACE INTO parsed (blob, lang, extractor, extraction, error) VALUES (?, ?, ?, ?, ?)");
  for (const plan of plans) {
    const text = texts.get(plan.entry.blob) ?? null;
    if (plan.lang !== null && plan.extraction === null && plan.error === null) {
      if (plan.entry.size > MAX_PARSE_BYTES) {
        plan.error = `larger than ${MAX_PARSE_BYTES} bytes; not parsed`;
      } else if (text !== null && languageNamed(plan.lang)?.minified?.(text) === true) {
        // A minified bundle stays a file of the graph, counted and found by path, but adds no symbol.
        plan.error = MINIFIED;
        cache.run(plan.entry.blob, plan.lang, EXTRACTOR_VERSION, null, MINIFIED);
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
  return { plans, readmes, configs, parsed, reused, leftOut };
}

function ancestorsOf(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; d !== "."; d = dirOf(d)) out.push(d);
  out.push(".");
  return out;
}

/** Writes one whole layer, replacing what it held. */
function applyLayer(
  db: Database,
  layer: string,
  commit: string,
  plans: FilePlan[],
  readmeByDir: Map<string, string>,
  configs: Map<string, string>,
  leftOut: Map<string, number>,
): Omit<BuildStats, "parsed" | "reused"> {
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
  const symbolRows: { file: string; s: Extraction["symbols"][number]; offset: number }[] = [];
  const exports = new Map<string, ExtractedExport[]>();
  for (const plan of plans) {
    const file = plan.entry.path;
    const source = plan.summary === "" ? "none" : plan.extraction ? "header" : "heading";
    insertFile.run(layer, file, dirOf(file), plan.lang, plan.entry.blob, plan.entry.size, laneOf(file), plan.summary, source, plan.error);
    insertFileFts.run(layer, file, `${splitWords(file)} ${splitWords(basename(file))}`, plan.summary);
    if (!plan.extraction) continue;
    if (plan.extraction.exports) exports.set(file, plan.extraction.exports);
    const offset = symbolRows.length;
    for (const s of plan.extraction.symbols) {
      // An unnamed function is no reference's target: nothing names it.
      if (s.unnamed !== 1) {
        const parent = s.reach === "nested" && s.parent !== undefined ? plan.extraction.symbols[s.parent] : undefined;
        candidates.push({
          id: symbolRows.length,
          path: file,
          kind: s.kind,
          qualified_name: s.qualified_name,
          line: s.start_line,
          ...(s.reach ? { reach: s.reach } : {}),
          ...(parent ? { within: [parent.start_line, parent.end_line] as [number, number] } : {}),
          ...(s.bases ? { bases: s.bases } : {}),
          ...(s.fields ? { fields: s.fields } : {}),
        });
      }
      symbolRows.push({ file, s, offset });
    }
    for (const edge of plan.extraction.edges) pending.push({ file, symbolIndex: offset + edge.src, edge });
  }

  const insertSymbol = db.prepare(
    "INSERT INTO symbols (layer, path, kind, qualified_name, name, signature, doc, start_line, end_line, exported, parent_id, unnamed, named_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSymbolFts = db.prepare("INSERT INTO symbols_fts (symbol_id, layer, terms, doc) VALUES (?, ?, ?, ?)");
  // A symbol's container and owner come before it in its file's list, so their ids are known.
  const ids: number[] = [];
  let functions = 0;
  for (const { file, s, offset } of symbolRows) {
    const parentId = s.parent === undefined ? null : ids[offset + s.parent]!;
    const namedId = s.unnamed === 1 && s.owner !== undefined ? ids[offset + s.owner]! : null;
    const id = Number(
      insertSymbol.run(
        layer,
        file,
        s.kind,
        s.qualified_name,
        shortName(s.kind, s.qualified_name),
        s.signature,
        s.doc,
        s.start_line,
        s.end_line,
        s.exported,
        parentId,
        s.unnamed === 1 ? 1 : 0,
        namedId,
      ).lastInsertRowid,
    );
    // Unnamed functions stay out of search by name and by meaning.
    if (s.unnamed !== 1) insertSymbolFts.run(id, layer, symbolTerms(s.kind, s.qualified_name, file), s.doc);
    if (FUNCTION_KINDS.has(s.kind)) functions++;
    ids.push(id);
  }
  const notParsed = plans.filter((plan) => plan.lang !== null && plan.extraction === null).length;

  const resolver = new Resolver(candidates, pending.map(({ file, edge }) => ({ from: file, edge })), new ImportConfig(configs), exports);
  const insertEdge = db.prepare("INSERT INTO edges (layer, src_id, dst_id, dst_name, kind, resolution, line, hint, call_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  let unresolved = 0;
  for (const { file, symbolIndex, edge } of pending) {
    const link = resolver.resolve(file, edge);
    if (!link && !NAME_ONLY_EDGES.has(edge.kind)) unresolved++;
    // A call written in a function records its state; any other reference has none (trustmybot/tmb#252).
    const state = edge.call === 1 ? callState(resolver, file, edge, link) : null;
    insertEdge.run(layer, ids[symbolIndex]!, link ? ids[link.dst]! : null, edge.dst_name, edge.kind, link ? link.how : "unresolved", edge.line, edge.hint, state);
  }
  const unresolvedImports = resolver.unresolvedImports;
  const unread = new Map<string, number>();
  for (const plan of plans) {
    const language = plan.lang === null ? unreadLanguageOf(plan.entry.path) : null;
    if (language !== null) unread.set(language, (unread.get(language) ?? 0) + 1);
  }
  const notRead: NotRead = {
    languages: sortedCounts(unread).map(([name, files]) => ({ name, files })),
    leftOut: sortedCounts(leftOut).map(([rule, files]) => ({ rule, files })),
  };
  const stats = { layer, commit, files: plans.length, symbols: ids.length, edges: pending.length, unresolved, unresolvedImports, functions, notParsed, notRead };
  db.run(
    "INSERT INTO layers (layer, commit_sha, extractor, built_at, files, symbols, edges, unresolved, unresolved_imports, functions, not_parsed, not_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
    layer,
    commit,
    EXTRACTOR_VERSION,
    new Date().toISOString(),
    stats.files,
    stats.symbols,
    stats.edges,
    stats.unresolved,
    stats.unresolvedImports,
    stats.functions,
    stats.notParsed,
    JSON.stringify(notRead),
    ],
  );
  return stats;
}

/**
 * Indexes the repo at `commit` into `layer`, replacing it in one step, unless the layer is
 * already at `commit` and `force` is not set. A base layer then re-checks every concept.
 */
export async function buildLayer(db: Database, repoDir: string, commit: string, layer: string, options: { force?: boolean } = {}): Promise<BuildStats> {
  const { plans, readmes: readmeByDir, configs, parsed, reused, leftOut } = await planCommit(db, repoDir, commit);
  const stats = db
    .transaction(() => {
      // Another process may have applied this very commit while this one parsed: keep its layer.
      const current = layerRow(db, layer);
      if (options.force !== true && current !== null && current.commit_sha === commit && current.extractor === EXTRACTOR_VERSION) {
        return {
          layer,
          commit,
          files: current.files,
          symbols: current.symbols,
          edges: current.edges,
          unresolved: current.unresolved,
          unresolvedImports: current.unresolved_imports,
          functions: current.functions,
          notParsed: current.not_parsed,
          notRead: parseNotRead(current.not_read),
        };
      }
      const applied = applyLayer(db, layer, commit, plans, readmeByDir, configs, leftOut);
      if (layer === BASE_LAYER) {
        recheckConcepts(db, commit);
        recheckAreas(db, commit);
      }
      return applied;
    })
    .immediate();
  return { ...stats, parsed, reused };
}
