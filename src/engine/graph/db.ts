// The code graph's own database file, beside the record. Everything in it but the concepts is
// derived from git and can be rebuilt; the concepts are written by agents and kept.
//
// The graph is held in layers: `base` is the base branch's commit, and `task:<id>` is an
// open task's commit laid on top, so a worker sees its change and its base together.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PROJECT_DIR_NAME } from "../project.ts";

export const GRAPH_FILE_NAME = "graph.db";
export const GRAPH_SCHEMA_VERSION = 3;
const BUSY_TIMEOUT_MS = 30_000;

export const BASE_LAYER = "base";
export const taskLayer = (taskId: string): string => `task:${taskId}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS layers (
  layer      TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  extractor  INTEGER NOT NULL,
  built_at   TEXT NOT NULL,
  files      INTEGER NOT NULL,
  symbols    INTEGER NOT NULL,
  edges      INTEGER NOT NULL,
  unresolved INTEGER NOT NULL,
  unresolved_imports INTEGER NOT NULL DEFAULT 0,
  functions  INTEGER NOT NULL DEFAULT 0,
  not_parsed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dirs (
  layer          TEXT NOT NULL,
  path           TEXT NOT NULL,
  parent         TEXT,
  depth          INTEGER NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  summary_source TEXT NOT NULL DEFAULT 'none',
  file_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (layer, path)
);
CREATE TABLE IF NOT EXISTS files (
  layer          TEXT NOT NULL,
  path           TEXT NOT NULL,
  dir            TEXT NOT NULL,
  lang           TEXT,
  blob           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  lane           TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  summary_source TEXT NOT NULL DEFAULT 'none',
  parse_error    TEXT,
  PRIMARY KEY (layer, path)
);
CREATE INDEX IF NOT EXISTS files_dir ON files(layer, dir);
CREATE TABLE IF NOT EXISTS symbols (
  id             INTEGER PRIMARY KEY,
  layer          TEXT NOT NULL,
  path           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  name           TEXT NOT NULL,
  signature      TEXT NOT NULL DEFAULT '',
  doc            TEXT NOT NULL DEFAULT '',
  start_line     INTEGER,
  end_line       INTEGER,
  exported       INTEGER NOT NULL DEFAULT 0,
  parent_id      INTEGER,
  unnamed        INTEGER NOT NULL DEFAULT 0,
  named_id       INTEGER
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(layer, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS symbols_qualified ON symbols(layer, qualified_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols(layer, path);
CREATE INDEX IF NOT EXISTS symbols_parent ON symbols(parent_id);
CREATE INDEX IF NOT EXISTS symbols_named ON symbols(named_id);
CREATE TABLE IF NOT EXISTS edges (
  layer      TEXT NOT NULL,
  src_id     INTEGER NOT NULL,
  dst_id     INTEGER,
  dst_name   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('exact', 'name', 'unresolved')),
  line       INTEGER,
  hint       TEXT
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_id);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_id);
CREATE INDEX IF NOT EXISTS edges_name ON edges(layer, dst_name);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(symbol_id UNINDEXED, layer UNINDEXED, terms, doc);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(layer UNINDEXED, path UNINDEXED, terms, summary);
CREATE VIRTUAL TABLE IF NOT EXISTS dirs_fts USING fts5(layer UNINDEXED, path UNINDEXED, terms, summary);
CREATE TABLE IF NOT EXISTS parsed (
  blob       TEXT NOT NULL,
  lang       TEXT NOT NULL,
  extractor  INTEGER NOT NULL,
  extraction TEXT,
  error      TEXT,
  PRIMARY KEY (blob, lang, extractor)
);
CREATE TABLE IF NOT EXISTS concepts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('flow', 'rule')),
  body          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('verified', 'broken')),
  status_reason TEXT,
  checked_at    TEXT,
  checked_sha   TEXT,
  created_by    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS concept_anchors (
  concept_id     TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  path           TEXT NOT NULL,
  qualified_name TEXT NOT NULL DEFAULT '',
  present        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (concept_id, ordinal)
);
CREATE TABLE IF NOT EXISTS misses (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  lookup TEXT NOT NULL,
  query  TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  actor  TEXT NOT NULL
);
`;

/** Schema 3 counts the imports of the repo's own code that link no file (trustmybot/tmb#147). */
const SCHEMA_2_TO_3 = ["ALTER TABLE layers ADD COLUMN unresolved_imports INTEGER NOT NULL DEFAULT 0"];

const SCHEMA_1_TO_2 = [
  "ALTER TABLE layers ADD COLUMN functions INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE layers ADD COLUMN not_parsed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE symbols ADD COLUMN parent_id INTEGER",
  "ALTER TABLE symbols ADD COLUMN unnamed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE symbols ADD COLUMN named_id INTEGER",
];

/** In a workspace, each repo's graph lives in this folder of the shared record folder, by the repo's name. */
export const REPO_GRAPHS_DIR = "graphs";

/** The graph file of the project folder (repo null), or of one repo of a workspace. */
export function graphDbPath(projectDir: string, repo: string | null = null): string {
  if (repo === null) return path.join(projectDir, PROJECT_DIR_NAME, GRAPH_FILE_NAME);
  return `${path.join(projectDir, PROJECT_DIR_NAME, REPO_GRAPHS_DIR, ...repo.split("/"))}.db`;
}

/** Opens a graph file, the project's or a repo's, making it and its tables when missing. Refuses one a newer tmb made. */
export function openGraphDb(projectDir: string, repo: string | null = null): Database {
  const file = graphDbPath(projectDir, repo);
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    const { user_version: version } = db.query("PRAGMA user_version").get() as { user_version: number };
    if (version > GRAPH_SCHEMA_VERSION) {
      throw new Error(`the code graph at ${file} was made by a newer tmb (schema ${version}); update tmb`);
    }
    if (version < GRAPH_SCHEMA_VERSION) {
      db.transaction(() => {
        // Schema 1 lacked each symbol's container and the counts of functions and of files not
        // parsed. Its layers were built by an older extractor, so the next read rebuilds them.
        if (version === 1) for (const statement of SCHEMA_1_TO_2) db.run(statement);
        if (version === 1 || version === 2) for (const statement of SCHEMA_2_TO_3) db.run(statement);
        db.run(SCHEMA);
        db.run(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
      }).immediate();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Removes every row of one layer. */
export function dropLayer(db: Database, layer: string): void {
  db.run("DELETE FROM edges WHERE layer = ?", [layer]);
  db.run("DELETE FROM symbols WHERE layer = ?", [layer]);
  db.run("DELETE FROM symbols_fts WHERE layer = ?", [layer]);
  db.run("DELETE FROM files WHERE layer = ?", [layer]);
  db.run("DELETE FROM files_fts WHERE layer = ?", [layer]);
  db.run("DELETE FROM dirs WHERE layer = ?", [layer]);
  db.run("DELETE FROM dirs_fts WHERE layer = ?", [layer]);
  db.run("DELETE FROM layers WHERE layer = ?", [layer]);
}

export type LayerRow = {
  layer: string;
  commit_sha: string;
  extractor: number;
  built_at: string;
  files: number;
  symbols: number;
  edges: number;
  unresolved: number;
  unresolved_imports: number;
  functions: number;
  not_parsed: number;
};

export function layerRow(db: Database, layer: string): LayerRow | null {
  return db.query("SELECT * FROM layers WHERE layer = ?").get(layer) as LayerRow | null;
}
