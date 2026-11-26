// The benchmark's measure of a C or C++ repo (trustmybot/tmb#355): way A's graph against the
// compiler's own answer, clang's, read through libclang (c_reference.py), for the functions, the
// calls and the links. The compiler reads the repo as its compile database says, so the database is
// required: without it there is no answer to measure against (CODE_GRAPH.md, "C and C++ without the
// project's compile database"). Way B is clangd (languages/c/clangd.ts), which reads the database
// at the repo's own place, so the benchmark measures it only when the reference's database is that
// one. clangd is clang too, so way B's links right is judged by the compiler that made them.
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { BUILT_IN_RULES, type BuildOptions } from "../../src/engine/graph/build.ts";
import { BASE_LAYER, layerRow } from "../../src/engine/graph/db.ts";
import { DATABASE_PLACES } from "../../src/engine/graph/languages/c/clangd.ts";
import type { SourceLanguage } from "../../src/engine/graph/extract.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { callsAccountedFor, functionsFound, type GraphCall, linksFoundByReference, linksFoundByState, type ReferenceCall, type Way, type WayScores } from "./score.ts";
import type { Measured } from "./typescript.ts";

/** Both languages are read in either repo: a C repo's header the graph reads as C++, or the other way, still counts. */
const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["c", "cpp"]);

/** How each way builds the graph, as the program builds it. */
const BUILD: Record<Way, BuildOptions> = {
  A: { links: "built-in" },
  B: { links: "language-tool" },
};

/** Way B's links are judged by clang, the compiler clangd is built on. */
export const SAME_COMPILER = "clang, the compiler clangd is built on, is the reference";

/** The version of the C and C++ reference, raised when the reference changes what it counts. */
export const REFERENCE_VERSION = 1;

const PROGRAM = path.join(import.meta.dir, "c_reference.py");

type Span = { file: string; start: number; end: number };
type RefCall = { file: string; line: number; col: number; name: string; owner: string; construction: boolean; targets: Span[] };
export type CReference = { version: string; units: { file: string; errors: number; first: string[] }[]; functions: Record<string, string[]>; calls: RefCall[] };

/**
 * The compile database the reference reads for a repo: the file the variable `<env>_COMPILE_DATABASE`
 * names, else `build/compile_commands.json` in the repo, as CMake writes it with
 * `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`. A missing one is an error: the benchmark never measures C
 * without it.
 */
export function compileDatabase(repoDir: string, env: string): { file: string } | { error: string } {
  const named = process.env[`${env}_COMPILE_DATABASE`]?.trim();
  const file = named ? path.resolve(named) : path.join(repoDir, "build", "compile_commands.json");
  if (existsSync(file)) return { file };
  return {
    error: `no compile database at ${file}; run \`cmake -S ${repoDir} -B ${path.join(repoDir, "build")} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON\`, or set ${env}_COMPILE_DATABASE to one`,
  };
}

/**
 * libclang and its Python binding: the library the variable TMB_LIBCLANG names, and the folder of the
 * `clang` package TMB_CINDEX names, else the package Python has installed (`pip install libclang`
 * carries both).
 */
function libclang(): { library: string; cindex: string } {
  const library = process.env.TMB_LIBCLANG?.trim();
  if (!library) throw new Error("set TMB_LIBCLANG to libclang's library (libclang.dylib or libclang.so), and TMB_CINDEX to the folder of its `clang` Python package unless Python has it installed");
  return { library, cindex: process.env.TMB_CINDEX?.trim() || "installed" };
}

/** clang's answer for every unit of the database, run with the `python3` on PATH. */
export function cReference(repoDir: string, database: string, python = "python3"): CReference {
  const { library, cindex } = libclang();
  const run = spawnSync(python, ["-I", PROGRAM, library, cindex, repoDir, database], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (run.error !== undefined || run.status !== 0) throw new Error(`${python} ${PROGRAM} failed: ${run.error?.message ?? run.stderr}`);
  return JSON.parse(run.stdout) as CReference;
}

/** A place written as a line and a UTF-8 byte column, as an offset in UTF-16 code units, the graph's position (CallAt). */
function positionIn(text: string, line: number, col: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return -1;
    at = next + 1;
  }
  let bytes = 1;
  while (bytes < col && at < text.length) {
    const code = text.codePointAt(at)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    at += code >= 0x10000 ? 2 : 1;
  }
  return at;
}

/** The kind of code a call is, by how its callee is written: a class of C's and C++'s syntax, naming no repo. */
export const CAUSES = {
  name: "a function called by its name",
  qualified: "a function called by a qualified name",
  member: "a member called on an object",
  construction: "a construction",
  macro: "a call written in a macro's body",
} as const;

/** Whether a position is in a `#define`'s body: the lines of the directive and its continuations. */
function inDefine(text: string, pos: number): boolean {
  let start = text.lastIndexOf("\n", pos - 1) + 1;
  for (;;) {
    if (/^\s*#\s*define\b/.test(text.slice(start, text.indexOf("\n", start) < 0 ? undefined : text.indexOf("\n", start)))) return true;
    if (start === 0) return false;
    const previous = text.lastIndexOf("\n", start - 2) + 1;
    if (!/\\\s*$/.test(text.slice(previous, start - 1))) return false;
    start = previous;
  }
}

function causeOf(text: string, pos: number, call: RefCall): string {
  if (inDefine(text, pos)) return CAUSES.macro;
  const before = text.slice(Math.max(0, pos - 64), pos).replace(/\s+$/, "");
  if (call.construction || /\bnew$/.test(before)) return CAUSES.construction;
  if (/(\.|->)$/.test(before)) return CAUSES.member;
  if (/::$/.test(before)) return CAUSES.qualified;
  return CAUSES.name;
}

type Linked = GraphCall & { start: number; end: number };

/** The graph's linked calls in the given files. */
function graphLinks(db: Database, files: ReadonlySet<string>): Linked[] {
  const rows = db
    .query(
      `SELECT s.path AS file, e.line AS line, e.pos AS pos, e.dst_name AS name, d.path AS dst, d.start_line AS start, d.end_line AS end
         FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state = 'linked'`,
    )
    .all(BASE_LAYER) as Linked[];
  return rows.filter((r) => files.has(r.file));
}

/** The graph's nodes, by file, as lines. */
function nodeSpans(db: Database): Map<string, { start: number; end: number }[]> {
  const rows = db.query("SELECT path, start_line AS start, end_line AS end FROM symbols WHERE layer = ? AND kind != 'module'").all(BASE_LAYER) as { path: string; start: number; end: number }[];
  const out = new Map<string, { start: number; end: number }[]>();
  for (const r of rows) out.set(r.path, [...(out.get(r.path) ?? []), { start: r.start, end: r.end }]);
  return out;
}

/**
 * Links right: every link of the graph, judged against clang's call at the link's position, of its
 * name. Right when the linked node holds one of the call's targets, and no smaller node of the
 * graph inside it holds the whole target: a method, not the class around it. A link clang has no
 * call for, in code the database does not compile, is counted and not judged.
 */
function linksRight(byPlace: ReadonlyMap<string, RefCall>, links: readonly Linked[], nodes: ReadonlyMap<string, { start: number; end: number }[]>): { right: number; wrong: string[]; notJudged: number } {
  const result = { right: 0, wrong: [] as string[], notJudged: 0 };
  for (const g of links) {
    const c = byPlace.get(`${g.file}:${g.pos}:${g.name}`);
    if (c === undefined) {
      result.notJudged++;
      continue;
    }
    const inside = (n: { start: number; end: number }) => n.start >= g.start && n.end <= g.end && n.end - n.start < g.end - g.start;
    const right = c.targets.some(
      (t) => t.file === g.dst && t.start <= g.end && t.end >= g.start && !(nodes.get(g.dst) ?? []).some((n) => inside(n) && n.start <= t.start && n.end >= t.end),
    );
    if (right) result.right++;
    else result.wrong.push(`${g.file}:${g.line} \`${g.name}\` -> ${g.dst}:${g.start}-${g.end}; clang: ${JSON.stringify(c.targets)}`);
  }
  return result;
}

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

/** The compile database way B reads in the repo, as clangd.ts finds it; null when there is none. */
export function repoDatabase(repoDir: string): string | null {
  const place = DATABASE_PLACES.map((p) => path.join(repoDir, p)).find((p) => existsSync(p));
  return place === undefined ? null : realpathSync(place);
}

/** Measures one way on the repo at `sha`, with clang reading the repo's working tree by the compile database. */
export async function measureC(repoDir: string, sha: string, database: string, way: Way): Promise<Measured & { reference: string }> {
  if (way === "B" && repoDatabase(repoDir) !== realpathSync(database)) {
    throw new Error(`way B reads the compile database at the repo's own place (${DATABASE_PLACES.join(" or ")}); put ${database} there to measure it`);
  }
  return withGraph(repoDir, sha, BUILD[way], (db, graphMs) => {
    // A way B graph whose C and C++ fell back to the built-in rules is no measure of way B.
    const notes = (layerRow(db, BASE_LAYER)?.links_note ?? "").split("; ").filter((part) => part.split(":")[0]!.split(", ").some((lang) => LANGUAGES.has(lang as SourceLanguage)));
    const fellBack = notes.find((part) => part.endsWith(BUILT_IN_RULES));
    if (way === "B" && fellBack !== undefined) throw new Error(`way B was not built: ${fellBack}`);
    const t = performance.now();
    const texts = languageTexts(repoDir, sha, LANGUAGES);
    const ref = cReference(repoDir, database);
    const read = new Set([...parsedFiles(db)].filter((f) => texts.has(f)));
    // The files clang compiles or includes: the rest, another platform's say, have no reference.
    const compiled = new Set([...Object.keys(ref.functions), ...ref.calls.map((c) => c.file)].filter((f) => read.has(f)));
    const functions = new Map(Object.entries(ref.functions).filter(([f]) => compiled.has(f)));
    const calls = new Map<string, number>();
    const byPlace = new Map<string, RefCall>();
    const references: ReferenceCall[] = [];
    for (const c of ref.calls) {
      if (!compiled.has(c.file)) continue;
      const key = `${c.file}:${c.owner}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      const text = texts.get(c.file)!;
      const pos = positionIn(text, c.line, c.col);
      byPlace.set(`${c.file}:${pos}:${c.name}`, c);
      const decls = c.targets.filter((d) => texts.has(d.file)).map((d) => ({ file: d.file, spans: [{ start: d.start, end: d.end }] }));
      if (decls.length > 0) references.push({ file: c.file, line: c.line, pos, names: [c.name], decls, cause: causeOf(text, pos, c) });
    }
    const graph = graphCallCounts(db, read);
    const scoredGraph = graphCallCounts(db, compiled);
    const linked = graphLinks(db, read);
    const links = linksRight(byPlace, linked, nodeSpans(db));
    const byReference = linksFoundByReference(references, linked);
    const failed = ref.units.filter((u) => u.errors > 0);
    const languages = [...texts.keys()].reduce<Record<string, number>>((n, f) => {
      const lang = f.match(/\.[^./]+$/)?.[0] ?? "";
      n[lang] = (n[lang] ?? 0) + 1;
      return n;
    }, {});
    const scores: WayScores = {
      functionsFound: functionsFound(functions, graphFunctionLines(db, functions.keys())),
      linksRight: { n: links.right, of: links.right + links.wrong.length, ...(way === "B" ? { note: SAME_COMPILER } : {}) },
      linksFoundByState: linksFoundByState(graph),
      linksFoundByReference: { n: byReference.n, of: byReference.of },
      callsAccountedFor: callsAccountedFor(calls, scoredGraph.byFunction),
      missesByCause: byReference.misses,
    };
    const detail = [
      ...(way === "B" ? notes.map((n) => `layer note: ${n}`) : []),
      `links right: ${linked.length} links, ${links.right} right, ${links.wrong.length} wrong, ${links.notJudged} in code the database does not compile`,
      `calls: ${graph.linked + graph.outside + graph.notKnown} with a state, ${graph.linked} linked, ${graph.outside} outside, ${graph.notKnown} not known`,
      `files: ${texts.size} C and C++ files read by the page's rules (${JSON.stringify(languages)}), ${read.size} parsed by the graph, ${compiled.size} compiled or included by the database`,
      `clang: ${ref.units.length} units, ${failed.length} with errors${failed.length > 0 ? `, first: ${failed[0]!.file}: ${failed[0]!.first[0] ?? ""}` : ""}`,
      ...links.wrong.map((w) => `wrong link: ${w}`),
      ...examples(byReference.missed),
    ];
    return { scores, ms: { graph: graphMs, reference: Math.round(performance.now() - t) }, detail, reference: `${ref.version}, libclang` };
  });
}
