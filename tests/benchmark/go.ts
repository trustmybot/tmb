// The benchmark's measure of a Go repo (trustmybot/tmb#352): each way's graph against Go's own
// tools. Go's parser, go/parser, is the reference for the functions and the calls; Go's type
// checker, go/types, run by the helper way B carries (languages/go/tool.ts), is the reference for
// the links. Way B's links are made by that same type checker, so its links right is no proof of
// way B. The type checker is run with an empty module cache unless one is given, so the scores do
// not depend on what the machine has downloaded: a call into a module is then not known.
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BuildOptions, MAX_PARSE_BYTES } from "../../src/engine/graph/build.ts";
import { BASE_LAYER } from "../../src/engine/graph/db.ts";
import { languageOf, leftOutRule, NODE_MODULES_RULE, type SourceLanguage } from "../../src/engine/graph/extract.ts";
import { commitReader, listTree, readBlobs } from "../../src/engine/graph/git-source.ts";
import { type HelperCall, type HelperOutput, NODE_DECLARATIONS, runHelper } from "../../src/engine/graph/languages/go/tool.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { callsAccountedFor, functionsFound, type GraphCall, linksFoundByReference, linksFoundByState, type ReferenceCall, type Way, type WayScores } from "./score.ts";
import type { Measured } from "./typescript.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["go"]);

/**
 * The version of the Go reference, raised when the reference changes what it counts.
 * 2: links are judged against Go's type checker.
 */
export const REFERENCE_VERSION = 2;

/** How each way builds the graph, as the program builds it. */
const BUILD: Record<Way, BuildOptions> = {
  A: { links: "built-in" },
  B: { links: "language-tool" },
};

/** Way B's links are made by the very tool that judges them. */
export const SAME_TOOL = "same tool as the reference";

const PROGRAM = path.join(import.meta.dir, "go_reference.go");

/** The answer of go_reference.go for each file. */
type FileAnswer = { functions: string[]; calls: Record<string, number> } | { error: string };
export type GoReference = { version: string; files: Record<string, FileAnswer> };

/** Go's own parser's functions and calls for the given files, run with the `go` on PATH. */
export function goReference(texts: ReadonlyMap<string, string>, go = "go"): GoReference {
  const run = spawnSync(go, ["run", PROGRAM], { input: JSON.stringify({ files: Object.fromEntries(texts) }), encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (run.error !== undefined || run.status !== 0) throw new Error(`${go} run ${PROGRAM} failed: ${run.error?.message ?? run.stderr}`);
  return JSON.parse(run.stdout) as GoReference;
}

/** The reference's functions by file and its calls by function, `file:start-end`, or for the file, `file:`; and the files it cannot parse. */
export function referenceCounts(ref: GoReference): { functions: Map<string, string[]>; calls: Map<string, number>; errors: string[] } {
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

/** Go's type checker's answer for every call of the repo at `sha`, given the files way B's tool is given, with the module cache `modules`. */
export function typeCheckerReference(repoDir: string, sha: string, modules: string): HelperOutput {
  const tree = listTree(repoDir, sha);
  const entries = tree.filter((e) => e.size <= MAX_PARSE_BYTES && leftOutRule(e.path) !== NODE_MODULES_RULE && languageOf(e.path, () => "") === "go");
  const blobs = readBlobs(
    repoDir,
    entries.map((e) => e.blob),
  );
  const files = new Map<string, string>();
  for (const e of entries) {
    const text = blobs.get(e.blob);
    if (text !== undefined) files.set(e.path, text);
  }
  const restore = useModules(modules);
  try {
    return runHelper({ files, read: commitReader(repoDir, tree) });
  } finally {
    restore();
  }
}

/** Sets GOMODCACHE to `modules`, and returns how to put it back. */
function useModules(modules: string): () => void {
  const before = process.env.GOMODCACHE;
  process.env.GOMODCACHE = modules;
  return () => {
    if (before === undefined) delete process.env.GOMODCACHE;
    else process.env.GOMODCACHE = before;
  };
}

/** The kind of code a call is, by how its callee is written and what it names: a class of Go's syntax, naming no repo. */
export const CAUSES = {
  func: "a function of the package, called by its name",
  imported: "a function of another package, called through its import",
  method: "a method, called on a value",
  interfaceMethod: "a method of an interface, called on a value",
  conversion: "a conversion to a type",
  data: "a package-level variable, called",
} as const;

function causeOf(c: HelperCall): string {
  const what = c.answer.repo?.what;
  if (c.kind === "conversion") return CAUSES.conversion;
  if (what === "method") return CAUSES.method;
  if (what === "interface method") return CAUSES.interfaceMethod;
  if (what === "var" || what === "const") return CAUSES.data;
  return c.callee === "pkgname" ? CAUSES.imported : CAUSES.func;
}

/** The type checker's calls that declare a node of the graph in the repo: the reference's links. */
function referenceCalls(out: HelperOutput, files: ReadonlySet<string>): ReferenceCall[] {
  const refs: ReferenceCall[] = [];
  for (const c of out.calls) {
    const repo = c.answer.repo;
    if (!files.has(c.file) || repo === undefined || !NODE_DECLARATIONS.has(repo.what)) continue;
    refs.push({ file: c.file, line: c.line, pos: c.pos, names: [c.name], decls: [{ file: repo.file, spans: [{ start: repo.line, end: repo.line }] }], cause: causeOf(c) });
  }
  return refs;
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

/** The graph's named nodes in Go files, by file: each one's own name and lines. */
function namedNodes(db: Database): Map<string, { name: string; start: number; end: number }[]> {
  const rows = db
    .query("SELECT path, qualified_name AS qualified, start_line AS start, end_line AS end FROM symbols WHERE layer = ? AND kind != 'module' AND unnamed = 0")
    .all(BASE_LAYER) as { path: string; qualified: string; start: number; end: number }[];
  const out = new Map<string, { name: string; start: number; end: number }[]>();
  for (const r of rows) out.set(r.path, [...(out.get(r.path) ?? []), { name: r.qualified.slice(r.qualified.lastIndexOf(".") + 1), start: r.start, end: r.end }]);
  return out;
}

/**
 * Links right: every link of the graph, judged against the type checker's answer for the call at
 * the link's position, of its name. Right when the type checker names a declaration that is a node
 * of the linked node's name, in its file, and the linked node is the innermost of that name holding
 * the declaration's line: an interface's method, not the type around it. A link the type checker
 * has no call for, in a file it does not load, is counted and not judged.
 */
function linksRight(out: HelperOutput, graph: readonly (GraphCall & { dstName: string })[], nodes: ReadonlyMap<string, { name: string; start: number; end: number }[]>): { right: number; wrong: string[]; notJudged: number } {
  const byPlace = new Map(out.calls.map((c) => [`${c.file}:${c.pos}:${c.name}`, c]));
  const result = { right: 0, wrong: [] as string[], notJudged: 0 };
  for (const g of graph) {
    const c = byPlace.get(`${g.file}:${g.pos}:${g.name}`);
    if (c === undefined) {
      result.notJudged++;
      continue;
    }
    const repo = c.answer.repo;
    const own = g.dstName.slice(g.dstName.lastIndexOf(".") + 1);
    const holds = (n: { start: number; end: number }) => repo !== undefined && n.start <= repo.line && n.end >= repo.line;
    const inner = (nodes.get(g.dst) ?? []).some((n) => n.name === own && holds(n) && n.end - n.start < g.end - g.start);
    if (repo !== undefined && NODE_DECLARATIONS.has(repo.what) && repo.file === g.dst && repo.name === own && holds(g) && !inner) result.right++;
    else result.wrong.push(`${g.file}:${g.line} \`${g.name}\` -> ${g.dst}:${g.start}-${g.end}; the type checker: ${JSON.stringify(c.answer)}`);
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

/**
 * Measures one way on the repo at `sha`. `modules` is the module cache the type checker reads, for
 * way B and the reference alike; without one it is empty, as on a machine that downloaded nothing.
 */
export async function measureGo(repoDir: string, sha: string, way: Way, modules?: string): Promise<Measured & { reference: string }> {
  const empty = modules === undefined ? mkdtempSync(path.join(tmpdir(), "tmb-benchmark-gomods-")) : undefined;
  const cache = modules ?? empty!;
  const restore = useModules(cache);
  try {
    return await withGraph(repoDir, sha, BUILD[way], (db, graphMs) => {
        const t = performance.now();
        const texts = languageTexts(repoDir, sha, LANGUAGES);
        const ref = goReference(texts);
        const { functions, calls, errors } = referenceCounts(ref);
        const checker = typeCheckerReference(repoDir, sha, cache);
        const read = new Set([...parsedFiles(db)].filter((f) => texts.has(f)));
        const graph = graphCallCounts(db, read);
        // A call in a file Go's parser cannot read has no reference to be accounted against.
        const scored = new Set([...read].filter((f) => functions.has(f)));
        const scoredGraph = graphCallCounts(db, scored);
        const linked = graphCalls(db, read);
        const links = linksRight(checker, linked, namedNodes(db));
        const byReference = linksFoundByReference(referenceCalls(checker, read), linked);
        const loaded = new Set(checker.loaded);
        const scores: WayScores = {
          functionsFound: functionsFound(functions, graphFunctionLines(db, functions.keys())),
          linksRight: { n: links.right, of: links.right + links.wrong.length, ...(way === "B" ? { note: SAME_TOOL } : {}) },
          linksFoundByState: linksFoundByState(graph),
          linksFoundByReference: { n: byReference.n, of: byReference.of },
          callsAccountedFor: callsAccountedFor(calls, scoredGraph.byFunction),
          missesByCause: byReference.misses,
        };
        const detail = [
          `links right: ${linked.length} links, ${links.right} right, ${links.wrong.length} wrong, ${links.notJudged} in files the type checker does not load`,
          `calls: ${graph.linked + graph.outside + graph.notKnown} with a state, ${graph.linked} linked, ${graph.outside} outside, ${graph.notKnown} not known`,
          `files: ${texts.size} Go files read by the page's rules, ${read.size} parsed by the graph, ${errors.length} Go's parser cannot read, ${[...read].filter((f) => !loaded.has(f)).length} the type checker does not load`,
          `the type checker: ${checker.go}, modules ${modules === undefined ? "none on disk" : "from the given module cache"}, ${checker.errors} errors${checker.firstErrors.length > 0 ? `, first: ${checker.firstErrors[0]}` : ""}`,
          ...errors.map((e) => `not read by ${ref.version}: ${e}`),
          ...links.wrong.map((w) => `wrong link: ${w}`),
          ...examples(byReference.missed),
        ];
        return { scores, ms: { graph: graphMs, reference: Math.round(performance.now() - t) }, detail, reference: `${ref.version} go/parser and go/types` };
    });
  } finally {
    restore();
    if (empty !== undefined) rmSync(empty, { recursive: true, force: true });
  }
}
