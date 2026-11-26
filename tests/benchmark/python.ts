// The benchmark's measure of a Python repo (trustmybot/tmb#244): each way's graph against Python's
// own parser for the functions and the calls. Python's links have no reference yet: they are
// counted, from the call states, and not judged. Way B is pyright, which tmb carries
// (trustmybot/tmb#347), built as the program builds it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { BUILT_IN_RULES, type BuildOptions } from "../../src/engine/graph/build.ts";
import { BASE_LAYER, layerRow } from "../../src/engine/graph/db.ts";
import type { SourceLanguage } from "../../src/engine/graph/extract.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { callsAccountedFor, functionsFound, linksFoundByState, type Way, type WayScores } from "./score.ts";
import type { Measured } from "./typescript.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["python"]);

/** Why Python's links have no score yet. */
export const LINKS_NOT_JUDGED = "not judged: Python's links have no reference yet (trustmybot/tmb#244)";

/** How each way builds the graph, as the program builds it: way B uses the pyright tmb carries. */
const BUILD: Record<Way, BuildOptions> = {
  A: { links: "built-in" },
  B: { links: "language-tool" },
};

/** The version of the Python reference, raised when the reference changes what it counts. */
export const REFERENCE_VERSION = 1;

const SCRIPT = path.join(import.meta.dir, "python_reference.py");

/** The answer of python_reference.py for each file. */
type FileAnswer = { functions: string[]; calls: Record<string, number> } | { error: string };
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

/** Measures one way on the repo at `sha`. */
export async function measurePython(repoDir: string, sha: string, way: Way): Promise<Measured & { reference: string }> {
  return withGraph(repoDir, sha, BUILD[way], (db, graphMs) => {
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
      `files: ${texts.size} Python files read by the page's rules, ${read.size} parsed by the graph, ${errors.length} Python's parser cannot read`,
      ...errors.map((e) => `not read by Python ${ref.version}: ${e}`),
    ];
    return { scores, ms: { graph: graphMs, reference: Math.round(performance.now() - t) }, detail, reference: `Python ${ref.version} ast` };
  });
}
