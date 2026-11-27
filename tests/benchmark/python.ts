// The benchmark's measure of a Python repo (trustmybot/tmb#244): each way's graph against Python's
// own parser for the functions and the calls, and against a type checker, pyright, for the links
// (trustmybot/tmb#399): its answer where it gives one; a call it gives no answer for is counted and
// not judged. Way B is pyright too, tmb's pinned copy (trustmybot/tmb#347), built as the
// program builds it; the reference asks pyright itself (python_checker.ts), not way B's graph.
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { BUILT_IN_RULES, type BuildOptions } from "../../src/engine/graph/build.ts";
import { BASE_LAYER, layerRow } from "../../src/engine/graph/db.ts";
import type { SourceLanguage } from "../../src/engine/graph/extract.ts";
import { listTree, resolveCommit } from "../../src/engine/graph/git-source.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { CHECKER_VERSION, checkerDeclarations, type Declaration } from "./python_checker.ts";
import { callsAccountedFor, functionsFound, type GraphCall, linksFoundByReference, linksFoundByState, type ReferenceCall, type Way, type WayScores } from "./score.ts";
import type { Measured } from "./typescript.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["python"]);

/** Way B's links are made by the very tool that judges them: links right is shown, and it is no proof of way B. */
export const SAME_TOOL = "same tool as the reference";

/** How each way builds the graph, as the program builds it: way B uses tmb's pinned copy of pyright. */
const BUILD: Record<Way, BuildOptions> = {
  A: { links: "built-in" },
  B: { links: "language-tool" },
};

/**
 * The version of the Python reference, raised when the reference changes what it counts.
 * 3: links are judged against pyright's answer (trustmybot/tmb#399).
 */
export const REFERENCE_VERSION = 3;

const SCRIPT = path.join(import.meta.dir, "python_reference.py");

/** The answer of python_reference.py for each file. */
type FileAnswer = { functions: string[]; calls: Record<string, number>; sites: Site[]; declarations: Record<string, [string, DeclaredKind, number]> } | { error: string };
/** A call whose callee is a name: its offset, line and character where the name is written, the names it may be recorded by, and how the callee is written. */
type Site = [number, number, number, string[], Shape];
type Shape = "name" | "self" | "parent" | "attribute" | "chain";
type DeclaredKind = "class" | "function" | "data";
export type PythonReference = { version: string; files: Record<string, FileAnswer> };

/** Python's own parser's functions and calls for the given files, run with the Python on PATH in isolated mode. */
export function pythonReference(texts: ReadonlyMap<string, string>, python = "python3"): PythonReference {
  const run = spawnSync(python, ["-I", SCRIPT], { input: JSON.stringify({ files: Object.fromEntries(texts) }), encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (run.error !== undefined || run.status !== 0) throw new Error(`${python} ${SCRIPT} failed: ${run.error?.message ?? run.stderr}`);
  return JSON.parse(run.stdout) as PythonReference;
}

/** The reference's functions by file and its calls by function, `file:start-end`, or for the file, `file:`; and the files it cannot parse. */
export function referenceCounts(ref: PythonReference): { functions: Map<string, string[]>; calls: Map<string, number>; errors: string[] } {
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

/**
 * The kind of code a call is, by how its callee is written and what pyright declares it as, for the
 * misses by cause. Each kind is a class of Python's syntax; none names a repo or a symbol.
 */
export const LINK_CAUSES = {
  direct: "a function's name called directly",
  construct: "a construction by a class's name",
  data: "a name of file-level data, called",
  self: "a method on the method's first parameter (`self`, `cls`)",
  parent: "a method on `super()`",
  attribute: "a method on a name",
  chain: "a method on an expression (a chain, a call's result, an index)",
} as const;

/** A declaration pyright gives that is a node of the graph: its file, its name, what it is, and the line of the node. */
type NodeDeclaration = { file: string; name: string; kind: DeclaredKind; line: number };
/** pyright's answer at one place: none, or the declarations it gives, those that are nodes apart. */
export type CheckerAnswer = { answered: false } | { answered: true; nodes: NodeDeclaration[]; outside: number; inRepo: number };

const placeKey = (file: string, pos: number) => `${file}:${pos}`;

/** The line from 0 and the character, in UTF-16 units, at an offset of a text, with Python's line breaks. */
function lspPosition(text: string, pos: number): { line: number; character: number } {
  let line = 0;
  let start = 0;
  for (let i = 0; i < pos; i++) {
    const c = text[i];
    if (c === "\r" && text[i + 1] === "\n") continue;
    if (c === "\n" || c === "\r") {
      line++;
      start = i + 1;
    }
  }
  return { line, character: pos - start };
}

/**
 * pyright's answer at each place of the repo at `sha`: every call site Python's parser finds, and
 * each place in `extra`, by `file:pos`. The working tree must be at `sha`: pyright reads the
 * project's config from it. A declaration is in the repo when its file is a file of the commit; it
 * is a node when Python's parser declares a node at that place, of that name.
 */
export async function checkerAnswers(repoDir: string, sha: string, texts: ReadonlyMap<string, string>, ref: PythonReference, extra: readonly { file: string; pos: number }[]): Promise<Map<string, CheckerAnswer>> {
  const root = path.resolve(repoDir);
  const head = resolveCommit(root, "HEAD");
  if (head !== sha) throw new Error(`pyright reads the project's config from the working tree, which is at ${head ?? "no commit"}, not ${sha}`);
  const tracked = new Set(listTree(root, sha).map((e) => e.path));
  const places = new Map<string, { file: string; pos: number }>();
  // A site is asked about where its name is written. Python's parser places a call inside an
  // f-string by an approximate column before Python 3.12; a site whose name is not written where it
  // is placed is not asked about, and is counted apart.
  for (const [file, answer] of Object.entries(ref.files)) {
    if ("error" in answer) continue;
    const text = texts.get(file);
    for (const [pos, , , names] of answer.sites) if (text?.startsWith(names[0]!, pos) === true) places.set(placeKey(file, pos), { file, pos });
  }
  for (const e of extra) places.set(placeKey(e.file, e.pos), e);
  const asked = [...places.values()].filter((p) => texts.has(p.file));
  const found = await checkerDeclarations(
    root,
    texts,
    asked.map((p) => ({ file: p.file, at: lspPosition(texts.get(p.file)!, p.pos) })),
  );
  const nodeOf = (d: Declaration): NodeDeclaration | null => {
    const file = path.relative(root, d.file).split(path.sep).join("/");
    const answer = ref.files[file];
    if (answer === undefined || "error" in answer || d.start.line !== d.end.line) return null;
    const declared = answer.declarations[`${d.start.line}:${d.start.character}`];
    if (declared === undefined) return null;
    const [name, kind, line] = declared;
    // The range is the name's own: a module's range is empty, and never a name's.
    if (d.end.character - d.start.character !== name.length) return null;
    return { file, name, kind, line };
  };
  const out = new Map<string, CheckerAnswer>();
  asked.forEach((p, i) => {
    const decls = found[i];
    if (decls === null || decls === undefined) {
      out.set(placeKey(p.file, p.pos), { answered: false });
      return;
    }
    const isOwn = (d: Declaration) => {
      const rel = path.relative(root, d.file);
      return !rel.startsWith("..") && !path.isAbsolute(rel) && tracked.has(rel.split(path.sep).join("/"));
    };
    const own = decls.filter(isOwn);
    const nodes = own.map(nodeOf).filter((n): n is NodeDeclaration => n !== null);
    out.set(placeKey(p.file, p.pos), { answered: true, nodes, outside: decls.length - own.length, inRepo: own.length });
  });
  return out;
}

function causeOf(shape: Shape, nodes: readonly NodeDeclaration[]): string {
  if (shape !== "name") return LINK_CAUSES[shape];
  if (nodes.some((n) => n.kind === "class")) return LINK_CAUSES.construct;
  if (nodes.every((n) => n.kind === "data")) return LINK_CAUSES.data;
  return LINK_CAUSES.direct;
}

/**
 * The reference's links: every call site in the files `read` that pyright declares as a node of the
 * graph, with each such declaration; and the sites counted, those pyright gives no answer for, those
 * it places only outside the repo, and those it declares in the repo as no node.
 */
export function referenceLinks(ref: PythonReference, answers: ReadonlyMap<string, CheckerAnswer>, read: ReadonlySet<string>): { calls: ReferenceCall[]; counts: { sites: number; misplaced: number; noAnswer: number; outside: number; noNode: number } } {
  const calls: ReferenceCall[] = [];
  const counts = { sites: 0, misplaced: 0, noAnswer: 0, outside: 0, noNode: 0 };
  for (const [file, answer] of Object.entries(ref.files)) {
    if ("error" in answer || !read.has(file)) continue;
    for (const [pos, line, , names, shape] of answer.sites) {
      counts.sites++;
      const a = answers.get(placeKey(file, pos));
      if (a === undefined) {
        counts.misplaced++;
        continue;
      }
      if (!a.answered) {
        counts.noAnswer++;
        continue;
      }
      if (a.nodes.length === 0) {
        if (a.inRepo === 0) counts.outside++;
        else counts.noNode++;
        continue;
      }
      const byFile = new Map<string, number[]>();
      for (const n of a.nodes) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n.line]);
      const decls = [...byFile].map(([f, lines]) => ({ file: f, spans: [...new Set(lines)].map((l) => ({ start: l, end: l })) }));
      calls.push({ file, line, pos, names, decls, cause: causeOf(shape, a.nodes) });
    }
  }
  return { calls, counts };
}

/** One link of the graph: where it is, and the node it links, by its own name and lines. */
export type PythonLink = { file: string; pos: number; dst: string; dstName: string; start: number; end: number };
export type NamedNodes = ReadonlyMap<string, readonly { name: string; start: number; end: number }[]>;

/**
 * The verdict on one link (CODE_GRAPH.md, Benchmark): right when pyright, at the link's position,
 * gives a declaration that is the linked node: in its file, of its name, on a line it holds, and
 * no smaller node of that name holds that line. Wrong when pyright gives declarations and none is,
 * those outside the repo included. Not judged when pyright gives none.
 */
export function judgeLink(link: PythonLink, answers: ReadonlyMap<string, CheckerAnswer>, nodes: NamedNodes): "right" | "wrong" | "not judged" {
  const a = answers.get(placeKey(link.file, link.pos));
  if (a === undefined || !a.answered) return "not judged";
  const holds = (n: { start: number; end: number }, line: number) => n.start <= line && n.end >= line;
  const right = a.nodes.some(
    (d) =>
      d.file === link.dst &&
      d.name === link.dstName &&
      holds(link, d.line) &&
      !(nodes.get(link.dst) ?? []).some((n) => n.name === d.name && holds(n, d.line) && n.end - n.start < link.end - link.start),
  );
  return right ? "right" : "wrong";
}

/** Every call link of the graph from the given files: where it is, and the node it links. */
function graphLinks(db: Database, files: ReadonlySet<string>): (PythonLink & GraphCall)[] {
  const rows = db
    .query(
      `SELECT s.path AS file, e.line AS line, e.pos AS pos, e.dst_name AS name, d.path AS dst, d.qualified_name AS qualified, d.start_line AS start, d.end_line AS end
         FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state = 'linked'`,
    )
    .all(BASE_LAYER) as { file: string; line: number; pos: number | null; name: string; dst: string; qualified: string; start: number | null; end: number | null }[];
  return rows
    .filter((r) => files.has(r.file) && r.pos !== null)
    .map((r) => ({ file: r.file, line: r.line, pos: r.pos!, name: r.name, dst: r.dst, dstName: r.qualified.slice(r.qualified.lastIndexOf(".") + 1), start: r.start ?? 0, end: r.end ?? r.start ?? 0 }));
}

/** The graph's named nodes, by file: each one's own name and lines. */
function namedNodes(db: Database): Map<string, { name: string; start: number; end: number }[]> {
  const rows = db
    .query("SELECT path, qualified_name AS qualified, start_line AS start, end_line AS end FROM symbols WHERE layer = ? AND kind != 'file' AND unnamed = 0")
    .all(BASE_LAYER) as { path: string; qualified: string; start: number; end: number }[];
  const out = new Map<string, { name: string; start: number; end: number }[]>();
  for (const r of rows) out.set(r.path, [...(out.get(r.path) ?? []), { name: r.qualified.slice(r.qualified.lastIndexOf(".") + 1), start: r.start, end: r.end }]);
  return out;
}

/** How many missed calls of each cause, and wrong links, the output shows. */
const EXAMPLES = 3;

function examples(missed: readonly ReferenceCall[]): string[] {
  const shown = new Map<string, string[]>();
  for (const m of missed) {
    const here = shown.get(m.cause) ?? [];
    if (here.length < EXAMPLES) here.push(`${m.file}:${m.line} \`${m.names[0] ?? ""}\``);
    shown.set(m.cause, here);
  }
  return [...shown].map(([cause, list]) => `missed, ${cause}: ${list.join(", ")}`);
}

/** Measures one way on the repo at `sha`. */
export async function measurePython(repoDir: string, sha: string, way: Way): Promise<Measured & { reference: string }> {
  return withGraph(repoDir, sha, BUILD[way], async (db, graphMs) => {
    // A way B graph whose Python fell back to the built-in rules is no measure of way B. The note
    // names, per part, the languages it is about: `python, …: why`; a part about what pyright's
    // answers rest on, such as which environment it read, is no fallback.
    const note = (layerRow(db, BASE_LAYER)?.links_note ?? "")
      .split("; ")
      .find((part) => part.endsWith(BUILT_IN_RULES) && part.split(":")[0]!.split(", ").some((lang) => LANGUAGES.has(lang as SourceLanguage)));
    if (way === "B" && note !== undefined) throw new Error(`way B was not built: ${note}`);
    const t = performance.now();
    const texts = languageTexts(repoDir, sha, LANGUAGES);
    const ref = pythonReference(texts);
    const { functions, calls, errors } = referenceCounts(ref);
    const read = new Set([...parsedFiles(db)].filter((f) => texts.has(f)));
    const graph = graphCallCounts(db, read);
    // A call in a file Python's parser cannot read has no reference to be accounted against.
    const scored = new Set([...read].filter((f) => functions.has(f)));
    const scoredGraph = graphCallCounts(db, scored);
    // The links: pyright's answer at every call site, and at every link of the graph.
    const linked = graphLinks(db, read);
    const answers = await checkerAnswers(repoDir, sha, texts, ref, linked);
    const nodes = namedNodes(db);
    const verdicts = { right: 0, wrong: [] as string[], notJudged: [] as string[] };
    for (const link of linked) {
      const v = judgeLink(link, answers, nodes);
      if (v === "right") verdicts.right++;
      else if (v === "not judged") verdicts.notJudged.push(`${link.file}:${link.line} \`${link.name}\``);
      else {
        const a = answers.get(placeKey(link.file, link.pos));
        const said = a?.answered === true ? [...a.nodes.map((n) => `${n.file}:${n.line} ${n.name}`), ...(a.inRepo > a.nodes.length ? ["a declaration in the repo that is no node"] : []), ...(a.outside > 0 ? ["outside the repo"] : [])].join(" | ") : "";
        verdicts.wrong.push(`${link.file}:${link.line} \`${link.name}\` -> ${link.dst}:${link.start}-${link.end} ${link.dstName}; pyright: ${said}`);
      }
    }
    const reference = referenceLinks(ref, answers, scored);
    const byReference = linksFoundByReference(reference.calls, linked);
    const scores: WayScores = {
      functionsFound: functionsFound(functions, graphFunctionLines(db, functions.keys())),
      linksRight: { n: verdicts.right, of: verdicts.right + verdicts.wrong.length, ...(way === "B" ? { note: SAME_TOOL } : {}) },
      linksFoundByState: linksFoundByState(graph),
      linksFoundByReference: { n: byReference.n, of: byReference.of },
      callsAccountedFor: callsAccountedFor(calls, scoredGraph.byFunction),
      missesByCause: byReference.misses,
    };
    const c = reference.counts;
    const detail = [
      `links right: ${linked.length} links, ${verdicts.right} right, ${verdicts.wrong.length} wrong, ${verdicts.notJudged.length} not judged (pyright gives no answer)${verdicts.notJudged.length > 0 ? `, such as ${verdicts.notJudged.slice(0, EXAMPLES).join(", ")}` : ""}`,
      `reference links: ${c.sites} calls whose callee is a name, ${reference.calls.length} declared as a node, ${c.misplaced} not where Python's parser places them (not judged), ${c.noAnswer} no answer (not judged), ${c.outside} outside the repo, ${c.noNode} declared in the repo as no node`,
      `calls: ${graph.linked + graph.outside + graph.notKnown} with a state, ${graph.linked} linked, ${graph.outside} outside, ${graph.notKnown} not known`,
      `files: ${texts.size} Python files read by the page's rules, ${read.size} parsed by the graph, ${errors.length} Python's parser cannot read`,
      ...errors.map((e) => `not read by Python ${ref.version}: ${e}`),
      ...verdicts.wrong.map((w) => `wrong link: ${w}`),
      ...examples(byReference.missed),
    ];
    return { scores, ms: { graph: graphMs, reference: Math.round(performance.now() - t) }, detail, reference: `Python ${ref.version} ast, pyright ${CHECKER_VERSION}` };
  });
}
