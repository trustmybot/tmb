// The benchmark's measure of a Rust repo (trustmybot/tmb#354): each way's graph against Rust's own
// tools. rust-analyzer's parser (`rust-analyzer parse`) is the reference for the functions and the
// calls; rust-analyzer itself, run as way B runs it (languages/rust/tool.ts), is the reference for
// the links. Way B's links are made by that same tool, so its links right is no proof of way B.
//
// What the reference counts, by its syntax tree:
// - a function: each FN node, but one in an `extern` block, whose code is elsewhere; and each
//   CLOSURE_EXPR. A FN starts at its first doc comment or attribute (DOC_COMMENT, ATTR), else at
//   its first token that is no comment;
// - a call: each CALL_EXPR and METHOD_CALL_EXPR, in the innermost function around it, else in the
//   file. A macro's input is a token tree to both parsers, so its calls are asked of rust-analyzer,
//   as way B asks it (CODE_GRAPH.md, "Inside a macro, the tool says what is a call"): each IDENT
//   in a MACRO_CALL's TOKEN_TREE, nested ones included, that a TOKEN_TREE opening with L_PAREN
//   follows, is a call when the symbol rust-analyzer gives at it is a function or a method; it is
//   in the innermost function around the macro, else in the file;
// - a call's name: a method call's own name; else, when the callee is a path, its last segment.
//   A callee that is no path names nothing, and its call is no link of the reference.
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { BuildOptions } from "../../src/engine/graph/build.ts";
import { BASE_LAYER } from "../../src/engine/graph/db.ts";
import type { SourceLanguage } from "../../src/engine/graph/extract.ts";
import { loadParsers } from "../../src/engine/graph/loader.ts";
import { type Answer, identifierName, MANIFESTS, readAnswers, runRustAnalyzer } from "../../src/engine/graph/languages/rust/tool.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { callsAccountedFor, functionsFound, type GraphCall, linksFoundByReference, linksFoundByState, type ReferenceCall, type Way, type WayScores } from "./score.ts";
import type { Measured } from "./typescript.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["rust"]);

/**
 * The version of the Rust reference, raised when the reference changes what it counts.
 * 2: links are judged against rust-analyzer.
 * 3: the names written as calls in a macro's input that rust-analyzer answers as calls are calls.
 */
export const REFERENCE_VERSION = 3;

/** How each way builds the graph, as the program builds it. */
const BUILD: Record<Way, BuildOptions> = {
  A: { links: "built-in" },
  B: { links: "language-tool" },
};

/** Way B's links are made by the very tool that judges them. */
export const SAME_TOOL = "same tool as the reference";

const FUNCTION_NODES: ReadonlySet<string> = new Set(["FN", "CLOSURE_EXPR"]);
const CALL_NODES: ReadonlySet<string> = new Set(["CALL_EXPR", "METHOD_CALL_EXPR"]);
const EXTERN_ITEMS = "EXTERN_ITEM_LIST";
const LEADING = new Set(["DOC_COMMENT", "ATTR"]);
const TRIVIA = new Set(["WHITESPACE", "COMMENT"]);
const METHOD_CALL = "METHOD_CALL_EXPR";
const NAME_REF = "NAME_REF";
const PATH_EXPR = "PATH_EXPR";
const PATH = "PATH";
const PATH_SEGMENT = "PATH_SEGMENT";
const MACRO_CALL = "MACRO_CALL";
const TOKEN_TREE = "TOKEN_TREE";
const IDENT = "IDENT";
const L_PAREN = "L_PAREN";

/** How a call names what it calls: a bare name, a path of segments, or a method's name. */
export type CallShape = "name" | "path" | "method";

/** A call the reference names: where its name is written (a UTF-16 offset, as the graph's), its line, its name and its shape. */
export type NamedCall = { pos: number; line: number; name: string; shape: CallShape };

/** A name written as a call in a macro's input: where, its line, its name, and the function it is in ("" for the file). */
export type MacroName = { pos: number; line: number; name: string; owner: string };

type FileAnswer = { functions: string[]; calls: Record<string, number>; named: NamedCall[]; inMacro: MacroName[] } | { error: string };
export type RustReference = { version: string; files: Record<string, FileAnswer> };

/** One line of `rust-analyzer parse`'s tree: `  KIND@start..end` with byte offsets, two spaces a level. */
type TreeLine = { depth: number; kind: string; start: number; end: number };

function treeLines(out: string): TreeLine[] {
  const lines: TreeLine[] = [];
  for (const line of out.split("\n")) {
    const m = /^( *)([A-Z_]+)@(\d+)\.\.(\d+)/.exec(line);
    if (m) lines.push({ depth: m[1]!.length / 2, kind: m[2]!, start: Number(m[3]), end: Number(m[4]) });
  }
  return lines;
}

/** The functions and calls of one file's tree, its byte offsets read as the file's lines. */
export function fileAnswer(text: string, tree: string): FileAnswer {
  const bytes = Buffer.from(text, "utf8");
  // The line each byte offset is on, 1-based.
  const lineStarts: number[] = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  // A byte offset as a UTF-16 offset, as the graph gives a call's position.
  const utf16 = (offset: number): number => (bytes.length === text.length ? offset : bytes.subarray(0, offset).toString("utf8").length);
  const nodes = treeLines(tree);
  // The children of the node at `i`, as indexes.
  const childrenOf = (i: number): number[] => {
    const out: number[] = [];
    for (let j = i + 1; j < nodes.length && nodes[j]!.depth > nodes[i]!.depth; j++) if (nodes[j]!.depth === nodes[i]!.depth + 1) out.push(j);
    return out;
  };
  const childOf = (i: number, kind: string): number | undefined => childrenOf(i).find((j) => nodes[j]!.kind === kind);
  // The name a call names: a method's own; a path's last segment; else none.
  const nameOf = (i: number): { ref: number; shape: CallShape } | null => {
    if (nodes[i]!.kind === METHOD_CALL) {
      const ref = childOf(i, NAME_REF);
      return ref === undefined ? null : { ref, shape: "method" };
    }
    const callee = childrenOf(i).find((j) => !TRIVIA.has(nodes[j]!.kind));
    if (callee === undefined || nodes[callee]!.kind !== PATH_EXPR) return null;
    const top = childOf(callee, PATH);
    if (top === undefined) return null;
    const segment = childrenOf(top).findLast((j) => nodes[j]!.kind === PATH_SEGMENT);
    const ref = segment === undefined ? undefined : childOf(segment, NAME_REF);
    if (ref === undefined) return null;
    return { ref, shape: childOf(top, PATH) === undefined ? "name" : "path" };
  };
  const functions: string[] = [];
  const calls: Record<string, number> = {};
  const named: NamedCall[] = [];
  const inMacro: MacroName[] = [];
  // Whether the IDENT at `i` is followed, past trivia, by a TOKEN_TREE that opens with L_PAREN.
  const writtenAsCall = (i: number): boolean => {
    const depth = nodes[i]!.depth;
    let j = i + 1;
    while (j < nodes.length && nodes[j]!.depth === depth && TRIVIA.has(nodes[j]!.kind)) j++;
    const next = nodes[j];
    const first = nodes[j + 1];
    return next !== undefined && next.depth === depth && next.kind === TOKEN_TREE && first !== undefined && first.depth === depth + 1 && first.kind === L_PAREN;
  };
  // Whether the open ancestors are TOKEN_TREEs in a MACRO_CALL.
  const inMacroInput = (): boolean => {
    let k = stack.length - 1;
    while (k >= 0 && stack[k]!.line.kind === TOKEN_TREE) k--;
    return k < stack.length - 1 && k >= 0 && stack[k]!.line.kind === MACRO_CALL;
  };
  // The open ancestors of each line, and the function each is in.
  const stack: { line: TreeLine; fn: string | null }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    while (stack.length > n.depth) stack.pop();
    const parent = stack[stack.length - 1];
    let fn = parent?.fn ?? null;
    if (FUNCTION_NODES.has(n.kind) && !(n.kind === "FN" && parent?.line.kind === EXTERN_ITEMS)) {
      let start = n.start;
      if (n.kind === "FN") {
        // Its first doc comment or attribute, else its first token that is no comment.
        const kids = childrenOf(i).map((j) => nodes[j]!);
        const lead = kids.find((k) => LEADING.has(k.kind)) ?? kids.find((k) => !TRIVIA.has(k.kind));
        if (lead) start = lead.start;
      }
      fn = `${lineOf(start)}-${lineOf(Math.max(n.start, n.end - 1))}`;
      functions.push(fn);
    }
    if (CALL_NODES.has(n.kind)) {
      const key = fn ?? "";
      calls[key] = (calls[key] ?? 0) + 1;
      const name = nameOf(i);
      if (name !== null) {
        const ref = nodes[name.ref]!;
        named.push({ pos: utf16(ref.start), line: lineOf(ref.start), name: bytes.subarray(ref.start, ref.end).toString("utf8"), shape: name.shape });
      }
    }
    if (n.kind === IDENT && inMacroInput() && writtenAsCall(i)) {
      inMacro.push({ pos: utf16(n.start), line: lineOf(n.start), name: bytes.subarray(n.start, n.end).toString("utf8"), owner: fn ?? "" });
    }
    stack.push({ line: n, fn });
  }
  return { functions, calls, named, inMacro };
}

/** rust-analyzer's version, or null when it is not on PATH. */
export function rustAnalyzerVersion(tool = "rust-analyzer"): string | null {
  const run = spawnSync(tool, ["--version"], { encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** rust-analyzer's parser's functions and calls for the given files, run with the `rust-analyzer` on PATH. */
export function rustReference(texts: ReadonlyMap<string, string>, tool = "rust-analyzer"): RustReference {
  const version = rustAnalyzerVersion(tool);
  if (version === null) throw new Error(`${tool} is not on PATH`);
  const files: Record<string, FileAnswer> = {};
  for (const [file, text] of texts) {
    const run = spawnSync(tool, ["parse"], { input: text, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    if (run.error !== undefined || run.status !== 0) files[file] = { error: run.error?.message ?? run.stderr.trim() };
    else if (/^\s*ERROR@/m.test(run.stdout)) files[file] = { error: "a syntax error" };
    else files[file] = fileAnswer(text, run.stdout);
  }
  return { version, files };
}

/**
 * The reference's functions by file and its calls by function, `file:start-end`, or for the file,
 * `file:`; and the files it cannot parse. With rust-analyzer's answers, the names written as calls
 * in a macro's input that it answers as calls are calls too.
 */
export function referenceCounts(ref: RustReference, answers?: Answers): { functions: Map<string, string[]>; calls: Map<string, number>; errors: string[] } {
  const functions = new Map<string, string[]>();
  const calls = new Map<string, number>();
  const errors: string[] = [];
  for (const [file, answer] of Object.entries(ref.files)) {
    if ("error" in answer) {
      errors.push(`${file}: ${answer.error}`);
      continue;
    }
    functions.set(file, answer.functions);
    for (const [owner, n] of Object.entries(answer.calls)) calls.set(`${file}:${owner}`, n);
    if (answers === undefined) continue;
    for (const m of answer.inMacro) {
      if (answers.asCall(file, m.pos, m.name.length) === null) continue;
      const key = `${file}:${m.owner}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
    }
  }
  return { functions, calls, errors };
}

/** The kind of code a call is, by how it is written: a class of Rust's syntax, naming no repo. */
export const CAUSES: Record<CallShape, string> = {
  name: "a function or a constructor, called by its bare name",
  path: "an item, called by its path",
  method: "a method, called through a value",
};

/** The cause of a call in a macro's input, which the parser reads as tokens. */
export const IN_MACRO_CAUSE = "a function or a method, called in a macro's input";

/** The file `file` of the commit `sha`, or undefined when it has none. */
function fileAt(repoDir: string, sha: string, file: string): string | undefined {
  const run = spawnSync("git", ["show", `${sha}:${file}`], { cwd: repoDir, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : undefined;
}

type Answers = { at(file: string, pos: number, length: number): Answer; asCall(file: string, pos: number, length: number): Answer | null };

/** The names a call may be recorded by: as written, and as the name it is. */
const namesOf = (name: string): string[] => [...new Set([name, identifierName(name)])];

/** rust-analyzer's calls that name a definition in the repo: the reference's links. */
function referenceCalls(ref: RustReference, files: ReadonlySet<string>, answers: Answers): { calls: ReferenceCall[]; states: { repo: number; outside: number; notKnown: number } } {
  const calls: ReferenceCall[] = [];
  const states = { repo: 0, outside: 0, notKnown: 0 };
  for (const [file, answer] of Object.entries(ref.files)) {
    if (!files.has(file) || "error" in answer) continue;
    for (const c of answer.named) {
      const a = answers.at(file, c.pos, c.name.length);
      if (!("repo" in a)) {
        states["outside" in a ? "outside" : "notKnown"]++;
        continue;
      }
      states.repo++;
      calls.push({ file, line: c.line, pos: c.pos, names: namesOf(c.name), decls: [{ file: a.repo.file, spans: [{ start: a.repo.line, end: a.repo.line }] }], cause: CAUSES[c.shape] });
    }
    for (const m of answer.inMacro) {
      const a = answers.asCall(file, m.pos, m.name.length);
      if (a === null) continue;
      if (!("repo" in a)) {
        states["outside" in a ? "outside" : "notKnown"]++;
        continue;
      }
      states.repo++;
      calls.push({ file, line: m.line, pos: m.pos, names: namesOf(m.name), decls: [{ file: a.repo.file, spans: [{ start: a.repo.line, end: a.repo.line }] }], cause: IN_MACRO_CAUSE });
    }
  }
  return { calls, states };
}

/** The graph's linked calls in the given files. */
function graphCalls(db: Database, files: ReadonlySet<string>): (GraphCall & { dstName: string })[] {
  const rows = db
    .query(
      `SELECT s.path AS file, e.line AS line, e.pos AS pos, e.dst_name AS name, d.path AS dst, d.qualified_name AS dstName, d.start_line AS start, d.end_line AS end
         FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state = 'linked'`,
    )
    .all(BASE_LAYER) as (GraphCall & { dstName: string })[];
  return rows.filter((r) => files.has(r.file));
}

type Place = { name: string; start: number; end: number };

/** The graph's named nodes, by file: each one's own name and lines. */
function namedNodes(db: Database): Map<string, Place[]> {
  const rows = db
    .query("SELECT path, qualified_name AS qualified, start_line AS start, end_line AS end FROM symbols WHERE layer = ? AND kind != 'module' AND unnamed = 0")
    .all(BASE_LAYER) as { path: string; qualified: string; start: number; end: number }[];
  const out = new Map<string, Place[]>();
  for (const r of rows) out.set(r.path, [...(out.get(r.path) ?? []), { name: ownName(r.qualified), start: r.start, end: r.end }]);
  return out;
}

const ownName = (qualified: string): string => identifierName(qualified.slice(qualified.lastIndexOf(".") + 1));

/**
 * Links right: every link of the graph, judged against rust-analyzer's answer for the name at the
 * link's position. Right when rust-analyzer names a definition in the repo and the linked node is
 * the one that fits it by place (CODE_GRAPH.md, "Two ways to make links"): of its name, in its file,
 * its lines holding the definition, and, when two hold it, the one that starts on its line. Wrong
 * when rust-analyzer names another definition, or one outside the repo. A link rust-analyzer gives
 * no answer for, as way B reads it, is counted and not judged.
 */
function linksRight(answers: Answers, graph: readonly (GraphCall & { dstName: string })[], nodes: ReadonlyMap<string, Place[]>): { right: number; wrong: string[]; notJudged: number } {
  const result = { right: 0, wrong: [] as string[], notJudged: 0 };
  for (const g of graph) {
    const a = answers.at(g.file, g.pos, g.name.length);
    if ("notKnown" in a) {
      result.notJudged++;
      continue;
    }
    const repo = "repo" in a ? a.repo : undefined;
    const fits = (n: Place) => repo !== undefined && n.name === repo.name && n.start <= repo.line && n.end >= repo.line;
    const fit = repo === undefined || g.dst !== repo.file ? [] : (nodes.get(g.dst) ?? []).filter(fits);
    const own: Place = { name: ownName(g.dstName), start: g.start, end: g.end };
    if (fits(own) && g.dst === repo?.file && (fit.length === 1 || own.start === repo.line)) result.right++;
    else result.wrong.push(`${g.file}:${g.line} \`${g.name}\` -> ${g.dst}:${g.start}-${g.end}; rust-analyzer: ${JSON.stringify(a)}`);
  }
  return result;
}

/** How many missed calls of each cause the output shows. */
const EXAMPLES_PER_CAUSE = 3;

function examples(missed: readonly ReferenceCall[]): string[] {
  const shown = new Map<string, string[]>();
  for (const m of missed) {
    const here = shown.get(m.cause) ?? [];
    if (here.length < EXAMPLES_PER_CAUSE) here.push(`${m.file}:${m.line} \`${m.names[0] ?? ""}\``);
    shown.set(m.cause, here);
  }
  return [...shown].map(([cause, list]) => `missed, ${cause}: ${list.join(", ")}`);
}

/** Measures one way on the repo at `sha`. */
export async function measureRust(repoDir: string, sha: string, way: Way): Promise<Measured & { reference: string }> {
  const parser = (await loadParsers(["rust"])).get("rust");
  if (parser === undefined) throw new Error("the Rust grammar did not load");
  return withGraph(repoDir, sha, BUILD[way], (db, graphMs) => {
    const t = performance.now();
    const texts = languageTexts(repoDir, sha, LANGUAGES);
    const ref = rustReference(texts);
    // rust-analyzer as way B runs it: the commit's files, with Cargo's manifests read from it.
    const isManifest = (file: string) => (MANIFESTS as readonly string[]).includes(path.posix.basename(file));
    const ra = runRustAnalyzer({ files: texts, configs: new Map(), read: (file) => (isManifest(file) ? fileAt(repoDir, sha, file) : undefined) });
    const answers = readAnswers(texts, ra, parser);
    try {
      const { functions, calls, errors } = referenceCounts(ref, answers);
      const read = new Set([...parsedFiles(db)].filter((f) => texts.has(f)));
      const graph = graphCallCounts(db, read);
      // A call in a file rust-analyzer's parser cannot read has no reference to be accounted against.
      const scored = new Set([...read].filter((f) => functions.has(f)));
      const scoredGraph = graphCallCounts(db, scored);
      const linked = graphCalls(db, read);
      const links = linksRight(answers, linked, namedNodes(db));
      const reference = referenceCalls(ref, read, answers);
      const byReference = linksFoundByReference(reference.calls, linked);
      const scores: WayScores = {
        functionsFound: functionsFound(functions, graphFunctionLines(db, functions.keys())),
        linksRight: { n: links.right, of: links.right + links.wrong.length, ...(way === "B" ? { note: SAME_TOOL } : {}) },
        linksFoundByState: linksFoundByState(graph),
        linksFoundByReference: { n: byReference.n, of: byReference.of },
        callsAccountedFor: callsAccountedFor(calls, scoredGraph.byFunction),
        missesByCause: byReference.misses,
      };
      const { states } = reference;
      const detail = [
        `links right: ${linked.length} links, ${links.right} right, ${links.wrong.length} wrong, ${links.notJudged} rust-analyzer gives no answer for`,
        `calls: ${graph.linked + graph.outside + graph.notKnown} with a state, ${graph.linked} linked, ${graph.outside} outside, ${graph.notKnown} not known`,
        `files: ${texts.size} Rust files read by the page's rules, ${read.size} parsed by the graph, ${errors.length} rust-analyzer's parser cannot read`,
        `rust-analyzer: ${ra.workspaces.length} Cargo workspaces indexed, ${ra.errors.length} errors; its named calls: ${states.repo} in the repo, ${states.outside} outside, ${states.notKnown} no answer`,
        ...ra.failed.map((f) => `rust-analyzer failed: ${f}`),
        ...errors.map((e) => `not read by ${ref.version}: ${e}`),
        ...links.wrong.map((w) => `wrong link: ${w}`),
        ...examples(byReference.missed),
      ];
      return { scores, ms: { graph: graphMs, reference: Math.round(performance.now() - t) }, detail, reference: `${ref.version} parser and scip` };
    } finally {
      answers.close();
    }
  });
}
