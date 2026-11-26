// What both languages' measures share: the graph of a repo at a commit, built the way tmb builds
// it, and the files of one language the graph reads by the page's rules, which the reference reads
// too ("Every function" in CODE_GRAPH.md).
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer, FUNCTION_KINDS, MAX_PARSE_BYTES } from "../../src/engine/graph/build.ts";
import { BASE_LAYER, openGraphDb } from "../../src/engine/graph/db.ts";
import { inSymbolScope, languageOf, type SourceLanguage } from "../../src/engine/graph/extract.ts";
import { listTree, readBlobs } from "../../src/engine/graph/git-source.ts";
import { languageNamed } from "../../src/engine/graph/languages/registry.ts";

/** Builds the graph of the repo at `sha` in a scratch folder, runs `use` on it, and throws the folder away. */
export async function withGraph<T>(repoDir: string, sha: string, use: (db: Database, graphMs: number) => T | Promise<T>): Promise<T> {
  const scratch = mkdtempSync(path.join(tmpdir(), "tmb-benchmark-"));
  try {
    const db = openGraphDb(scratch);
    try {
      const t = performance.now();
      await buildLayer(db, repoDir, sha, BASE_LAYER, { force: true });
      return await use(db, Math.round(performance.now() - t));
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The text of every file at `sha` in one of `languages` that the graph parses by the page's rules:
 * not left out by path, not larger than the graph parses, and not minified. A file that fails to
 * parse stays in: its functions are the graph's to find.
 */
export function languageTexts(repoDir: string, sha: string, languages: ReadonlySet<SourceLanguage>): Map<string, string> {
  const entries = listTree(repoDir, sha).filter((e) => inSymbolScope(e.path) && e.size <= MAX_PARSE_BYTES);
  const blobs = readBlobs(
    repoDir,
    entries.map((e) => e.blob),
  );
  const out = new Map<string, string>();
  for (const e of entries) {
    const text = blobs.get(e.blob);
    if (text === undefined) continue;
    const lang = languageOf(e.path, () => text);
    if (lang === null || !languages.has(lang)) continue;
    if (languageNamed(lang)?.minified?.(text) === true) continue;
    out.set(e.path, text);
  }
  return out;
}

/** The graph's functions in the given files, as `start-end` lines, by file. */
export function graphFunctionLines(db: Database, files: Iterable<string>): Map<string, string[]> {
  const wanted = new Set(files);
  const out = new Map<string, string[]>();
  const kinds = [...FUNCTION_KINDS];
  const rows = db
    .query(`SELECT path, start_line AS start, end_line AS end FROM symbols WHERE layer = ? AND kind IN (${kinds.map(() => "?").join(", ")})`)
    .all(BASE_LAYER, ...kinds) as { path: string; start: number; end: number }[];
  for (const r of rows) if (wanted.has(r.path)) out.set(r.path, [...(out.get(r.path) ?? []), `${r.start}-${r.end}`]);
  return out;
}

/** The graph's calls with a state in the given files: how many in each function, `file:start-end`, or else for the file, `file:`, and how many in each state. */
export function graphCallCounts(db: Database, files: ReadonlySet<string>): { byFunction: Map<string, number>; linked: number; outside: number; notKnown: number } {
  const rows = db
    .query(
      `SELECT s.path AS path, s.kind AS kind, s.start_line AS start, s.end_line AS end, e.call_state AS state
         FROM edges e JOIN symbols s ON s.id = e.src_id WHERE e.layer = ? AND e.call_state IS NOT NULL`,
    )
    .all(BASE_LAYER) as { path: string; kind: string; start: number; end: number; state: string }[];
  const byFunction = new Map<string, number>();
  const states = { linked: 0, outside: 0, notKnown: 0 };
  for (const r of rows) {
    if (!files.has(r.path)) continue;
    const key = `${r.path}:${FUNCTION_KINDS.has(r.kind) ? `${r.start}-${r.end}` : ""}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + 1);
    if (r.state === "linked") states.linked++;
    else if (r.state === "outside") states.outside++;
    else states.notKnown++;
  }
  return { byFunction, ...states };
}

/** The files of the layer the graph parsed without an error. */
export function parsedFiles(db: Database): Set<string> {
  return new Set((db.query("SELECT path FROM files WHERE layer = ? AND parse_error IS NULL").all(BASE_LAYER) as { path: string }[]).map((r) => r.path));
}
