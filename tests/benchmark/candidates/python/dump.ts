// Step 1 of the Python A/B test (trustmybot/tmb#338): way A's graph of a repo at a commit, as the
// built-in parser and rules make it, written to JSON. Every candidate is measured on these same
// nodes and calls: a candidate only answers what each call resolves to.
//
//   bun tests/benchmark/candidates/python/dump.ts <repoDir> <sha> <out.json>
//
// The dump holds the nodes (every symbol but the file's own and the unnamed), the calls (each with
// its file, position, line and 0-based character, the name it calls, way A's state and link), and
// way A's functions found and calls accounted for against Python's own parser, which way B cannot
// change: it adds no node and no call.
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { BASE_LAYER } from "../../../../src/engine/graph/db.ts";
import type { SourceLanguage } from "../../../../src/engine/graph/extract.ts";
import { resolveCommit } from "../../../../src/engine/graph/git-source.ts";
import { graphCallCounts, graphFunctionLines, languageTexts, parsedFiles, withGraph } from "../../graph.ts";
import { pythonReference, referenceCounts } from "../../python.ts";
import { callsAccountedFor, functionsFound, type Ratio } from "../../score.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["python"]);

export type DumpNode = { id: number; path: string; name: string; kind: string; start: number; end: number };
export type DumpCall = {
  /** The edge's row in the graph, so answers can be joined back. */
  row: number;
  path: string;
  line: number;
  /** UTF-16 offset in the file, where the name it calls is written (CODE_GRAPH.md). */
  pos: number;
  /** 0-based line and UTF-16 character of `pos`, as the Language Server Protocol counts. */
  line0: number;
  character: number;
  name: string;
  /** The symbol the call is written in. */
  owner: number;
  wayA: "linked" | "outside" | "not_known";
  /** Way A's link, a node id, when linked. */
  wayADst: number | null;
};
export type Dump = {
  repoDir: string;
  sha: string;
  graphMs: number;
  files: string[];
  nodes: DumpNode[];
  calls: DumpCall[];
  functionsFound: Ratio;
  callsAccountedFor: Ratio;
  referenceVersion: string;
};

/** A node's own name: the last part of its qualified name, as build.ts gives it to a tool. */
const ownName = (qualifiedName: string): string => qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1);

/** The 0-based line and UTF-16 character of a UTF-16 offset. */
export function lineCharacter(text: string, pos: number): { line0: number; character: number } {
  let line0 = 0;
  let lineStart = 0;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line0++;
      lineStart = i + 1;
    }
  }
  return { line0, character: pos - lineStart };
}

function read(db: Database, texts: ReadonlyMap<string, string>): { nodes: DumpNode[]; calls: DumpCall[] } {
  const nodes = (
    db.query("SELECT id, path, kind, qualified_name AS q, start_line AS start, end_line AS end FROM symbols WHERE layer = ? AND kind != 'module' AND unnamed = 0").all(BASE_LAYER) as {
      id: number;
      path: string;
      kind: string;
      q: string;
      start: number;
      end: number;
    }[]
  )
    .filter((s) => texts.has(s.path))
    .map((s) => ({ id: s.id, path: s.path, name: ownName(s.q), kind: s.kind, start: s.start, end: s.end }));
  const rows = db
    .query(
      `SELECT e.rowid AS row, s.path AS path, e.line AS line, e.pos AS pos, e.dst_name AS name, e.src_id AS owner, e.call_state AS state, e.dst_id AS dst
         FROM edges e JOIN symbols s ON s.id = e.src_id WHERE e.layer = ? AND e.call_state IS NOT NULL AND e.pos IS NOT NULL`,
    )
    .all(BASE_LAYER) as { row: number; path: string; line: number; pos: number; name: string; owner: number; state: DumpCall["wayA"]; dst: number | null }[];
  const calls = rows
    .filter((r) => texts.has(r.path))
    .map((r) => ({
      row: r.row,
      path: r.path,
      line: r.line,
      pos: r.pos,
      ...lineCharacter(texts.get(r.path)!, r.pos),
      name: r.name,
      owner: r.owner,
      wayA: r.state,
      wayADst: r.state === "linked" ? r.dst : null,
    }));
  return { nodes, calls };
}

export async function dump(repoDir: string, sha: string): Promise<Dump> {
  return withGraph(repoDir, sha, { links: "built-in" }, (db, graphMs) => {
    const texts = languageTexts(repoDir, sha, LANGUAGES);
    const ref = pythonReference(texts);
    const { functions, calls: refCalls } = referenceCounts(ref);
    const parsed = new Set([...parsedFiles(db)].filter((f) => texts.has(f)));
    const scored = new Set([...parsed].filter((f) => functions.has(f)));
    const { nodes, calls } = read(db, texts);
    return {
      repoDir,
      sha,
      graphMs,
      files: [...parsed].sort(),
      nodes,
      calls,
      functionsFound: functionsFound(functions, graphFunctionLines(db, functions.keys())),
      callsAccountedFor: callsAccountedFor(refCalls, graphCallCounts(db, scored).byFunction),
      referenceVersion: `Python ${ref.version} ast`,
    };
  });
}

if (import.meta.main) {
  const [repoDir, ref, out] = process.argv.slice(2);
  if (repoDir === undefined || ref === undefined || out === undefined) throw new Error("usage: dump.ts <repoDir> <sha> <out.json>");
  const sha = resolveCommit(repoDir, ref);
  if (sha === null) throw new Error(`${repoDir} has no commit ${ref}`);
  const d = await dump(repoDir, sha);
  writeFileSync(out, JSON.stringify(d));
  const states = { linked: 0, outside: 0, not_known: 0 };
  for (const c of d.calls) states[c.wayA]++;
  console.log(`${d.files.length} files, ${d.nodes.length} nodes, ${d.calls.length} calls ${JSON.stringify(states)}, graph ${d.graphMs} ms; functions found ${d.functionsFound.n}/${d.functionsFound.of}, calls accounted for ${d.callsAccountedFor.n}/${d.callsAccountedFor.of}`);
}
