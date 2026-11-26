// SQL by parsing (trustmybot/tmb#339, CODE_GRAPH.md "Data sources"): the tables a statement reads
// or writes come from an SQL parser, in a .sql file and in a string in code. A data source is one
// node of the repo, its kind and its name, in no file; whatever a statement names as a table is one
// by its last name part; a name the code does not state links to the store alone, with no name; a
// statement of an .sql file the parser cannot read gives no link and is counted.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildStats } from "../src/engine/graph/build.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };

const FILES: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  // An index changes its table: a write to it, and no node of its own.
  "db/schema.sql": [
    "-- The dock's tables.",
    "CREATE TABLE crates (id INTEGER PRIMARY KEY, size INTEGER);",
    "CREATE INDEX crates_by_size ON crates (size);",
    "",
  ].join("\n"),
  // A view is a table node; its query reads.
  "db/views.sql": "CREATE VIEW heavy_crates AS\n  SELECT id FROM crates WHERE size > 9;\n",
  // A foreign key is no link.
  "db/pallets.sql":
    "CREATE TABLE pallets (\n  id INTEGER PRIMARY KEY,\n  crate_id INTEGER REFERENCES crates (id),\n  FOREIGN KEY (crate_id) REFERENCES crates (id)\n);\n",
  // COPY writes or reads its table; the address is not read.
  "db/load.sql": "COPY crates FROM 's3://dock-intake/2026/crates.csv';\nCOPY pallets TO STDOUT;\n",
  // A trigger is code: its body's reads and writes start at it.
  "db/triggers.sql": [
    "CREATE TRIGGER crate_moved AFTER UPDATE ON crates",
    "BEGIN",
    "  INSERT INTO crate_moves (crate_id) VALUES (new.id);",
    "  UPDATE pallets SET size = 1 WHERE crate_id = new.id;",
    "END;",
    "",
  ].join("\n"),
  // An FTS virtual table is a table node.
  "db/search.sql": "CREATE VIRTUAL TABLE crate_text USING fts5(label);\n",
  // Statements the parser cannot read: no link, and each is counted.
  "db/legacy.sql": [
    "CREATE TRIGGER IF NOT EXISTS crate_gone AFTER DELETE ON crates",
    "BEGIN",
    "  DELETE FROM ledger_lines WHERE crate_id = old.id;",
    "END;",
    "CREATE VIRTUAL TABLE crate_notes USING fts5(body, content='crates');",
    "",
  ].join("\n"),
  // A system table is a table node.
  "src/catalog.ts": 'declare const db: { prepare(s: string): unknown };\nexport function listTables() {\n  return db.prepare("SELECT name FROM sqlite_schema WHERE type = \'table\'");\n}\n',
  // A table's name is its last part: one node for both.
  "src/archive.py": 'def move_out(cur):\n    cur.execute("INSERT INTO cold.shelves (id) VALUES (?)", (1,))\n',
  "src/shelves.ts": 'declare const db: { query(s: string): unknown };\nexport function countShelves() {\n  return db.query("SELECT count(*) FROM shelves");\n}\n',
  // A name held in a variable links to the store alone.
  "src/purge.ts": "declare const db: { run(s: string): unknown };\nexport function purge(table: string) {\n  return db.run(`DELETE FROM ${table} WHERE stale = 1`);\n}\n",
  "src/peek.py": 'def peek(cur, name):\n    cur.execute(f"select * from {name}")\n',
  // Any letter case; a value joined on is a placeholder.
  "src/find.ts": 'declare const db: { query(s: string): unknown };\nexport function findCrate(id: number) {\n  return db.query("select * from crates where id = " + id);\n}\n',
  // Placeholders: %s and %(name)s, $1, and a .format field.
  "src/mark.py": [
    "def mark(cur, crate):",
    '    cur.execute("UPDATE pallets SET size = %s WHERE id = %(id)s", {"id": crate})',
    "",
    "def shelf(cur, x):",
    '    cur.execute("select * from shelves where id = {}".format(x))',
    "",
  ].join("\n"),
  "src/moves.ts": 'declare const pool: { query(s: string, v: unknown[]): unknown };\nexport function forget(id: number) {\n  return pool.query("delete from crate_moves where id = $1", [id]);\n}\n',
  // A label that starts like a statement and does not parse gives nothing.
  "src/labels.ts": 'export const insertLabel = "Insert row";\nexport function caption() {\n  return "Update available";\n}\n',
  // A trigger in a string, which only a few dialects parse, lives in the function that holds it.
  "src/install.ts":
    'declare const db: { run(s: string): unknown };\nexport function installShelfTrigger() {\n  return db.run("CREATE TRIGGER shelf_added AFTER INSERT ON shelves BEGIN UPDATE crates SET size = 0; END");\n}\n',
  // A placeholder where a query or a table's name would be names no table.
  "src/count.py": 'def count_rows(cur, sql, n):\n    cur.execute(f"select count(*) from (select * from ({sql}) limit {n})")\n',
  // A shell script's strings are read the same way.
  "scripts/seed.sh": '#!/bin/bash\nseed() {\n  sqlite3 dock.db "insert into crate_moves (crate_id) values (1)"\n}\n',
  // Dialects that parse a statement and disagree on its tables give no link.
  "src/vault.ts": 'declare const db: { query(s: string): unknown };\nexport function vaultBoxes() {\n  return db.query("SELECT * FROM `vault.boxes`");\n}\n',
};

let project: string;
let store: Store;
let stats: BuildStats;
let links: string[];
let nodes: string[];

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

beforeAll(async () => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-sql-")));
  git(project, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  writeSetting(store, HUMAN, "base_branch", "main");
  stats = await indexProject(project, store, { rebuild: false });
  const view = await openView(project, store);
  try {
    // Every link that ends at, or is meant for, something the code reads or writes data in.
    const rows = view.db
      .query(
        `SELECT s.qualified_name AS src, e.kind AS kind, e.dst_name AS name, d.kind AS dkind, d.signature AS dsig, d.qualified_name AS dname
           FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
          WHERE e.layer = ? AND e.kind NOT IN ('calls', 'imports', 'instantiates', 'sources', 'runs', 'bundles', 'reads_config', 'covers')`,
      )
      .all(view.layer) as { src: string; kind: string; name: string; dkind: string | null; dsig: string; dname: string | null }[];
    links = rows.map((r) => `${r.src} ${r.kind} ${r.dkind === null ? `(unlinked ${r.name})` : `${r.dkind}:${r.dsig}:${r.dname}`}`).sort();
    const symbols = view.db
      .query(
        `SELECT s.kind, s.signature AS sig, s.qualified_name AS name, s.path, p.qualified_name AS parent
           FROM symbols s LEFT JOIN symbols p ON p.id = s.parent_id
          WHERE s.layer = ? AND s.kind NOT IN ('module', 'function', 'method', 'class', 'interface', 'type', 'const', 'sh_function')`,
      )
      .all(view.layer) as { kind: string; sig: string; name: string; path: string; parent: string | null }[];
    nodes = symbols.map((s) => `${s.kind}:${s.kind === "data_source" ? `${s.sig}:` : ""}${s.name} @${s.path} in ${s.parent ?? "-"}`).sort();
  } finally {
    view.db.close();
  }
});

afterAll(() => {
  store?.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

const linksFrom = (src: string) => links.filter((l) => l.startsWith(`${src} `));
const nodeNames = () => nodes.map((n) => n.slice(0, n.indexOf(" @")));
const TABLE = "data_source:table:";

describe("a statement's tables, from the parser", () => {
  test("CREATE TABLE and CREATE INDEX are writes to the table, and the index is no node", () => {
    expect(linksFrom("db/schema.sql")).toEqual([`db/schema.sql writes_data ${TABLE}crates`, `db/schema.sql writes_data ${TABLE}crates`]);
    expect(nodes.some((n) => n.includes("crates_by_size"))).toBe(false);
  });

  test("a view is a table node: CREATE VIEW writes it, and its query reads", () => {
    expect(nodeNames()).toContain(`${TABLE}heavy_crates`);
    expect(linksFrom("db/views.sql")).toEqual([`db/views.sql reads_data ${TABLE}crates`, `db/views.sql writes_data ${TABLE}heavy_crates`]);
  });

  test("a system table is a table node", () => {
    expect(linksFrom("listTables")).toEqual([`listTables reads_data ${TABLE}sqlite_schema`]);
  });

  test("a table's name is its last part, and one name is one node", () => {
    expect(linksFrom("move_out")).toEqual([`move_out writes_data ${TABLE}shelves`]);
    expect(linksFrom("countShelves")).toEqual([`countShelves reads_data ${TABLE}shelves`]);
    expect(nodeNames().filter((n) => n === `${TABLE}shelves`)).toHaveLength(1);
  });

  test("a data source belongs to no file: one node for the repo, with no parent", () => {
    expect(nodes.filter((n) => n.startsWith(`${TABLE}crates `))).toEqual([`${TABLE}crates @ in -`]);
    expect(nodes.filter((n) => n.startsWith("data_source:") && !n.endsWith(" @ in -"))).toEqual([]);
  });

  test("a table name held in a variable links to the store alone, which has no name", () => {
    expect(linksFrom("purge")).toEqual(["purge writes_data data_source:database:"]);
    expect(linksFrom("peek")).toEqual(["peek reads_data data_source:database:"]);
    expect(nodeNames().filter((n) => n.startsWith("data_source:database:"))).toEqual(["data_source:database:"]);
  });

  test("a foreign key is no link", () => {
    expect(linksFrom("db/pallets.sql")).toEqual([`db/pallets.sql writes_data ${TABLE}pallets`]);
  });

  test("COPY writes or reads its table, and the address is not read", () => {
    expect(linksFrom("db/load.sql")).toEqual([`db/load.sql reads_data ${TABLE}pallets`, `db/load.sql writes_data ${TABLE}crates`]);
    expect(nodes.some((n) => n.includes("dock-intake"))).toBe(false);
  });

  test("a trigger is a node in its file, on its table, and its body's links start at it", () => {
    expect(nodes).toContain("sql_trigger:crate_moved @db/triggers.sql in db/triggers.sql");
    expect(linksFrom("crate_moved")).toEqual([
      `crate_moved triggers_on ${TABLE}crates`,
      `crate_moved writes_data ${TABLE}crate_moves`,
      `crate_moved writes_data ${TABLE}pallets`,
    ]);
  });

  test("a trigger in a string lives in the function that holds the string", () => {
    expect(nodes).toContain("sql_trigger:shelf_added @src/install.ts in installShelfTrigger");
    expect(linksFrom("shelf_added")).toEqual([`shelf_added triggers_on ${TABLE}shelves`, `shelf_added writes_data ${TABLE}crates`]);
  });

  test("an FTS virtual table is a table node", () => {
    expect(nodeNames()).toContain(`${TABLE}crate_text`);
    expect(linksFrom("db/search.sql")).toEqual([`db/search.sql writes_data ${TABLE}crate_text`]);
  });
});

describe("SQL in a string", () => {
  test("any letter case, with a value joined on", () => {
    expect(linksFrom("findCrate")).toEqual([`findCrate reads_data ${TABLE}crates`]);
  });

  test("placeholders: %s, %(name)s, $1 and a .format field", () => {
    expect(linksFrom("mark")).toEqual([`mark writes_data ${TABLE}pallets`]);
    expect(linksFrom("shelf")).toEqual([`shelf reads_data ${TABLE}shelves`]);
    expect(linksFrom("forget")).toEqual([`forget writes_data ${TABLE}crate_moves`]);
  });

  test("a shell script's string", () => {
    expect(linksFrom("seed")).toEqual([`seed writes_data ${TABLE}crate_moves`]);
  });

  test("a label that starts like a statement and does not parse gives nothing", () => {
    expect(linksFrom("caption")).toEqual([]);
    expect(linksFrom("src/labels.ts")).toEqual([]);
  });

  test("a placeholder where a query or a table's name would be names no table: the store alone", () => {
    expect(linksFrom("count_rows")).toEqual(["count_rows reads_data data_source:database:"]);
  });

  test("dialects that parse the statement and name different tables give no link", () => {
    expect(linksFrom("vaultBoxes")).toEqual([]);
    expect(nodeNames().some((n) => n.includes("boxes"))).toBe(false);
  });
});

describe("what the parser cannot read", () => {
  test("a statement of an .sql file gives no link and is counted; a string is not", () => {
    expect(linksFrom("db/legacy.sql")).toEqual([]);
    expect(nodeNames().some((n) => /crate_gone|crate_notes|ledger_lines/.test(n))).toBe(false);
    expect(stats.notRead.statements).toBe(2);
  });

  test("the answer's freshness says how many statements were not read", async () => {
    const view = await openView(project, store);
    try {
      expect(view.freshness.statementsNotRead).toBe(2);
    } finally {
      view.db.close();
    }
  });
});
