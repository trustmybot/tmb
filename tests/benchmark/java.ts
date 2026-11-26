// The benchmark's measure of a Java repo (trustmybot/tmb#353): each way's graph against Java's own
// tools. javac's parser is the reference for the functions and the calls; javac itself, run by the
// adapter way B carries (languages/java/tool.ts), is the reference for the links. Way B's links are
// made by that same compiler, so its links right is no proof of way B. javac reads no class path, so
// the scores do not depend on what the machine has: a call into a library is not known.
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildOptions } from "../../src/engine/graph/build.ts";
import { BASE_LAYER } from "../../src/engine/graph/db.ts";
import type { SourceLanguage } from "../../src/engine/graph/extract.ts";
import { type AdapterCall, type AdapterOutput, runAdapter } from "../../src/engine/graph/languages/java/tool.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { callsAccountedFor, functionsFound, type GraphCall, linksFoundByReference, linksFoundByState, type ReferenceCall, type Way, type WayScores } from "./score.ts";
import type { Measured } from "./typescript.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["java"]);

/**
 * The version of the Java reference, raised when the reference changes what it counts.
 * 2: links are judged against javac.
 */
export const REFERENCE_VERSION = 2;

/** How each way builds the graph, as the program builds it. */
const BUILD: Record<Way, BuildOptions> = {
  A: { links: "built-in" },
  B: { links: "language-tool" },
};

/** Way B's links are made by the very tool that judges them. */
export const SAME_TOOL = "same tool as the reference";

const PROGRAM = path.join(import.meta.dir, "java_reference.java");

/** The answer of java_reference.java for each file. */
type FileAnswer = { functions: string[]; calls: Record<string, number> } | { error: string };
export type JavaReference = { version: string; files: Record<string, FileAnswer> };

/** javac's parser's functions and calls for the given files, run with the `java` on PATH; the files are written to a scratch folder for it. */
export function javaReference(texts: ReadonlyMap<string, string>, java = "java"): JavaReference {
  const dir = mkdtempSync(path.join(tmpdir(), "tmb-java-reference-"));
  try {
    for (const [file, text] of texts) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    const run = spawnSync(java, [PROGRAM, dir], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    if (run.error !== undefined || run.status !== 0) throw new Error(`${java} ${PROGRAM} failed: ${run.error?.message ?? run.stderr}`);
    return JSON.parse(run.stdout) as JavaReference;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The reference's functions by file and its calls by function, `file:start-end`, or for the file, `file:`; and the files it cannot parse. */
export function referenceCounts(ref: JavaReference): { functions: Map<string, string[]>; calls: Map<string, number>; errors: string[] } {
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

/** The kind of code a call is, by how it is written: a class of Java's syntax, naming no repo. */
export const CAUSES: Record<AdapterCall["callee"], string> = {
  name: "a method, called by its simple name",
  qualified: "a method, called through a value or a type",
  creation: "a construction of a class",
  this: "`this(…)`, a constructor of the class itself",
  super: "`super(…)`, a constructor of the superclass",
};

/** javac's calls that declare something in the repo: the reference's links. */
function referenceCalls(out: AdapterOutput, files: ReadonlySet<string>): ReferenceCall[] {
  const refs: ReferenceCall[] = [];
  for (const c of out.calls) {
    const repo = c.answer.repo;
    if (!files.has(c.file) || repo === undefined) continue;
    refs.push({ file: c.file, line: c.line, pos: c.pos, names: [c.name], decls: [{ file: repo.file, spans: [{ start: repo.start, end: repo.end }] }], cause: CAUSES[c.callee] });
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

type Place = { name: string; start: number; end: number };

/** The graph's named nodes, by file: each one's own name and lines. */
function namedNodes(db: Database): Map<string, Place[]> {
  const rows = db
    .query("SELECT path, qualified_name AS qualified, start_line AS start, end_line AS end FROM symbols WHERE layer = ? AND kind != 'file' AND unnamed = 0")
    .all(BASE_LAYER) as { path: string; qualified: string; start: number; end: number }[];
  const out = new Map<string, Place[]>();
  for (const r of rows) out.set(r.path, [...(out.get(r.path) ?? []), { name: ownName(r.qualified), start: r.start, end: r.end }]);
  return out;
}

const ownName = (qualified: string): string => qualified.slice(qualified.lastIndexOf(".") + 1);

/**
 * Links right: every link of the graph, judged against javac's answer for the call at the link's
 * position, of its name. Right when javac names a declaration in the repo and the linked node is the
 * one that fits it by place (CODE_GRAPH.md, "Two ways to make links"): of its name, in its file, over
 * its lines, and, when two fit, the one that starts on its first line. Wrong when javac names another
 * declaration, or one outside the repo. A link javac cannot answer for, with no call there or an
 * answer that rests on an error, is counted and not judged.
 */
function linksRight(out: AdapterOutput, graph: readonly (GraphCall & { dstName: string })[], nodes: ReadonlyMap<string, Place[]>): { right: number; wrong: string[]; notJudged: number } {
  const byPlace = new Map(out.calls.map((c) => [`${c.file}:${c.pos}:${c.name}`, c]));
  const result = { right: 0, wrong: [] as string[], notJudged: 0 };
  for (const g of graph) {
    const c = byPlace.get(`${g.file}:${g.pos}:${g.name}`);
    if (c === undefined || c.answer.notKnown !== undefined) {
      result.notJudged++;
      continue;
    }
    const repo = c.answer.repo;
    const fits = (n: Place) => repo !== undefined && n.name === repo.name && n.start <= repo.end && n.end >= repo.start;
    const fit = repo === undefined || g.dst !== repo.file ? [] : (nodes.get(g.dst) ?? []).filter(fits);
    const own: Place = { name: ownName(g.dstName), start: g.start, end: g.end };
    if (fits(own) && g.dst === repo?.file && (fit.length === 1 || own.start === repo.start)) result.right++;
    else result.wrong.push(`${g.file}:${g.line} \`${g.name}\` -> ${g.dst}:${g.start}-${g.end}; javac: ${JSON.stringify(c.answer)}`);
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
export async function measureJava(repoDir: string, sha: string, way: Way): Promise<Measured & { reference: string }> {
  return withGraph(repoDir, sha, BUILD[way], (db, graphMs) => {
    const t = performance.now();
    const texts = languageTexts(repoDir, sha, LANGUAGES);
    const ref = javaReference(texts);
    const { functions, calls, errors } = referenceCounts(ref);
    const javac = runAdapter({ files: texts });
    const read = new Set([...parsedFiles(db)].filter((f) => texts.has(f)));
    const graph = graphCallCounts(db, read);
    // A call in a file javac's parser cannot read has no reference to be accounted against.
    const scored = new Set([...read].filter((f) => functions.has(f)));
    const scoredGraph = graphCallCounts(db, scored);
    const linked = graphCalls(db, read);
    const links = linksRight(javac, linked, namedNodes(db));
    const byReference = linksFoundByReference(referenceCalls(javac, read), linked);
    const states = { repo: 0, outside: 0, notKnown: 0 };
    for (const c of javac.calls) states[c.answer.repo !== undefined ? "repo" : c.answer.outside !== undefined ? "outside" : "notKnown"]++;
    const scores: WayScores = {
      functionsFound: functionsFound(functions, graphFunctionLines(db, functions.keys())),
      linksRight: { n: links.right, of: links.right + links.wrong.length, ...(way === "B" ? { note: SAME_TOOL } : {}) },
      linksFoundByState: linksFoundByState(graph),
      linksFoundByReference: { n: byReference.n, of: byReference.of },
      callsAccountedFor: callsAccountedFor(calls, scoredGraph.byFunction),
      missesByCause: byReference.misses,
    };
    const detail = [
      `links right: ${linked.length} links, ${links.right} right, ${links.wrong.length} wrong, ${links.notJudged} javac cannot answer for`,
      `calls: ${graph.linked + graph.outside + graph.notKnown} with a state, ${graph.linked} linked, ${graph.outside} outside, ${graph.notKnown} not known`,
      `files: ${texts.size} Java files read by the page's rules, ${read.size} parsed by the graph, ${errors.length} javac's parser cannot read`,
      `javac: ${javac.java}, no class path, ${javac.errors} errors${javac.firstErrors.length > 0 ? `, first: ${javac.firstErrors[0]}` : ""}; its calls: ${states.repo} in the repo, ${states.outside} outside, ${states.notKnown} no answer`,
      ...errors.map((e) => `not read by ${ref.version}: ${e}`),
      ...links.wrong.map((w) => `wrong link: ${w}`),
      ...examples(byReference.missed),
    ];
    return { scores, ms: { graph: graphMs, reference: Math.round(performance.now() - t) }, detail, reference: `${ref.version} parser and attribution` };
  });
}
