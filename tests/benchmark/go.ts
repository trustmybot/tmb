// The benchmark's measure of a Go repo (trustmybot/tmb#352): way A's graph against Go's own
// parser, go/parser, for the functions and the calls. The links have no reference until way B's
// go/types comes: they are counted, from the call states, and not judged here.
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { SourceLanguage } from "../../src/engine/graph/extract.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { callsAccountedFor, functionsFound, linksFoundByState, type WayScores } from "./score.ts";
import type { Measured } from "./typescript.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["go"]);

/** Why Go's links have no score yet. */
export const LINKS_NOT_JUDGED = "not judged: Go's links have no reference yet (go/types, trustmybot/tmb#352)";

/** Why Go has no way B yet: its tool is not built. */
export const WAY_B_NOT_BUILT = "not built (go/types, trustmybot/tmb#352)";

/** The version of the Go reference, raised when the reference changes what it counts. */
export const REFERENCE_VERSION = 1;

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

/** Measures way A on the repo at `sha`. */
export async function measureGo(repoDir: string, sha: string): Promise<Measured & { reference: string }> {
  return withGraph(repoDir, sha, {}, (db, graphMs) => {
    const t = performance.now();
    const texts = languageTexts(repoDir, sha, LANGUAGES);
    const ref = goReference(texts);
    const { functions, calls, errors } = referenceCounts(ref);
    const read = new Set([...parsedFiles(db)].filter((f) => texts.has(f)));
    const graph = graphCallCounts(db, read);
    // A call in a file Go's parser cannot read has no reference to be accounted against.
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
      `files: ${texts.size} Go files read by the page's rules, ${read.size} parsed by the graph, ${errors.length} Go's parser cannot read`,
      ...errors.map((e) => `not read by ${ref.version}: ${e}`),
    ];
    return { scores, ms: { graph: graphMs, reference: Math.round(performance.now() - t) }, detail, reference: `${ref.version} go/parser` };
  });
}
