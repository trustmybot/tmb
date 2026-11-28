// Rust in the code graph (trustmybot/tmb#354), read by its tree-sitter grammar: the nodes the page's
// "Kinds of symbol" gives Rust, the place and owner of each call ("The three states of a call", "Two
// ways to make links"), and the links and states way A's built-in rules prove ("Links on proof").
// Each expectation is read off the page and the Rust Reference, call by call, not off the graph's
// output. The fixtures are small programs of their own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../../../../src/engine/graph/build.ts";
import { openGraphDb } from "../../../../src/engine/graph/db.ts";
import { rustAnalyzerVersion, rustReference } from "../../../benchmark/rust.ts";
import { git } from "../../../lib/git.ts";
import { commitFiles, RECORD_IGNORE } from "../../../lib/project.ts";

setDefaultTimeout(30_000);

let project: string;

/** Commits the files with the record ignored, as the first commit, and returns it. */
function commit(files: Record<string, string>): string {
  return commitFiles(project, { ".gitignore": RECORD_IGNORE, ...files });
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-rust-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const GARDEN = lines(
  "//! A garden.", //                                                    1
  "", //                                                                 2
  "use std::collections::HashMap;", //                                   3
  "", //                                                                 4
  "/// How many rows.", //                                               5
  "pub const ROWS: usize = rows();", //                                  6
  "", //                                                                 7
  "static NAME: &str = \"bed\";", //                                     8
  "", //                                                                 9
  "const fn rows() -> usize {", //                                       10
  "    2", //                                                            11
  "}", //                                                                12
  "", //                                                                 13
  "/// A bed of plants.", //                                             14
  "#[derive(Debug, Clone)]", //                                          15
  "pub struct Bed {", //                                                 16
  "    width: usize,", //                                                17
  "}", //                                                                18
  "", //                                                                 19
  "pub struct Seed(u8);", //                                             20
  "", //                                                                 21
  "pub enum Season {", //                                                22
  "    Spring(u8),", //                                                  23
  "    Fall { heat: u8 },", //                                           24
  "    Winter,", //                                                      25
  "}", //                                                                26
  "", //                                                                 27
  "impl Bed {", //                                                       28
  "    const SIZE: usize = rows();", //                                  29
  "", //                                                                 30
  "    /// Makes a bed.", //                                             31
  "    pub fn new() -> Self {", //                                       32
  "        Bed { width: rows() }", //                                    33
  "    }", //                                                            34
  "", //                                                                 35
  "    // Waters each row.", //                                          36
  "    #[inline]", //                                                    37
  "    fn water(&self, names: Vec<String>) -> usize {", //               38
  "        names.iter().for_each(|n| soak(n));", //                      39
  "        self.width + Self::new().width + helper()", //                40
  "    }", //                                                            41
  "}", //                                                                42
  "", //                                                                 43
  "pub trait Tool {", //                                                 44
  "    fn use_it(&self) -> u8;", //                                      45
  "", //                                                                 46
  "    fn twice(&self) -> u8 {", //                                      47
  "        self.use_it() + self.use_it()", //                            48
  "    }", //                                                            49
  "}", //                                                                50
  "", //                                                                 51
  "impl Tool for Bed {", //                                              52
  "    fn use_it(&self) -> u8 {", //                                     53
  "        Seed(1).0 + ROWS as u8", //                                   54
  "    }", //                                                            55
  "}", //                                                                56
  "", //                                                                 57
  "impl Seed {", //                                                      58
  "    fn again(&self) -> Self {", //                                    59
  "        Self(self.0)", //                                             60
  "    }", //                                                            61
  "", //                                                                 62
  "    fn spring(&self) -> Season {", //                                 63
  "        Season::Spring(self.0)", //                                   64
  "    }", //                                                            65
  "}", //                                                                66
  "", //                                                                 67
  "fn soak(n: &String) {", //                                            68
  "    fn helper() -> usize {", //                                       69
  "        1", //                                                        70
  "    }", //                                                            71
  "    let _ = helper();", //                                            72
  "    let _ = (n.len(), Season::Winter);", //                           73
  "}", //                                                                74
  "", //                                                                 75
  "fn helper() -> usize {", //                                           76
  "    println!(\"{}\", rows());", //                                    77
  "    3", //                                                            78
  "}", //                                                                79
  "", //                                                                 80
  "pub mod shed {", //                                                   81
  "    pub fn store() -> u8 {", //                                       82
  "        lock()", //                                                   83
  "    }", //                                                            84
  "", //                                                                 85
  "    fn lock() -> u8 {", //                                            86
  "        super::rows() as u8 + Rake::rake() + helper()", //            87
  "    }", //                                                            88
  "", //                                                                 89
  "    fn helper() -> u8 {", //                                          90
  "        4", //                                                        91
  "    }", //                                                            92
  "", //                                                                 93
  "    pub struct Rake;", //                                             94
  "", //                                                                 95
  "    impl Rake {", //                                                  96
  "        pub fn rake() -> u8 {", //                                    97
  "            0", //                                                    98
  "        }", //                                                        99
  "    }", //                                                            100
  "}", //                                                                101
  "", //                                                                 102
  "extern \"C\" {", //                                                   103
  "    fn abs(x: i32) -> i32;", //                                       104
  "}", //                                                                105
  "", //                                                                 106
  "fn shadows(helper: fn() -> usize) -> usize {", //                    107
  "    helper() + unsafe { abs(-1) } as usize", //                       108
  "}", //                                                                109
  "", //                                                                 110
  "fn tools<T: Tool>(t: T) -> u8 {", //                                  111
  "    t.twice() + HashMap::<u8, u8>::new().len() as u8", //             112
  "}", //                                                                113
);

// A glob import: the module's own items still win (names/name-resolution.html), but a name it does not declare may be any the glob brings.
const GLOB = lines(
  "use crate::shed::*;", //                                              1
  "", //                                                                 2
  "fn local() {}", //                                                    3
  "", //                                                                 4
  "fn calls() -> u8 {", //                                               5
  "    local();", //                                                     6
  "    store()", //                                                      7
  "}", //                                                                8
);

// Two items of one name in one scope, as `cfg` makes them: one is compiled, which the parser cannot say.
const SEP = lines(
  "#[cfg(unix)]", //                                                     1
  "fn sep() -> char {", //                                               2
  "    '/'", //                                                          3
  "}", //                                                                4
  "", //                                                                 5
  "#[cfg(windows)]", //                                                  6
  "fn sep() -> char {", //                                               7
  "    '\\\\'", //                                                       8
  "}", //                                                                9
  "", //                                                                 10
  "fn path() -> char {", //                                              11
  "    sep()", //                                                        12
  "}", //                                                                13
);

// A macro invoked where an item goes may declare any item: a name the module does not write out is not proven absent.
const MADE = lines(
  "macro_rules! make {", //                                              1
  "    ($n:ident) => {", //                                              2
  "        fn $n() {}", //                                               3
  "    };", //                                                           4
  "}", //                                                                5
  "", //                                                                 6
  "make!(made);", //                                                     7
  "", //                                                                 8
  "fn call() {", //                                                      9
  "    made();", //                                                      10
  "}", //                                                                11
);

// An implementation for a type the file declares in another module: its method is named through the
// type, and held by the file (CODE_GRAPH.md, "A member is always inside its type", edge case 3).
const FAR = lines(
  "pub struct Far;", //                                                  1
  "", //                                                                 2
  "mod inner {", //                                                      3
  "    impl super::Far {", //                                            4
  "        pub fn go() {}", //                                           5
  "    }", //                                                            6
  "}", //                                                                7
  "", //                                                                 8
  "impl Late {", //                                                      9
  "    fn early() {}", //                                                10
  "}", //                                                                11
  "", //                                                                 12
  "struct Late;", //                                                     13
);

const FILES: Record<string, string> = {
  "src/lib.rs": GARDEN,
  "src/far.rs": FAR,
  "src/glob.rs": GLOB,
  "src/sep.rs": SEP,
  "src/made.rs": MADE,
};

type SymbolRow = { path: string; kind: string; qualified_name: string; start_line: number; end_line: number; parent: string | null; unnamed: number; owner: string | null; doc: string; exported: number };

function symbols(db: Database, layer: string): SymbolRow[] {
  return db
    .query(
      `SELECT s.path, s.kind, s.qualified_name, s.start_line, s.end_line, p.qualified_name AS parent, s.unnamed, o.qualified_name AS owner, s.doc, s.exported
         FROM symbols s LEFT JOIN symbols p ON p.id = s.parent_id LEFT JOIN symbols o ON o.id = s.named_id
        WHERE s.layer = ? AND s.kind != 'file'`,
    )
    .all(layer) as SymbolRow[];
}

type CallRow = { src: string; src_unnamed: number; dst_name: string; line: number; pos: number; dst: string | null; dst_line: number | null; call_state: string };

function calls(db: Database, layer: string): CallRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, s.unnamed AS src_unnamed, e.dst_name, e.line, e.pos, d.path || ':' || d.qualified_name AS dst, d.start_line AS dst_line, e.call_state
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state IS NOT NULL ORDER BY e.pos`,
    )
    .all(layer) as CallRow[];
}

/** The offset of the `nth` (0-based) `needle` in `text`: where a call's name is written. */
function at(text: string, needle: string, nth = 0): number {
  let i = -1;
  for (let k = 0; k <= nth; k++) {
    i = text.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`no ${needle} #${nth}`);
  }
  return i;
}

/** The one call of `file` whose name is written at `pos`. */
function callAt(rows: CallRow[], file: string, pos: number): CallRow {
  const found = rows.filter((r) => r.src.startsWith(`${file}:`) && r.pos === pos);
  if (found.length !== 1) throw new Error(`${found.length} calls at ${file}:${pos}`);
  return found[0]!;
}

async function built(files: Record<string, string> = FILES): Promise<Database> {
  const sha = commit(files);
  const db = openGraphDb(project, null);
  await buildLayer(db, project, sha, "a", { force: true, links: "built-in" });
  return db;
}

const LIB = "src/lib.rs";

describe("nodes", () => {
  test("each function, method, type, trait and inline module is a node; an impl's methods are its type's; a module's items are named through it", async () => {
    const db = await built();
    try {
      const rows = symbols(db, "a").filter((r) => r.path === LIB);
      const named = rows.filter((r) => r.unnamed === 0).map(({ kind, qualified_name, start_line, end_line, parent }) => ({ kind, qualified_name, start_line, end_line, parent }));
      const want = [
        // A constant and a static at the file's top level are file-level data (items/constant-items.html,
        // items/static-items.html); a node starts at its first doc comment (comments.html#doc-comments).
        { kind: "file_level_data", qualified_name: "ROWS", start_line: 5, end_line: 6, parent: LIB },
        { kind: "file_level_data", qualified_name: "NAME", start_line: 8, end_line: 8, parent: LIB },
        // A function item (items/functions.html).
        { kind: "function", qualified_name: "rows", start_line: 10, end_line: 12, parent: LIB },
        // A struct, an enum (items/structs.html, items/enumerations.html) is a type; it starts at its doc
        // comment, before its attributes; a derive is an attribute and no node.
        { kind: "type", qualified_name: "Bed", start_line: 14, end_line: 18, parent: LIB },
        { kind: "type", qualified_name: "Seed", start_line: 20, end_line: 20, parent: LIB },
        { kind: "type", qualified_name: "Season", start_line: 22, end_line: 26, parent: LIB },
        // An associated function (items/associated-items.html) is a method of the type its impl is for,
        // held by that type and named through it; a plain comment above it does not move its start.
        { kind: "method", qualified_name: "Bed.new", start_line: 31, end_line: 34, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.water", start_line: 37, end_line: 41, parent: "Bed" },
        // A trait (items/traits.html) is an interface; its function with no body is a node.
        { kind: "type", qualified_name: "Tool", start_line: 44, end_line: 50, parent: LIB },
        { kind: "method", qualified_name: "Tool.use_it", start_line: 45, end_line: 45, parent: "Tool" },
        { kind: "method", qualified_name: "Tool.twice", start_line: 47, end_line: 49, parent: "Tool" },
        // An impl of a trait for a type gives the type its methods: `Bed.use_it` is Bed's.
        { kind: "method", qualified_name: "Bed.use_it", start_line: 53, end_line: 55, parent: "Bed" },
        { kind: "method", qualified_name: "Seed.again", start_line: 59, end_line: 61, parent: "Seed" },
        { kind: "method", qualified_name: "Seed.spring", start_line: 63, end_line: 65, parent: "Seed" },
        { kind: "function", qualified_name: "soak", start_line: 68, end_line: 74, parent: LIB },
        // An item in a function's body is local to its block (statements.html#item-declarations): a
        // function inside the function, named by itself.
        { kind: "function", qualified_name: "helper", start_line: 69, end_line: 71, parent: "soak" },
        { kind: "function", qualified_name: "helper", start_line: 76, end_line: 79, parent: LIB },
        // A module written with a body (items/modules.html) is a type-like container: its items are named through it.
        { kind: "type", qualified_name: "shed", start_line: 81, end_line: 101, parent: LIB },
        { kind: "function", qualified_name: "shed.store", start_line: 82, end_line: 84, parent: "shed" },
        { kind: "function", qualified_name: "shed.lock", start_line: 86, end_line: 88, parent: "shed" },
        { kind: "function", qualified_name: "shed.helper", start_line: 90, end_line: 92, parent: "shed" },
        { kind: "type", qualified_name: "shed.Rake", start_line: 94, end_line: 94, parent: "shed" },
        { kind: "method", qualified_name: "shed.Rake.rake", start_line: 97, end_line: 99, parent: "shed.Rake" },
        { kind: "function", qualified_name: "shadows", start_line: 107, end_line: 109, parent: LIB },
        { kind: "function", qualified_name: "tools", start_line: 111, end_line: 113, parent: LIB },
      ];
      expect(named).toEqual(expect.arrayContaining(want));
      // Nothing else is a node: no field, enum variant, associated constant (a field of its type, not
      // yet a node), `use`, extern function (its code is elsewhere), parameter or local.
      expect(named).toHaveLength(want.length);
      for (const none of ["width", "Spring", "Fall", "Winter", "SIZE", "Bed.SIZE", "HashMap", "abs", "names", "n", "t"]) expect(rows.map((r) => r.qualified_name)).not.toContain(none);
      // A closure (expressions/closure-expr.html) is an unnamed function, held and owned by the function it is written in.
      const unnamed = rows.filter((r) => r.unnamed === 1);
      expect(unnamed.map(({ kind, qualified_name, start_line, end_line, parent, owner }) => ({ kind, qualified_name, start_line, end_line, parent, owner }))).toEqual([
        { kind: "function", qualified_name: "callback of `for_each`", start_line: 39, end_line: 39, parent: "Bed.water", owner: "Bed.water" },
      ]);
    } finally {
      db.close();
    }
  });

  test("two items of one name are two nodes; a macro's definition and invocation are none; a method of a type of another scope is held by the file", async () => {
    const db = await built();
    try {
      const sep = symbols(db, "a").filter((r) => r.path === "src/sep.rs");
      expect(sep.map((r) => [r.qualified_name, r.start_line, r.end_line])).toEqual(
        expect.arrayContaining([
          ["sep", 1, 4],
          ["sep", 6, 9],
          ["path", 11, 13],
        ]),
      );
      expect(sep).toHaveLength(3);
      const made = symbols(db, "a").filter((r) => r.path === "src/made.rs");
      expect(made.map((r) => r.qualified_name)).toEqual(["call"]);
      // A method whose type is declared in another scope is still named through the type, and held by the file.
      const far = symbols(db, "a").filter((r) => r.path === "src/far.rs");
      expect(far.map(({ kind, qualified_name, parent }) => ({ kind, qualified_name, parent }))).toEqual(
        expect.arrayContaining([
          { kind: "type", qualified_name: "Far", parent: "src/far.rs" },
          { kind: "type", qualified_name: "inner", parent: "src/far.rs" },
          { kind: "method", qualified_name: "Far.go", parent: "src/far.rs" },
          // An item is in scope in its whole module, before its declaration too (names/scopes.html#item-scopes).
          { kind: "type", qualified_name: "Late", parent: "src/far.rs" },
          { kind: "method", qualified_name: "Late.early", parent: "Late" },
        ]),
      );
      expect(far).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  test("a declaration's doc is the doc comment above it, and it is exported when it is `pub`, as every function of a public trait is", async () => {
    const db = await built();
    try {
      const rows = symbols(db, "a").filter((r) => r.path === LIB);
      const of = (name: string, line?: number) => rows.find((r) => r.qualified_name === name && (line === undefined || r.start_line === line))!;
      expect(of("ROWS").doc).toBe("How many rows.");
      expect(of("Bed").doc).toBe("A bed of plants.");
      expect(of("Bed.new").doc).toBe("Makes a bed.");
      // `pub` (visibility-and-privacy.html); a trait's items have its visibility (items/traits.html).
      expect([of("ROWS").exported, of("Bed").exported, of("Bed.new").exported, of("Tool").exported, of("Tool.use_it").exported, of("shed").exported, of("shed.store").exported]).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect([of("NAME").exported, of("rows").exported, of("Bed.water").exported, of("soak").exported, of("shed.lock").exported]).toEqual([0, 0, 0, 0, 0]);
    } finally {
      db.close();
    }
  });
});

describe("calls", () => {
  test("a call is placed where its called name is written: a path's last segment, a method's name", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      expect(callAt(rows, LIB, at(GARDEN, "new().width")).dst_name).toBe("new");
      expect(callAt(rows, LIB, at(GARDEN, "for_each(")).dst_name).toBe("for_each");
      expect(callAt(rows, LIB, at(GARDEN, "Spring(self")).dst_name).toBe("Spring");
      expect(callAt(rows, LIB, at(GARDEN, "new().len")).dst_name).toBe("new");
      // Two calls of one name on one line are two.
      expect(callAt(rows, LIB, at(GARDEN, "use_it()", 0)).line).toBe(48);
      expect(callAt(rows, LIB, at(GARDEN, "use_it()", 1)).line).toBe(48);
      // A macro's input is tokens to the parser, not expressions (macros.html). The built-in rules
      // have no tool to ask, so a name there written as a call is a call at that name, not known
      // (CODE_GRAPH.md, "Inside a macro, the tool says what is a call", edge case 1).
      expect(callAt(rows, LIB, at(GARDEN, "rows());")).dst_name).toBe("rows");
      expect(rows.filter((r) => r.src.startsWith(`${LIB}:`) && r.line === 77).map((r) => r.dst_name)).toEqual(["rows"]);
      // A unit variant and a struct expression are no calls (expressions/struct-expr.html).
      expect(rows.filter((r) => r.src.startsWith(`${LIB}:`) && (r.dst_name === "Winter" || r.dst_name === "Bed"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a call belongs to the nearest function; in a constant's value at the file's top, to it; in an associated constant's, to the type; in a closure, to the closure", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      expect(callAt(rows, LIB, at(GARDEN, "rows()", 0)).src).toBe(`${LIB}:ROWS`);
      expect(callAt(rows, LIB, at(GARDEN, "rows()", 2)).src).toBe(`${LIB}:Bed`);
      expect(callAt(rows, LIB, at(GARDEN, "rows()", 3)).src).toBe(`${LIB}:Bed.new`);
      const inClosure = callAt(rows, LIB, at(GARDEN, "soak(n)"));
      expect([inClosure.src, inClosure.src_unnamed]).toEqual([`${LIB}:callback of \`for_each\``, 1]);
      expect(callAt(rows, LIB, at(GARDEN, "helper();")).src).toBe(`${LIB}:soak`);
      expect(callAt(rows, LIB, at(GARDEN, "lock()")).src).toBe(`${LIB}:shed.store`);
    } finally {
      db.close();
    }
  });
});

describe("way A", () => {
  test("a bare name links to the one function its block or module declares, the innermost scope first (names/scopes.html)", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const link = (needle: string, nth = 0) => {
        const r = callAt(rows, LIB, at(GARDEN, needle, nth));
        return [r.call_state, r.dst, r.dst_line];
      };
      // A file-level function, from a constant's value, an associated constant's, a method and a closure.
      expect(link("rows()", 0)).toEqual(["linked", `${LIB}:rows`, 10]);
      expect(link("rows()", 2)).toEqual(["linked", `${LIB}:rows`, 10]);
      expect(link("rows()", 3)).toEqual(["linked", `${LIB}:rows`, 10]);
      expect(link("soak(n)")).toEqual(["linked", `${LIB}:soak`, 68]);
      // An item of the block wins over the module's of the same name; out of the block, the module's.
      expect(link("helper();")).toEqual(["linked", `${LIB}:helper`, 69]);
      expect(link("helper()", 0)).toEqual(["linked", `${LIB}:helper`, 76]);
      // Inside a module, its own items: `lock`, and its own `helper`, not the file's.
      expect(link("lock()")).toEqual(["linked", `${LIB}:shed.lock`, 86]);
      expect(link("helper()\n    }\n\n    fn helper")).toEqual(["linked", `${LIB}:shed.helper`, 90]);
      const glob = callAt(rows, "src/glob.rs", at(GLOB, "local();"));
      expect([glob.call_state, glob.dst]).toEqual(["linked", "src/glob.rs:local"]);
    } finally {
      db.close();
    }
  });

  test("a tuple struct's or a tuple variant's constructor links to its type (items/structs.html, items/enumerations.html), `Self(…)` too", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const link = (needle: string, nth = 0) => {
        const r = callAt(rows, LIB, at(GARDEN, needle, nth));
        return [r.call_state, r.dst];
      };
      expect(link("Seed(1).0")).toEqual(["linked", `${LIB}:Seed`]);
      expect(link("Self(self.0)")).toEqual(["linked", `${LIB}:Seed`]);
      expect(link("Spring(self")).toEqual(["linked", `${LIB}:Season`]);
    } finally {
      db.close();
    }
  });

  test("what the built-in rules cannot prove is not known, never guessed", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const state = (file: string, text: string, needle: string, nth = 0) => {
        const r = callAt(rows, file, at(text, needle, nth));
        return [r.call_state, r.dst];
      };
      const notKnown = ["not_known", null];
      // A method call: which impl it reaches is the type checker's (expressions/method-call-expr.html).
      expect(state(LIB, GARDEN, "iter()")).toEqual(notKnown);
      expect(state(LIB, GARDEN, "for_each(")).toEqual(notKnown);
      expect(state(LIB, GARDEN, "use_it()", 0)).toEqual(notKnown);
      expect(state(LIB, GARDEN, "twice()")).toEqual(notKnown);
      // An associated function by its type's path: an impl of the type may be in any module of the crate.
      expect(state(LIB, GARDEN, "new().width")).toEqual(notKnown);
      expect(state(LIB, GARDEN, "rake()")).toEqual(notKnown);
      expect(state(LIB, GARDEN, "new().len")).toEqual(notKnown);
      // A path through another module.
      expect(state(LIB, GARDEN, "rows() as u8")).toEqual(notKnown);
      // A local variable of the name hides the item (names/scopes.html#pattern-binding-scopes): a parameter here.
      expect(state(LIB, GARDEN, "helper() + unsafe")).toEqual(notKnown);
      // A function of an extern block has its code elsewhere.
      expect(state(LIB, GARDEN, "abs(-1)")).toEqual(notKnown);
      // Two items of the name, as cfg writes them: which one is compiled the parser cannot say.
      expect(state("src/sep.rs", SEP, "sep()\n")).toEqual(notKnown);
      // A name a glob import or an item macro may bring.
      expect(state("src/glob.rs", GLOB, "store()")).toEqual(notKnown);
      expect(state("src/made.rs", MADE, "made();")).toEqual(notKnown);
      // A name written as a call in a macro's input, with no tool to ask: not known, and no link.
      expect(state(LIB, GARDEN, "rows());")).toEqual(notKnown);
    } finally {
      db.close();
    }
  });
});

const raFound = rustAnalyzerVersion() !== null;

describe("Rust's own parser", () => {
  test.skipIf(!raFound)("every function and closure rust-analyzer's parser finds is one function of the graph, and the graph has no other (skipped without rust-analyzer on PATH)", async () => {
    const db = await built();
    try {
      const ref = rustReference(new Map(Object.entries(FILES)));
      for (const file of Object.keys(FILES)) {
        const answer = ref.files[file];
        if (answer === undefined || "error" in answer) throw new Error(`rust-analyzer cannot read ${file}: ${JSON.stringify(answer)}`);
        const graph = db
          .query("SELECT start_line || '-' || end_line AS span FROM symbols WHERE layer = 'a' AND path = ? AND kind IN ('function', 'method') ORDER BY span")
          .all(file) as { span: string }[];
        expect({ file, spans: graph.map((r) => r.span).sort() }).toEqual({ file, spans: [...answer.functions].sort() });
      }
    } finally {
      db.close();
    }
  });

  test.skipIf(!raFound)("every call rust-analyzer's parser finds has a state, in the function it belongs to (skipped without rust-analyzer on PATH)", async () => {
    const db = await built();
    try {
      const ref = rustReference(new Map(Object.entries(FILES)));
      const rows = db
        .query(
          `SELECT s.path AS path, s.kind AS kind, s.start_line AS start, s.end_line AS end FROM edges e JOIN symbols s ON s.id = e.src_id
            WHERE e.layer = 'a' AND e.call_state IS NOT NULL`,
        )
        .all() as { path: string; kind: string; start: number; end: number }[];
      const graph: Record<string, number> = {};
      for (const r of rows) {
        const key = `${r.path}:${r.kind === "function" || r.kind === "method" ? `${r.start}-${r.end}` : ""}`;
        graph[key] = (graph[key] ?? 0) + 1;
      }
      const want: Record<string, number> = {};
      for (const [file, answer] of Object.entries(ref.files)) {
        if ("error" in answer) continue;
        for (const [owner, n] of Object.entries(answer.calls)) want[`${file}:${owner}`] = n;
        // With no tool to ask, each name written as a call in a macro's input is a call (CODE_GRAPH.md,
        // "Inside a macro, the tool says what is a call", edge case 1).
        for (const m of answer.inMacro) want[`${file}:${m.owner}`] = (want[`${file}:${m.owner}`] ?? 0) + 1;
      }
      expect(graph).toEqual(want);
    } finally {
      db.close();
    }
  });

  // A call is identified by its position: where the name it calls is written ("Two ways to make
  // links"). The name of a path is its last segment, `Self` included; a method's is its own name. A
  // callee that is no path, such as a parenthesized value or a field, names nothing.
  test.skipIf(!raFound)("rust-analyzer's parser names each call at the name it calls, as UTF-16 offsets (skipped without rust-analyzer on PATH)", () => {
    const text = 'fn g() { let s = "héllo 🌱"; Self(0); Self::V(1); s.len(); f::<u8>(); r#match(); (s)(); s.0(); crate::m::h(); }\n';
    const ref = rustReference(new Map([["src/a.rs", text]]));
    const answer = ref.files["src/a.rs"];
    if (answer === undefined || "error" in answer) throw new Error(JSON.stringify(answer));
    const at = (needle: string, from = 0) => text.indexOf(needle, from);
    expect(answer.named).toEqual([
      { pos: at("Self(0)"), line: 1, name: "Self", shape: "name" },
      { pos: at("V(1)"), line: 1, name: "V", shape: "path" },
      { pos: at("len"), line: 1, name: "len", shape: "method" },
      { pos: at("f::<u8>"), line: 1, name: "f", shape: "name" },
      { pos: at("r#match"), line: 1, name: "r#match", shape: "name" },
      { pos: at("m::h()") + "m::".length, line: 1, name: "h", shape: "path" },
    ]);
  });

  // CODE_GRAPH.md, "Inside a macro, the tool says what is a call": a macro's input is tokens to the
  // parser, so the reference lists each name written there as a call (a name, then a parenthesized
  // group: The Rust Reference, "Call expressions", "Method-call expressions"), with the function the
  // macro is written in, for the tool to say which are calls. A `macro_rules!` body is no macro's
  // input, nor is an attribute's (The Rust Reference, "Macros By Example", "Attributes").
  test.skipIf(!raFound)("rust-analyzer's parser lists the names written as calls in a macro's input, each in the function around the macro (skipped without rust-analyzer on PATH)", () => {
    const text = lines(
      "fn g() {", //                                                    1
      "    assert_eq!(a::h(1), x.len());", //                            2
      "    m![r#match (2), k];", //                                      3
      "    let _ = |y| p!(q(y));", //                                    4
      "}", //                                                           5
      "m! { static X: u32 = z(); }", //                                 6
      "macro_rules! d { ($f:ident) => { $f(1) }; }", //                 7
      "#[cfg(feature(x))]", //                                          8
      "fn w() {}", //                                                   9
    );
    const ref = rustReference(new Map([["src/a.rs", text]]));
    const answer = ref.files["src/a.rs"];
    if (answer === undefined || "error" in answer) throw new Error(JSON.stringify(answer));
    expect(answer.inMacro).toEqual([
      { pos: at(text, "h(1)"), line: 2, name: "h", owner: "1-5" },
      { pos: at(text, "len"), line: 2, name: "len", owner: "1-5" },
      { pos: at(text, "r#match"), line: 3, name: "r#match", owner: "1-5" },
      { pos: at(text, "q(y)"), line: 4, name: "q", owner: "4-4" },
      { pos: at(text, "z()"), line: 6, name: "z", owner: "" },
    ]);
    // None of them is among the parser's own calls.
    expect(answer.calls).toEqual({});
  });

  test.skipIf(!raFound)("each call rust-analyzer's parser names is the graph's call at that position, of that name (skipped without rust-analyzer on PATH)", async () => {
    const db = await built();
    try {
      const ref = rustReference(new Map(Object.entries(FILES)));
      const rows = db.query("SELECT s.path AS path, e.pos AS pos, e.dst_name AS name FROM edges e JOIN symbols s ON s.id = e.src_id WHERE e.layer = 'a' AND e.call_state IS NOT NULL").all() as {
        path: string;
        pos: number;
        name: string;
      }[];
      const graph = new Set(rows.map((r) => `${r.path}:${r.pos}:${r.name}`));
      const named = Object.entries(ref.files).flatMap(([file, answer]) => ("error" in answer ? [] : answer.named.map((c) => `${file}:${c.pos}:${c.name}`)));
      expect(named.length).toBeGreaterThan(0);
      expect(named.filter((c) => !graph.has(c))).toEqual([]);
    } finally {
      db.close();
    }
  });
});
