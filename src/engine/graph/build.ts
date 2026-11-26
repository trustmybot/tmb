// Indexing: reads and parses one commit of the repo, resolves its references, and applies the
// whole layer in one transaction, so a read never sees half a graph. Each file is parsed once
// per blob: a later commit reparses only the files it changed.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { basename, posix } from "node:path";
import { type ExtractedExport, type Extraction, extractFile, languageOf, leftOutRule, NODE_MODULES_RULE, type SourceLanguage, splitWords, symbolTerms } from "./extract.ts";
import { BASE_LAYER, dropLayer, layerRow } from "./db.ts";
import { commitReader, listTree, readBlobs, type TreeEntry } from "./git-source.ts";
import type { LanguageTool, ToolAnswer, ToolCall, ToolNode } from "./languages/contract.ts";
import { LANGUAGES, languageNamed } from "./languages/registry.ts";
import { unreadLanguageOf } from "./languages/unread.ts";
import { loadParsers, type Parsers } from "./loader.ts";
import { ImportConfig, isImportConfigPath } from "./import-config.ts";
import { type Candidate, callState, type Link, NAME_ONLY_EDGES, Resolver, shortName } from "./resolve.ts";
import { fileSummary, isReadme, readmeSummary } from "./summary.ts";
import { laneOf } from "./test-paths.ts";
import { recheckAreas } from "./areas.ts";
import { recheckConcepts } from "./concepts.ts";
import { BUILT_IN, LANGUAGE_TOOL, type LinkWay } from "./ways.ts";

/** Bumped whenever extraction changes what it returns, so cached parses and built layers are redone. */
export const EXTRACTOR_VERSION = 28;
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
  /** The way the layer was asked to make its links by (trustmybot/tmb#311). */
  links: LinkWay;
  /** Why a language was built by the built-in rules although its tool was asked for, and what a tool's answers rest on that the reader should know; null when neither. */
  linksNote: string | null;
  /** What a way B layer was built with (BuiltWithRecord, as JSON); null for a layer built by the built-in rules. */
  builtWith: string | null;
};

/** Files of a commit the graph does not read, with counts, most first. */
export type NotRead = {
  /** Files of each programming language tmb has no module for; they are in the graph as files, with no symbols. */
  languages: { name: string; files: number }[];
  /** Files each rule leaves out of the graph altogether, such as dist/ or lockfiles. */
  leftOut: { rule: string; files: number }[];
  /** Statements a language's parser could not read, each of which gave no link; absent when there are none. */
  statements?: number;
};

export const NOTHING_UNREAD: NotRead = { languages: [], leftOut: [] };

/** Counts, most first, then by name. */
const sortedCounts = (counts: Map<string, number>): [string, number][] => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** The layer's stored counts of what it does not read. */
export function parseNotRead(text: string | null | undefined): NotRead {
  if (text === null || text === undefined) return NOTHING_UNREAD;
  try {
    const value = JSON.parse(text) as Partial<NotRead>;
    return { languages: value.languages ?? [], leftOut: value.leftOut ?? [], ...(value.statements ? { statements: value.statements } : {}) };
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
    const { symbols, edges, exports, statementsNotRead } = extractFile(parsers, entry.path, lang, text);
    return {
      extraction: { symbols, edges, ...(exports && exports.length > 0 ? { exports } : {}), ...(statementsNotRead ? { statementsNotRead } : {}) },
      error: null,
    };
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

/**
 * How a part of the links note ends when its languages' links are the built-in rules' because
 * their tool gave none; a part that does not end so is something the tool's answers rest on.
 */
export const BUILT_IN_RULES = ", so the built-in rules";

/**
 * The tools' answers for the calls of a commit, by the call's place in the layer's list of edges;
 * why a language had none; and what the tools were built with (BuiltWithRecord, as JSON), null
 * when no tool was asked.
 */
type ToolLinks = { answers: Map<number, ToolAnswer>; note: string | null; builtWith: string | null };

const NO_TOOL_LINKS: ToolLinks = { answers: new Map(), note: null, builtWith: null };

/**
 * What a way B layer was built with (CODE_GRAPH.md: "A way B graph is stale when the tool or the
 * installed packages change", trustmybot/tmb#325): for each tool asked for a language of the layer,
 * by its name, the tool as it reported itself, a digest of the installed packages it read, and the
 * places it read them from, which a later read reads again.
 */
export type BuiltWithRecord = Record<string, { tool: string; packages: string; places: string[] }>;

/** One tool's entry of a BuiltWithRecord, made now. */
function builtWithEntry(tool: LanguageTool, repoDir: string, places: readonly string[]): BuiltWithRecord[string] {
  const sorted = [...new Set(places)].sort();
  const now = tool.builtWith(repoDir, sorted);
  return { tool: now.tool, packages: createHash("sha256").update(now.packages).digest("hex"), places: sorted };
}

/** The record as stored: its tools in the order of their names, so one record is one text. */
const recordText = (record: BuiltWithRecord): string => JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));

/**
 * Whether what a way B layer was built with is what it would be built with now: each tool it
 * records reports the same version and finds the same installed packages at the same places. A
 * layer that records nothing, as one built before it was recorded, is not; nor is one that names a
 * tool tmb no longer has.
 */
export function stillBuiltWith(repoDir: string, recorded: string | null): boolean {
  if (recorded === null) return false;
  let record: BuiltWithRecord;
  try {
    record = JSON.parse(recorded) as BuiltWithRecord;
  } catch {
    return false;
  }
  const tools = new Map(LANGUAGES.flatMap((language) => (language.tool ? [[language.tool.name, language.tool] as const] : [])));
  for (const [name, entry] of Object.entries(record)) {
    const tool = tools.get(name);
    if (tool === undefined) return false;
    const now = builtWithEntry(tool, repoDir, entry.places);
    if (now.tool !== entry.tool || now.packages !== entry.packages) return false;
  }
  return true;
}

/** One file's symbols and edges, at their places in the layer's lists, in the order applyLayer writes them. */
function* layerRows(plans: readonly FilePlan[]): Generator<{ plan: FilePlan; extraction: Extraction; symbolOffset: number; edgeOffset: number }> {
  let symbolOffset = 0;
  let edgeOffset = 0;
  for (const plan of plans) {
    if (!plan.extraction) continue;
    yield { plan, extraction: plan.extraction, symbolOffset, edgeOffset };
    symbolOffset += plan.extraction.symbols.length;
    edgeOffset += plan.extraction.edges.length;
  }
}

/** A node's own name: the last part of its qualified name. */
const ownName = (qualifiedName: string): string => qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1);

/**
 * Way B (trustmybot/tmb#311): each language's own tool answers for the calls of its files. A
 * language with no tool, and one whose tool cannot run in this repo, keeps the built-in rules'
 * links, and the note says so. Read before the layer is written, so no write waits on the tool.
 */
async function toolLinks(repoDir: string, commit: string, plans: readonly FilePlan[], configs: ReadonlyMap<string, string>): Promise<ToolLinks> {
  const present = new Set(plans.filter((p) => p.extraction !== null && p.lang !== null).map((p) => p.lang as SourceLanguage));
  const tools = new Map<LanguageTool, SourceLanguage[]>();
  for (const language of LANGUAGES) if (language.tool) tools.set(language.tool, [...(tools.get(language.tool) ?? []), language.name]);
  const notes: string[] = [];
  const toolless = [...present].filter((lang) => languageNamed(lang)?.tool === undefined).sort();
  if (toolless.length > 0) notes.push(`${toolless.join(", ")}: no language tool${BUILT_IN_RULES}`);
  const answers = new Map<number, ToolAnswer>();
  const builtWith: BuiltWithRecord = {};
  for (const [tool, langs] of tools) {
    if (!langs.some((lang) => present.has(lang))) continue;
    const opened = await tool.open(repoDir);
    if ("unavailable" in opened) {
      notes.push(`${langs.join(", ")}: ${tool.name} cannot run (${opened.unavailable})${BUILT_IN_RULES}`);
      // A tool that could not run is recorded too: once it can, the layer is stale.
      builtWith[tool.name] = builtWithEntry(tool, repoDir, []);
      continue;
    }
    const mine = new Set(langs);
    // Every file of the tool's languages at the commit, so the tool sees what an import names;
    // installed packages are not the repo's and are left to the tool.
    const tree = listTree(repoDir, commit);
    const read = commitReader(repoDir, tree);
    const parsed = tree.filter((e) => e.size <= MAX_PARSE_BYTES && leftOutRule(e.path) !== NODE_MODULES_RULE);
    const entries = parsed.filter((e) => mine.has(languageOf(e.path, () => "") ?? ""));
    // The other files the tool reads, such as its settings files, beside the project's.
    const extra = parsed.filter((e) => tool.reads?.(e.path) === true && !configs.has(e.path));
    const blobs = readBlobs(repoDir, [...entries, ...extra].map((e) => e.blob));
    const files = new Map<string, string>();
    for (const e of entries) {
      const text = blobs.get(e.blob);
      if (text !== undefined) files.set(e.path, text);
    }
    const toolConfigs = new Map(configs);
    for (const e of extra) {
      const text = blobs.get(e.blob);
      if (text !== undefined) toolConfigs.set(e.path, text);
    }
    const nodes: ToolNode[] = [];
    const nodeRows: number[] = [];
    const calls: ToolCall[] = [];
    const callRows: number[] = [];
    for (const { plan, extraction, symbolOffset, edgeOffset } of layerRows(plans)) {
      if (plan.lang === null || !mine.has(plan.lang)) continue;
      const file = plan.entry.path;
      extraction.symbols.forEach((s, i) => {
        if (s.kind === "module" || s.unnamed === 1) return;
        nodes.push({ path: file, name: ownName(s.qualified_name), start: s.start_line, end: s.end_line });
        nodeRows.push(symbolOffset + i);
      });
      extraction.edges.forEach((edge, i) => {
        if (edge.call !== 1 || edge.pos === undefined) return;
        calls.push({ path: file, pos: edge.pos, name: edge.dst_name });
        callRows.push(edgeOffset + i);
      });
    }
    let answered: ToolAnswer[];
    const places: string[] = [];
    try {
      answered = opened.answer(
        { files, configs: toolConfigs, read, nodes, calls },
        (text) => notes.push(`${langs.join(", ")}: ${tool.name}: ${text}`),
        (more) => places.push(...more),
      );
    } catch (error) {
      notes.push(`${langs.join(", ")}: ${tool.name} failed (${(error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS)})${BUILT_IN_RULES}`);
      continue;
    } finally {
      builtWith[tool.name] = builtWithEntry(tool, repoDir, places);
    }
    answered.forEach((answer, i) => {
      if (!("nodes" in answer)) answers.set(callRows[i]!, answer);
      else {
        const [first, ...more] = answer.nodes;
        answers.set(callRows[i]!, { nodes: [nodeRows[first]!, ...more.map((n) => nodeRows[n]!)] });
      }
    });
  }
  return { answers, note: notes.length === 0 ? null : notes.join("; "), builtWith: recordText(builtWith) };
}

function ancestorsOf(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; d !== "."; d = dirOf(d)) out.push(d);
  out.push(".");
  return out;
}

const dataSourceKey = (kind: string, name: string): string => `${kind}\u0000${name}`;

/**
 * The layer's data sources (CODE_GRAPH.md, "Data sources"): one node of each kind and name its
 * links reach, in no file and in nothing, its kind as its signature and its name ('' for a store
 * the code does not name). Returns each one's id by dataSourceKey.
 */
function writeDataSources(db: Database, layer: string, edges: readonly Extraction["edges"][number][]): Map<string, number> {
  const insert = db.prepare("INSERT INTO symbols (layer, path, kind, qualified_name, name, signature, doc, exported, unnamed) VALUES (?, '', 'data_source', ?, ?, ?, '', 0, 0)");
  const insertFts = db.prepare("INSERT INTO symbols_fts (symbol_id, layer, terms, doc) VALUES (?, ?, ?, '')");
  const ids = new Map<string, number>();
  for (const edge of edges) {
    if (edge.data === undefined) continue;
    const key = dataSourceKey(edge.data, edge.dst_name);
    if (ids.has(key)) continue;
    const id = Number(insert.run(layer, edge.dst_name, edge.dst_name, edge.data).lastInsertRowid);
    insertFts.run(id, layer, `${splitWords(edge.dst_name)} ${splitWords(edge.data)}`);
    ids.set(key, id);
  }
  return ids;
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
  links: LinkWay,
  byTool: ToolLinks,
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
  let statementsNotRead = 0;
  for (const plan of plans) {
    const file = plan.entry.path;
    const source = plan.summary === "" ? "none" : plan.extraction ? "header" : "heading";
    insertFile.run(layer, file, dirOf(file), plan.lang, plan.entry.blob, plan.entry.size, laneOf(file), plan.summary, source, plan.error);
    insertFileFts.run(layer, file, `${splitWords(file)} ${splitWords(basename(file))}`, plan.summary);
    if (!plan.extraction) continue;
    if (plan.extraction.exports) exports.set(file, plan.extraction.exports);
    statementsNotRead += plan.extraction.statementsNotRead ?? 0;
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
  const sources = writeDataSources(db, layer, pending.map((p) => p.edge));
  const notParsed = plans.filter((plan) => plan.lang !== null && plan.extraction === null).length;

  const resolver = new Resolver(candidates, pending.map(({ file, edge }) => ({ from: file, edge })), new ImportConfig(configs), exports);
  const insertEdge = db.prepare(
    "INSERT INTO edges (layer, src_id, dst_id, dst_name, kind, resolution, line, pos, hint, call_state, way) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let unresolved = 0;
  pending.forEach(({ file, symbolIndex, edge }, index) => {
    if (edge.data !== undefined) {
      // A link to a data source ends at the layer's one node of its kind and name.
      insertEdge.run(layer, ids[symbolIndex]!, sources.get(dataSourceKey(edge.data, edge.dst_name))!, edge.dst_name, edge.kind, "exact", edge.line, null, null, null, BUILT_IN);
      return;
    }
    // A call its language's tool answered takes the tool's answer, and nothing else (trustmybot/tmb#311).
    const answer = byTool.answers.get(index);
    const linked = answer !== undefined && "nodes" in answer ? answer.nodes : null;
    // A call the language's own rules prove goes to a symbol of its file links to it (ExtractedEdge.target).
    const proven: Link | null = edge.target === undefined ? null : { dst: symbolIndex - edge.src + edge.target, how: "exact" };
    const link: Link | null = answer === undefined ? (proven ?? resolver.resolve(file, edge)) : linked !== null ? { dst: linked[0], how: "exact" } : null;
    if (!link && !NAME_ONLY_EDGES.has(edge.kind)) unresolved++;
    // A call written in a function records its state; any other reference has none (trustmybot/tmb#252).
    const state = answer !== undefined ? ("state" in answer ? answer.state : "linked") : edge.call === 1 ? callState(resolver, file, edge, link) : null;
    const way = answer === undefined ? BUILT_IN : LANGUAGE_TOOL;
    insertEdge.run(layer, ids[symbolIndex]!, link ? ids[link.dst]! : null, edge.dst_name, edge.kind, link ? link.how : "unresolved", edge.line, edge.pos ?? null, edge.hint, state, way);
    // A call that can go to more than one node links to each (trustmybot/tmb#344): one row per
    // further link, at the call's place. The call is one call in one state, so its state is on its
    // first row alone, and every count of calls counts it once.
    for (const dst of linked?.slice(1) ?? []) {
      insertEdge.run(layer, ids[symbolIndex]!, ids[dst]!, edge.dst_name, edge.kind, "exact", edge.line, edge.pos ?? null, edge.hint, null, way);
    }
  });
  const unresolvedImports = resolver.unresolvedImports;
  const unread = new Map<string, number>();
  for (const plan of plans) {
    const language = plan.lang === null ? unreadLanguageOf(plan.entry.path) : null;
    if (language !== null) unread.set(language, (unread.get(language) ?? 0) + 1);
  }
  const notRead: NotRead = {
    languages: sortedCounts(unread).map(([name, files]) => ({ name, files })),
    leftOut: sortedCounts(leftOut).map(([rule, files]) => ({ rule, files })),
    ...(statementsNotRead > 0 ? { statements: statementsNotRead } : {}),
  };
  const stats = {
    layer,
    commit,
    files: plans.length,
    symbols: ids.length + sources.size,
    edges: pending.length,
    unresolved,
    unresolvedImports,
    functions,
    notParsed,
    notRead,
    links,
    linksNote: byTool.note,
    builtWith: byTool.builtWith,
  };
  db.run(
    "INSERT INTO layers (layer, commit_sha, extractor, built_at, files, symbols, edges, unresolved, unresolved_imports, functions, not_parsed, not_read, links, links_note, built_with) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    links,
    byTool.note,
    byTool.builtWith,
    ],
  );
  return stats;
}

export type BuildOptions = {
  force?: boolean;
  /**
   * The way to make links, from the repo's `graph_links` setting (graphLinksOf, whose default is the
   * language's tool). A caller that names none, such as a check of the built-in rules, gets them.
   */
  links?: LinkWay;
};

/**
 * Indexes the repo at `commit` into `layer`, replacing it in one step, unless the layer is
 * already at `commit`, built by this extractor the way asked, and `force` is not set. A base
 * layer then re-checks every concept.
 */
export async function buildLayer(db: Database, repoDir: string, commit: string, layer: string, options: BuildOptions = {}): Promise<BuildStats> {
  const { plans, readmes: readmeByDir, configs, parsed, reused, leftOut } = await planCommit(db, repoDir, commit);
  // Built-in, not DEFAULT_LINK_WAY: a caller that names no way gets the built-in rules, so the links-right check judges way A on its own; the callers that read settings apply graph_links.
  const links = options.links ?? BUILT_IN;
  const byTool = links === LANGUAGE_TOOL ? await toolLinks(repoDir, commit, plans, configs) : NO_TOOL_LINKS;
  const stats = db
    .transaction(() => {
      // Another process may have applied this very commit while this one parsed: keep its layer.
      const current = layerRow(db, layer);
      if (
        options.force !== true &&
        current !== null &&
        current.commit_sha === commit &&
        current.extractor === EXTRACTOR_VERSION &&
        current.links === links &&
        current.built_with === byTool.builtWith
      ) {
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
          links,
          linksNote: current.links_note,
          builtWith: current.built_with,
        };
      }
      const applied = applyLayer(db, layer, commit, plans, readmeByDir, configs, leftOut, links, byTool);
      if (layer === BASE_LAYER) {
        recheckConcepts(db, commit);
        recheckAreas(db, commit);
      }
      return applied;
    })
    .immediate();
  return { ...stats, parsed, reused };
}
