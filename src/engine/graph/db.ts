// The code graph's own database file, beside the record. Everything in it but the concepts and
// the areas is derived from git and can be rebuilt; those are written by agents and kept.
//
// The graph is held in layers: `base` is the base branch's commit, and `task:<id>` is an
// open task's commit laid on top, so a worker sees its change and its base together.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { newId } from "../ids.ts";
import { PROJECT_DIR_NAME } from "../project.ts";
import { BUILT_IN, LINK_WAYS } from "./ways.ts";

export const GRAPH_FILE_NAME = "graph.db";
export const GRAPH_SCHEMA_VERSION = 8;
const BUSY_TIMEOUT_MS = 30_000;

export const BASE_LAYER = "base";
/** The area every project has: the test files. Its patterns add to and take from the built-in test rule. */
export const TESTS_AREA = "tests";
const TESTS_PURPOSE = "Test code: every file the test rule matches, by the common conventions of each language.";

export const taskLayer = (taskId: string): string => `task:${taskId}`;
/** One layer per feature branch that is neither merged nor closed, at the branch's tip (trustmybot/tmb#182). */
export const featureLayer = (featureId: string): string => `feature:${featureId}`;

/** The ways to make links, as SQL values. */
const WAYS_SQL = LINK_WAYS.map((w) => `'${w}'`).join(", ");

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
  not_parsed INTEGER NOT NULL DEFAULT 0,
  not_read   TEXT NOT NULL DEFAULT '{}',
  links      TEXT NOT NULL DEFAULT '${BUILT_IN}',
  links_note TEXT
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
  pos        INTEGER,
  hint       TEXT,
  call_state TEXT CHECK (call_state IN ('linked', 'outside', 'not_known')),
  way        TEXT CHECK (way IN (${WAYS_SQL}))
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
CREATE TABLE IF NOT EXISTS areas (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  purpose       TEXT NOT NULL,
  parent_id     TEXT REFERENCES areas(id) ON DELETE SET NULL,
  include       TEXT NOT NULL,
  exclude       TEXT NOT NULL,
  builtin       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'broken', 'review')),
  status_reason TEXT,
  file_count    INTEGER NOT NULL DEFAULT 0,
  written_count INTEGER NOT NULL DEFAULT 0,
  checked_sha   TEXT,
  created_by    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
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

/**
 * Schema 8 records each call's position in its file, so two calls of one name on one line are told
 * apart (trustmybot/tmb#323): the offset where the name it calls is written, else where it starts.
 * Layers built before it are rebuilt by the newer extractor.
 */
const SCHEMA_7_TO_8 = ["ALTER TABLE edges ADD COLUMN pos INTEGER"];

/**
 * Schema 7 records the way that made each link or gave each call its state, and the way each layer
 * was asked to be built by, with why a language was built by the built-in rules instead
 * (trustmybot/tmb#311). Layers built before it are rebuilt by the newer extractor. A layer that
 * names no way was built by the built-in rules, the only way there was, whatever the default is now.
 */
const SCHEMA_6_TO_7 = [
  `ALTER TABLE edges ADD COLUMN way TEXT CHECK (way IN (${WAYS_SQL}))`,
  `ALTER TABLE layers ADD COLUMN links TEXT NOT NULL DEFAULT '${BUILT_IN}'`,
  "ALTER TABLE layers ADD COLUMN links_note TEXT",
];

/**
 * Schema 6 records the state of each call written in a function: linked, to code outside the repo,
 * or not known; null on any other reference (trustmybot/tmb#252). Layers built before it are
 * rebuilt by the newer extractor.
 */
const SCHEMA_5_TO_6 = ["ALTER TABLE edges ADD COLUMN call_state TEXT CHECK (call_state IN ('linked', 'outside', 'not_known'))"];

/** Schema 5 counts what the graph does not read: unread languages and files left out by rule (trustmybot/tmb#234). */
const SCHEMA_4_TO_5 = ["ALTER TABLE layers ADD COLUMN not_read TEXT NOT NULL DEFAULT '{}'"];

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
        if (version >= 1 && version <= 2) for (const statement of SCHEMA_2_TO_3) db.run(statement);
        const hasNotRead = (db.query("SELECT 1 FROM pragma_table_info('layers') WHERE name = 'not_read'").get() ?? null) !== null;
        if (version >= 1 && version <= 4 && !hasNotRead) for (const statement of SCHEMA_4_TO_5) db.run(statement);
        const hasCallState = (db.query("SELECT 1 FROM pragma_table_info('edges') WHERE name = 'call_state'").get() ?? null) !== null;
        if (version >= 1 && version <= 5 && !hasCallState) for (const statement of SCHEMA_5_TO_6) db.run(statement);
        const hasWay = (db.query("SELECT 1 FROM pragma_table_info('edges') WHERE name = 'way'").get() ?? null) !== null;
        if (version >= 1 && version <= 6 && !hasWay) for (const statement of SCHEMA_6_TO_7) db.run(statement);
        const hasPos = (db.query("SELECT 1 FROM pragma_table_info('edges') WHERE name = 'pos'").get() ?? null) !== null;
        if (version >= 1 && version <= 7 && !hasPos) for (const statement of SCHEMA_7_TO_8) db.run(statement);
        db.run(SCHEMA);
        ensureTestsArea(db);
        db.run(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
      }).immediate();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Makes the built-in "tests" area when the graph has none yet: every graph has it from the start. */
export function ensureTestsArea(db: Database): void {
  if (db.query("SELECT 1 FROM areas WHERE name = ?").get(TESTS_AREA) !== null) return;
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO areas (id, name, purpose, parent_id, include, exclude, builtin, status, file_count, written_count, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, NULL, '[]', '[]', 1, 'ok', 0, 0, ?, ?, ?, ?)",
    [newId(), TESTS_AREA, TESTS_PURPOSE, '"tmb"', '"tmb"', now, now],
  );
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
  not_read: string;
  /** The way the layer was asked to make its links by. */
  links: string;
  /** Why a language of the layer was built by the built-in rules although the language's tool was asked for; null when none was. */
  links_note: string | null;
};

export function layerRow(db: Database, layer: string): LayerRow | null {
  return db.query("SELECT * FROM layers WHERE layer = ?").get(layer) as LayerRow | null;
}
