// The benchmark's measure of a Rust repo (trustmybot/tmb#354): way A's graph against Rust's own
// parser, rust-analyzer's (`rust-analyzer parse`), for the functions and the calls. The links have
// no reference until way B's rust-analyzer comes: they are counted, from the call states, and not
// judged here.
//
// What the reference counts, by its syntax tree:
// - a function: each FN node, but one in an `extern` block, whose code is elsewhere; and each
//   CLOSURE_EXPR. A FN starts at its first doc comment or attribute (DOC_COMMENT, ATTR), else at
//   its first token that is no comment;
// - a call: each CALL_EXPR and METHOD_CALL_EXPR, in the innermost function around it, else in the
//   file. A macro's input is a token tree to both parsers: neither finds a call in it.
import { spawnSync } from "node:child_process";
import type { SourceLanguage } from "../../src/engine/graph/extract.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { callsAccountedFor, functionsFound, linksFoundByState, type WayScores } from "./score.ts";
import type { Measured } from "./typescript.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["rust"]);

/** Why Rust's links have no score yet. */
export const LINKS_NOT_JUDGED = "not judged: Rust's links have no reference yet (rust-analyzer, trustmybot/tmb#354)";

/** Why Rust has no way B yet: its tool is not built. */
export const WAY_B_NOT_BUILT = "not built (rust-analyzer, trustmybot/tmb#354)";

/** The version of the Rust reference, raised when the reference changes what it counts. */
export const REFERENCE_VERSION = 1;

const FUNCTION_NODES: ReadonlySet<string> = new Set(["FN", "CLOSURE_EXPR"]);
const CALL_NODES: ReadonlySet<string> = new Set(["CALL_EXPR", "METHOD_CALL_EXPR"]);
const EXTERN_ITEMS = "EXTERN_ITEM_LIST";
const LEADING = new Set(["DOC_COMMENT", "ATTR"]);
const TRIVIA = new Set(["WHITESPACE", "COMMENT"]);

type FileAnswer = { functions: string[]; calls: Record<string, number> } | { error: string };
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
  const nodes = treeLines(tree);
  const functions: string[] = [];
  const calls: Record<string, number> = {};
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
        const kids: TreeLine[] = [];
        for (let j = i + 1; j < nodes.length && nodes[j]!.depth > n.depth; j++) if (nodes[j]!.depth === n.depth + 1) kids.push(nodes[j]!);
        const lead = kids.find((k) => LEADING.has(k.kind)) ?? kids.find((k) => !TRIVIA.has(k.kind));
        if (lead) start = lead.start;
      }
      fn = `${lineOf(start)}-${lineOf(Math.max(n.start, n.end - 1))}`;
      functions.push(fn);
    }
    if (CALL_NODES.has(n.kind)) {
      const key = fn ?? "";
      calls[key] = (calls[key] ?? 0) + 1;
    }
    stack.push({ line: n, fn });
  }
  return { functions, calls };
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

/** The reference's functions by file and its calls by function, `file:start-end`, or for the file, `file:`; and the files it cannot parse. */
export function referenceCounts(ref: RustReference): { functions: Map<string, string[]>; calls: Map<string, number>; errors: string[] } {
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
  }
  return { functions, calls, errors };
}

/** Measures way A on the repo at `sha`. */
export async function measureRust(repoDir: string, sha: string): Promise<Measured & { reference: string }> {
  return withGraph(repoDir, sha, {}, (db, graphMs) => {
    const t = performance.now();
    const texts = languageTexts(repoDir, sha, LANGUAGES);
    const ref = rustReference(texts);
    const { functions, calls, errors } = referenceCounts(ref);
    const read = new Set([...parsedFiles(db)].filter((f) => texts.has(f)));
    const graph = graphCallCounts(db, read);
    // A call in a file rust-analyzer's parser cannot read has no reference to be accounted against.
    const scored = new Set([...read].filter((f) => functions.has(f)));
    const scoredGraph = graphCallCounts(db, scored);
    const scores: WayScores = {
      functionsFound: functionsFound(functions, graphFunctionLines(db, functions.keys())),
      linksRight: { notScored: LINKS_NOT_JUDGED },
      linksFoundByState: linksFoundByState(graph),
      linksFoundByReference: { notScored: LINKS_NOT_JUDGED },
      callsAccountedFor: callsAccountedFor(calls, scoredGraph.byFunction),
      missesByCause: { notScored: LINKS_NOT_JUDGED },
    };
    const detail = [
      `calls: ${graph.linked + graph.outside + graph.notKnown} with a state, ${graph.linked} linked, ${graph.outside} outside, ${graph.notKnown} not known`,
      `files: ${texts.size} Rust files read by the page's rules, ${read.size} parsed by the graph, ${errors.length} rust-analyzer's parser cannot read`,
      ...errors.map((e) => `not read by ${ref.version}: ${e}`),
    ];
    return { scores, ms: { graph: graphMs, reference: Math.round(performance.now() - t) }, detail, reference: `${ref.version} parser` };
  });
}
