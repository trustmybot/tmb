// The graph's kinds of symbol are one set for every language (CODE_GRAPH.md, "Kinds of symbol";
// trustmybot/tmb#314): a file, a type, a function, a method (a constructor and an accessor are
// methods) and file-level data. Each language module maps its own syntax to them, so no stored kind
// is one language's word, and the lookups answer in these kinds. The fixtures are small programs of
// their own; each expected kind is read off the page's table, not off the graph's output.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../../../../src/engine/graph/build.ts";
import { GRAPH_SCHEMA_VERSION, openGraphDb } from "../../../../src/engine/graph/db.ts";
import { find, lookupSymbol } from "../../../../src/engine/graph/lookups.ts";
import { git } from "../../../lib/git.ts";
import { commitFiles, RECORD_IGNORE } from "../../../lib/project.ts";

setDefaultTimeout(30_000);

let project: string;

/** Commits the files with the record ignored, as the first commit, and returns it. */
function commit(files: Record<string, string>): string {
  return commitFiles(project, { ".gitignore": RECORD_IGNORE, ...files });
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-kinds-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;
const LAYER = "base";

/** The page's kinds, as the graph stores them. */
const FILE = "file";
const TYPE = "type";
const FUNCTION = "function";
const METHOD = "method";
const FILE_DATA = "file_level_data";
const DATA_SOURCE = "data_source";
const COMMON: readonly string[] = [FILE, TYPE, FUNCTION, METHOD, FILE_DATA, DATA_SOURCE];

// One program per language, each with a type of each shape the language has, a function, a method,
// a constructor, an accessor where the language has one, and file-level data.
const FILES: Record<string, string> = {
  "web/shop.ts": lines(
    "export class Basket {",
    "  constructor(public owner: string) {}",
    "  get size(): number { return 1; }",
    "  sum(): number { return 2; }",
    "}",
    "export interface Shelf { pick(): string }",
    "export type Tag = string;",
    "export enum Hue { Red }",
    "export const LIMIT = 10;",
    "export function weigh(): number { return [1].map((x) => x + 1).length; }",
  ),
  "py/shop.py": lines(
    "LIMIT = 10",
    "",
    "class Basket:",
    "    def __init__(self, owner):",
    "        self.owner = owner",
    "",
    "    @property",
    "    def size(self):",
    "        return 1",
    "",
    "def weigh():",
    "    return 2",
  ),
  "go/shop.go": lines(
    "package shop",
    "",
    "type Basket struct{}",
    "",
    "type Shelf interface {",
    "\tPick() string",
    "}",
    "",
    "const Limit = 10",
    "",
    "var spare = 3",
    "",
    "func (b Basket) Sum() int { return 2 }",
    "",
    "func Weigh() int { return 1 }",
  ),
  "java/Shop.java": lines(
    "package shop;",
    "",
    "class Basket {",
    "  Basket() {}",
    "  int sum() { return 2; }",
    "}",
    "",
    "interface Shelf { String pick(); }",
    "",
    "enum Hue { RED }",
    "",
    "record Label(String text) {}",
  ),
  "rs/shop.rs": lines(
    "pub struct Basket;",
    "",
    "pub trait Shelf {",
    "    fn pick(&self) -> u32;",
    "}",
    "",
    "pub enum Hue { Red }",
    "",
    "impl Basket {",
    "    pub fn sum(&self) -> u32 { 2 }",
    "}",
    "",
    "pub mod aisle {",
    "    pub fn stock() -> u32 { 3 }",
    "}",
    "",
    "pub const LIMIT: u32 = 10;",
    "pub static SPARE: u32 = 3;",
    "",
    "pub fn weigh() -> u32 { 1 }",
  ),
  "c/shop.c": lines(
    "struct basket { int n; };",
    "",
    "enum hue { RED };",
    "",
    "int limit = 10;",
    "",
    "int weigh(void) { return 1; }",
  ),
  "cpp/shop.cpp": lines(
    "class Basket {",
    " public:",
    "  Basket() {}",
    "  int sum() { return 2; }",
    "};",
    "",
    "struct Shelf { int pick() { return 1; } };",
  ),
  "sh/shop.sh": lines("#!/bin/sh", "weigh() {", "  echo 1", "}", "weigh"),
  "pl/shop.pl": lines("use constant LIMIT => 10;", "", "sub weigh {", "  return 1;", "}"),
  // A trigger is code the store runs: a function ("Data sources").
  "sql/shop.sql": lines(
    "CREATE TABLE baskets (id INTEGER);",
    "SELECT id FROM baskets;",
    "CREATE TRIGGER basket_added AFTER INSERT ON baskets BEGIN DELETE FROM baskets WHERE id < 0; END;",
  ),
};

/** Every named node's kind, by its file and qualified name. */
function kindsOf(db: Database): Map<string, string> {
  const rows = db.query("SELECT path, qualified_name, kind FROM symbols WHERE layer = ? AND unnamed = 0").all(LAYER) as { path: string; qualified_name: string; kind: string }[];
  return new Map(rows.map((r) => [`${r.path}#${r.qualified_name}`, r.kind]));
}

describe("the kinds of symbol", () => {
  test("every stored kind, in every language, is one of the page's kinds", async () => {
    const sha = commit(FILES);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, LAYER, { force: true });
    const stored = (db.query("SELECT DISTINCT kind FROM symbols WHERE layer = ?").all(LAYER) as { kind: string }[]).map((r) => r.kind);
    expect(stored.filter((k) => !COMMON.includes(k))).toEqual([]);
    db.close();
  });

  test("each language maps its own syntax to the page's kinds", async () => {
    const sha = commit(FILES);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, LAYER, { force: true });
    const kinds = kindsOf(db);
    const expected: Record<string, string> = {
      // A file is a file, in any language.
      "web/shop.ts#web/shop.ts": FILE,
      "py/shop.py#py/shop.py": FILE,
      "sh/shop.sh#sh/shop.sh": FILE,
      // TypeScript: a class, an interface, a type alias and an enum are types.
      "web/shop.ts#Basket": TYPE,
      "web/shop.ts#Shelf": TYPE,
      "web/shop.ts#Tag": TYPE,
      "web/shop.ts#Hue": TYPE,
      "web/shop.ts#Basket.constructor": METHOD,
      "web/shop.ts#Basket.size": METHOD,
      "web/shop.ts#Basket.sum": METHOD,
      "web/shop.ts#Shelf.pick": METHOD,
      "web/shop.ts#LIMIT": FILE_DATA,
      "web/shop.ts#weigh": FUNCTION,
      // Python: a class is a type; `__init__` and a property are methods; a module-level name is data.
      "py/shop.py#Basket": TYPE,
      "py/shop.py#Basket.__init__": METHOD,
      "py/shop.py#Basket.size": METHOD,
      "py/shop.py#LIMIT": FILE_DATA,
      "py/shop.py#weigh": FUNCTION,
      // Go: a struct and an interface are types; a const and a var are file-level data.
      "go/shop.go#Basket": TYPE,
      "go/shop.go#Shelf": TYPE,
      "go/shop.go#Shelf.Pick": METHOD,
      "go/shop.go#Basket.Sum": METHOD,
      "go/shop.go#Limit": FILE_DATA,
      "go/shop.go#spare": FILE_DATA,
      "go/shop.go#Weigh": FUNCTION,
      // Java: a class, an interface, an enum and a record are types; a constructor is a method.
      "java/Shop.java#Basket": TYPE,
      "java/Shop.java#Basket.Basket": METHOD,
      "java/Shop.java#Basket.sum": METHOD,
      "java/Shop.java#Shelf": TYPE,
      "java/Shop.java#Shelf.pick": METHOD,
      "java/Shop.java#Hue": TYPE,
      "java/Shop.java#Label": TYPE,
      // Rust: a struct, a trait, an enum and a `mod` written in the file are types.
      "rs/shop.rs#Basket": TYPE,
      "rs/shop.rs#Shelf": TYPE,
      "rs/shop.rs#Shelf.pick": METHOD,
      "rs/shop.rs#Hue": TYPE,
      "rs/shop.rs#Basket.sum": METHOD,
      "rs/shop.rs#aisle": TYPE,
      "rs/shop.rs#LIMIT": FILE_DATA,
      "rs/shop.rs#SPARE": FILE_DATA,
      "rs/shop.rs#weigh": FUNCTION,
      // C: a struct and an enum are types; a file-scope variable is file-level data.
      "c/shop.c#basket": TYPE,
      "c/shop.c#hue": TYPE,
      "c/shop.c#limit": FILE_DATA,
      "c/shop.c#weigh": FUNCTION,
      // C++: a class and a struct are types; a constructor is a method.
      "cpp/shop.cpp#Basket": TYPE,
      "cpp/shop.cpp#Basket.Basket": METHOD,
      "cpp/shop.cpp#Basket.sum": METHOD,
      "cpp/shop.cpp#Shelf": TYPE,
      "cpp/shop.cpp#Shelf.pick": METHOD,
      // A shell function and a Perl sub are functions; a Perl constant is file-level data.
      "sh/shop.sh#weigh": FUNCTION,
      "pl/shop.pl#weigh": FUNCTION,
      "pl/shop.pl#LIMIT": FILE_DATA,
      // An SQL trigger is a function.
      "sql/shop.sql#basket_added": FUNCTION,
    };
    const got = Object.fromEntries(Object.keys(expected).map((key) => [key, kinds.get(key) ?? "(no node)"]));
    expect(got).toEqual(expected);
    db.close();
  });
});

// The built-in rules keep their rules with the common kinds ("Links on proof"): a construction links
// to the class, a receiver proves its type only when it is written as a class's name, and a call
// links to a function even when a type of the same name lives in the other declaration space.
const LINKS: Record<string, string> = {
  "src/till.ts": lines(
    "export class Register {", //                                1
    "  open(): number { return 1; }", //                         2
    "}", //                                                      3
    "export interface Drawer { count(): number }", //            4
    "export type Receipt = string;", //                          5
    "export function Receipt(): string { return 'r'; }", //      6
    "export function close(drawer: Drawer): number {", //        7
    "  const reg: Register = new Register();", //                8
    "  drawer.count();", //                                      9
    "  Receipt();", //                                           10
    "  return reg.open();", //                                   11
    "}", //                                                      12
    "close({ count: () => 0 });", //                             13
  ),
  "src/till.py": lines(
    "class Ledger:", //        1
    "    pass", //             2
    "", //                     3
    "def book():", //          4
    "    return Ledger()", //  5
  ),
};

type Link = { src: string; dst_name: string; dst: string | null; dst_kind: string | null };

function linksOf(db: Database): Link[] {
  return db
    .query(
      `SELECT s.qualified_name AS src, e.dst_name, d.path || '#' || d.qualified_name AS dst, d.kind AS dst_kind
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.kind <> 'imports'`,
    )
    .all(LAYER) as Link[];
}

function one(links: Link[], src: string, name: string): Link {
  const found = links.filter((l) => l.src === src && l.dst_name === name);
  if (found.length !== 1) throw new Error(`${found.length} links of ${name} from ${src}`);
  return found[0]!;
}

describe("links and lookups in the common kinds", () => {
  test("a construction links to its class, an interface's name proves no receiver, and a function shares its name with a type", async () => {
    const sha = commit(LINKS);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, LAYER, { force: true, links: "built-in" });
    const links = linksOf(db);
    expect(one(links, "close", "Register")).toMatchObject({ dst: "src/till.ts#Register", dst_kind: TYPE });
    expect(one(links, "close", "open")).toMatchObject({ dst: "src/till.ts#Register.open", dst_kind: METHOD });
    expect(one(links, "close", "count")).toMatchObject({ dst: null });
    expect(one(links, "close", "Receipt")).toMatchObject({ dst: "src/till.ts#Receipt", dst_kind: FUNCTION });
    expect(one(links, "book", "Ledger")).toMatchObject({ dst: "src/till.py#Ledger", dst_kind: TYPE });
    db.close();
  });

  test("graph_find and graph_symbol answer in the common kinds", async () => {
    const sha = commit(LINKS);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, LAYER, { force: true, links: "built-in" });
    const hit = find(db, LAYER, "Register").find((h) => h.kind === "symbol" && h.qualifiedName === "Register");
    expect(hit).toMatchObject({ symbolKind: TYPE });
    const ledger = lookupSymbol(db, LAYER, "Ledger").cards[0]!;
    expect(ledger.symbol.kind).toBe(TYPE);
    expect(ledger.callers.map((c) => ({ name: c.qualifiedName, kind: c.kind }))).toEqual([{ name: "book", kind: FUNCTION }]);
    // A call written at the top of a file is the file's: its caller row is the file.
    const close = lookupSymbol(db, LAYER, "close", "src/till.ts").cards[0]!;
    expect(close.symbol.kind).toBe(FUNCTION);
    expect(close.callers.map((c) => ({ name: c.qualifiedName, kind: c.kind }))).toEqual([{ name: "src/till.ts", kind: FILE }]);
    const file = lookupSymbol(db, LAYER, "src/till.ts").cards[0]!;
    expect(file.symbol.kind).toBe(FILE);
    db.close();
  });
});

describe("the graph's store", () => {
  test("a graph of the schema before the common kinds has its stored kinds rewritten to them", () => {
    const db = openGraphDb(project, null);
    const insert = db.prepare("INSERT INTO symbols (layer, path, kind, qualified_name, name) VALUES ('old', ?, ?, ?, ?)");
    const old: [string, string, string][] = [
      ["a.ts", "module", "a.ts"],
      ["a.ts", "class", "Cart"],
      ["a.ts", "interface", "Item"],
      ["a.ts", "type", "Id"],
      ["a.ts", "const", "MAX"],
      ["a.ts", "function", "total"],
      ["a.ts", "method", "Cart.total"],
      ["run.sh", "sh_function", "deploy"],
      ["", "data_source", "orders"],
    ];
    for (const [file, kind, name] of old) insert.run(file, kind, name, name);
    db.run("PRAGMA user_version = 9");
    db.close();
    const upgraded = openGraphDb(project, null);
    expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
    const rows = upgraded.query("SELECT qualified_name, kind FROM symbols WHERE layer = 'old' ORDER BY id").all() as { qualified_name: string; kind: string }[];
    expect(rows).toEqual([
      { qualified_name: "a.ts", kind: FILE },
      { qualified_name: "Cart", kind: TYPE },
      { qualified_name: "Item", kind: TYPE },
      { qualified_name: "Id", kind: TYPE },
      { qualified_name: "MAX", kind: FILE_DATA },
      { qualified_name: "total", kind: FUNCTION },
      { qualified_name: "Cart.total", kind: METHOD },
      { qualified_name: "deploy", kind: FUNCTION },
      { qualified_name: "orders", kind: DATA_SOURCE },
    ]);
    upgraded.close();
  });

  test("a graph that stored a trigger under a kind of its own has it rewritten to a function when it is opened", () => {
    const db = openGraphDb(project, null);
    const insert = db.prepare("INSERT INTO symbols (layer, path, kind, qualified_name, name) VALUES ('old', ?, ?, ?, ?)");
    const old: [string, string, string][] = [
      ["db/shop.sql", "file", "db/shop.sql"],
      ["db/shop.sql", "sql_trigger", "basket_added"],
      ["src/install.ts", "function", "install"],
      ["src/install.ts", "sql_trigger", "shelf_added"],
      ["", "data_source", "baskets"],
    ];
    for (const [file, kind, name] of old) insert.run(file, kind, name, name);
    const file = db.prepare("INSERT INTO files (layer, path, dir, lang, blob, size, lane) VALUES ('old', ?, ?, ?, 'b', 1, 'product')");
    file.run("db/shop.sql", "db", "sql");
    file.run("src/install.ts", "src", "typescript");
    db.run("PRAGMA user_version = 11");
    // A graph of schema 11 has no node language: the column is added by the upgrade.
    db.run("ALTER TABLE symbols DROP COLUMN lang");
    db.close();
    const upgraded = openGraphDb(project, null);
    expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
    const rows = upgraded.query("SELECT qualified_name, kind, lang FROM symbols WHERE layer = 'old' ORDER BY id").all() as { qualified_name: string; kind: string; lang: string }[];
    // A trigger in a string gets SQL, its own language; one in an .sql file is in its file's.
    expect(rows).toEqual([
      { qualified_name: "db/shop.sql", kind: FILE, lang: "" },
      { qualified_name: "basket_added", kind: FUNCTION, lang: "" },
      { qualified_name: "install", kind: FUNCTION, lang: "" },
      { qualified_name: "shelf_added", kind: FUNCTION, lang: "sql" },
      { qualified_name: "baskets", kind: DATA_SOURCE, lang: "" },
    ]);
    upgraded.close();
  });
});
