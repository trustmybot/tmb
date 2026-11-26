// C in the code graph (trustmybot/tmb#355), read by its tree-sitter grammar: the nodes the page's
// "Kinds of symbol" gives C, the place and owner of each call ("The three states of a call", "Two ways
// to make links"), and the links way A's built-in rules prove ("Links on proof"). Each expectation is
// read off the page and the C standard (ISO/IEC 9899:2011), call by call, not off the graph's output.
// It also holds which language a `.h` file is read as. The fixtures are small programs of their own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../src/engine/graph/build.ts";
import { openGraphDb } from "../src/engine/graph/db.ts";

setDefaultTimeout(30_000);

let project: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(files: Record<string, string>): string {
  for (const [file, text] of Object.entries({ ".gitignore": ".tmb/\n", ...files })) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  return git(project, "rev-parse", "HEAD");
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-c-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const SHELF = lines(
  "/* A shelf of jars. */", //                                  1
  "#include <stdio.h>", //                                      2
  '#include "shelf.h"', //                                      3
  "", //                                                        4
  "#define LABEL(x) label_of(x)", //                            5
  "", //                                                        6
  "struct jar {", //                                            7
  "  int size;", //                                             8
  "  int (*open)(int);", //                                     9
  "};", //                                                      10
  "", //                                                        11
  "typedef struct {", //                                        12
  "  int count;", //                                            13
  "} row;", //                                                  14
  "", //                                                        15
  "enum lid { TIGHT, LOOSE };", //                              16
  "", //                                                        17
  "static int capacity = 12;", //                               18
  "int filled = 0, spare;", //                                  19
  "extern int shared;", //                                      20
  "int count_jars(int n);", //                                  21
  "", //                                                        22
  "/* Counts the jars on a shelf. */", //                       23
  "static int count_jars(int n) {", //                          24
  "  return n + helper();", //                                  25
  "}", //                                                       26
  "", //                                                        27
  "int helper(void) { return capacity; }", //                   28
  "", //                                                        29
  "int stack(struct jar *j) {", //                              30
  "  int total = count_jars(3);", //                            31
  "  total += j->open(1);", //                                  32
  '  total += printf("x");', //                                 33
  "  total += LABEL(2) + label_of(1);", //                      34
  "  int (*pick)(int) = count_jars;", //                        35
  "  return total + pick(2);", //                               36
  "}", //                                                       37
  "", //                                                        38
  "static int (*chooser(int k))(int) {", //                     39
  "  return k ? count_jars : 0;", //                            40
  "}", //                                                       41
  "", //                                                        42
  "int shadow(int helper) {", //                                43
  "  return helper;", //                                        44
  "}", //                                                       45
  "", //                                                        46
  "int hidden(void) {", //                                      47
  "  int (*helper)(void) = 0;", //                              48
  "  return helper();", //                                      49
  "}", //                                                       50
  "", //                                                        51
  "#ifdef WIDE", //                                             52
  "int width(void) { return 2; }", //                           53
  "#else", //                                                   54
  "int width(void) { return 1; }", //                           55
  "#endif", //                                                  56
  "int measure(void) { return width(); }", //                   57
  "", //                                                        58
  "#ifdef TALL", //                                             59
  "int height(void) { return 3; }", //                          60
  "#endif", //                                                  61
  "int reach(void) { return height(); }", //                    62
  "", //                                                        63
  "SHELF_TEST(lid_fits) {", //                                  64
  "  return count_jars(1);", //                                 65
  "}", //                                                       66
  "", //                                                        67
  "int probe(void) { return lid_fits(); }", //                  68
);

// A header in C: no C++ construct in it.
const SHELF_H = lines(
  "#ifndef SHELF_H", //                                         1
  "#define SHELF_H", //                                         2
  "struct shelf_info { int rows; };", //                        3
  "int count_jars(int n);", //                                  4
  "static inline int twice(int x) { return 2 * x; }", //        5
  "#endif", //                                                  6
);

// A header in C++: it opens a namespace and a class.
const DRAWER_H = lines(
  "#pragma once", //                                            1
  "namespace pantry {", //                                      2
  "class Drawer {", //                                          3
  " public:", //                                                4
  "  int Pull() { return 1; }", //                              5
  "};", //                                                      6
  "}  // namespace pantry", //                                  7
);

const FILES: Record<string, string> = {
  "pantry/shelf.c": SHELF,
  "pantry/shelf.h": SHELF_H,
  "pantry/drawer.h": DRAWER_H,
};

type SymbolRow = { path: string; kind: string; qualified_name: string; start_line: number; end_line: number; parent: string | null; unnamed: number; doc: string; exported: number };

function symbols(db: Database, layer: string): SymbolRow[] {
  return db
    .query(
      `SELECT s.path, s.kind, s.qualified_name, s.start_line, s.end_line, p.qualified_name AS parent, s.unnamed, s.doc, s.exported
         FROM symbols s LEFT JOIN symbols p ON p.id = s.parent_id
        WHERE s.layer = ? AND s.kind != 'module'`,
    )
    .all(layer) as SymbolRow[];
}

type CallRow = { src: string; dst_name: string; line: number; pos: number; dst: string | null; dst_line: number | null; call_state: string };

function calls(db: Database, layer: string): CallRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name, e.line, e.pos, d.path || ':' || d.qualified_name AS dst, d.start_line AS dst_line, e.call_state
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

describe("a .h file's language", () => {
  test("a .c file is C; a .h file is C++ when its text has a construct only C++ has, else C", async () => {
    const db = await built({ ...FILES, "pantry/lid.hpp": lines("namespace pantry {", "int Seal();", "}") });
    try {
      const langs = Object.fromEntries((db.query("SELECT path, lang FROM files WHERE layer = 'a'").all() as { path: string; lang: string | null }[]).map((r) => [r.path, r.lang]));
      expect(langs["pantry/shelf.c"]).toBe("c");
      expect(langs["pantry/shelf.h"]).toBe("c");
      expect(langs["pantry/drawer.h"]).toBe("cpp");
      expect(langs["pantry/lid.hpp"]).toBe("cpp");
    } finally {
      db.close();
    }
  });
});

describe("nodes", () => {
  test("each function definition, type with a body and file-level variable is a node; a prototype, an extern declaration, a field and an enumerator are none", async () => {
    const db = await built();
    try {
      const file = "pantry/shelf.c";
      const rows = symbols(db, "a").filter((r) => r.path === file);
      const got = rows.map(({ kind, qualified_name, start_line, end_line, parent }) => ({ kind, qualified_name, start_line, end_line, parent }));
      const want = [
        // A structure, a union or an enumeration with a body is a type (C11 6.7.2.1, 6.7.2.2); one
        // with no tag is named by the typedef name it is given (6.7.8).
        { kind: "type", qualified_name: "jar", start_line: 7, end_line: 10, parent: file },
        { kind: "type", qualified_name: "row", start_line: 12, end_line: 14, parent: file },
        { kind: "type", qualified_name: "lid", start_line: 16, end_line: 16, parent: file },
        // A variable declared at file scope is file-level data (6.9.2), one node per name.
        { kind: "const", qualified_name: "capacity", start_line: 18, end_line: 18, parent: file },
        { kind: "const", qualified_name: "filled", start_line: 19, end_line: 19, parent: file },
        { kind: "const", qualified_name: "spare", start_line: 19, end_line: 19, parent: file },
        // A function definition is a function (6.9.1); its prototype on line 21 is no node.
        { kind: "function", qualified_name: "count_jars", start_line: 24, end_line: 26, parent: file },
        { kind: "function", qualified_name: "helper", start_line: 28, end_line: 28, parent: file },
        { kind: "function", qualified_name: "stack", start_line: 30, end_line: 37, parent: file },
        // A function that returns a pointer to a function is named by its innermost declarator (6.7.6).
        { kind: "function", qualified_name: "chooser", start_line: 39, end_line: 41, parent: file },
        { kind: "function", qualified_name: "shadow", start_line: 43, end_line: 45, parent: file },
        { kind: "function", qualified_name: "hidden", start_line: 47, end_line: 50, parent: file },
        // Each conditional group's definition is a node of its own.
        { kind: "function", qualified_name: "width", start_line: 53, end_line: 53, parent: file },
        { kind: "function", qualified_name: "width", start_line: 55, end_line: 55, parent: file },
        { kind: "function", qualified_name: "measure", start_line: 57, end_line: 57, parent: file },
        { kind: "function", qualified_name: "height", start_line: 60, end_line: 60, parent: file },
        { kind: "function", qualified_name: "reach", start_line: 62, end_line: 62, parent: file },
        // A compound statement at file scope is only ever a function's body (6.9.1): a macro that
        // writes a function's head still makes a function, named by the name the parser reads in it.
        { kind: "function", qualified_name: "lid_fits", start_line: 64, end_line: 66, parent: file },
        { kind: "function", qualified_name: "probe", start_line: 68, end_line: 68, parent: file },
      ];
      expect(got).toEqual(expect.arrayContaining(want));
      expect(got).toHaveLength(want.length);
      const header = symbols(db, "a").filter((r) => r.path === "pantry/shelf.h");
      expect(header.map(({ kind, qualified_name, start_line, end_line }) => ({ kind, qualified_name, start_line, end_line }))).toEqual([
        { kind: "type", qualified_name: "shelf_info", start_line: 3, end_line: 3 },
        { kind: "function", qualified_name: "twice", start_line: 5, end_line: 5 },
      ]);
    } finally {
      db.close();
    }
  });

  test("a doc is the comment above; a static function or variable is not exported, others are", async () => {
    const db = await built();
    try {
      const rows = symbols(db, "a").filter((r) => r.path === "pantry/shelf.c");
      const of = (name: string) => rows.find((r) => r.qualified_name === name)!;
      expect(of("count_jars").doc).toBe("Counts the jars on a shelf.");
      // `static` gives internal linkage (C11 6.2.2 p3).
      expect([of("count_jars").exported, of("capacity").exported, of("chooser").exported]).toEqual([0, 0, 0]);
      expect([of("helper").exported, of("filled").exported, of("stack").exported]).toEqual([1, 1, 1]);
    } finally {
      db.close();
    }
  });
});

describe("calls", () => {
  test("a call is placed at the name it calls and belongs to the function it is written in", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "pantry/shelf.c";
      expect(callAt(rows, file, at(SHELF, "count_jars(3)")).src).toBe(`${file}:stack`);
      expect(callAt(rows, file, at(SHELF, "open(1)")).src).toBe(`${file}:stack`);
      expect(callAt(rows, file, at(SHELF, "helper()", 0)).src).toBe(`${file}:count_jars`);
      // A macro invocation reads as a call to the parser: way A leaves it not known.
      expect(callAt(rows, file, at(SHELF, "LABEL(2)")).dst_name).toBe("LABEL");
      // A pointer to a function is no call; a sizeof and a cast are none either.
      expect(rows.filter((r) => r.src === `${file}:chooser`)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("way A", () => {
  test("a call by a plain name links to the file's one definition of that name, compiled wherever the call is (C11 6.2.1, 6.2.3)", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "pantry/shelf.c";
      const link = (needle: string, nth = 0) => {
        const r = callAt(rows, file, at(SHELF, needle, nth));
        return [r.call_state, r.dst, r.dst_line];
      };
      expect(link("count_jars(3)")).toEqual(["linked", `${file}:count_jars`, 24]);
      expect(link("helper()", 0)).toEqual(["linked", `${file}:helper`, 28]);
      expect(link("count_jars(1)")).toEqual(["linked", `${file}:count_jars`, 24]);
    } finally {
      db.close();
    }
  });

  test("what the rules cannot prove is not known, never guessed", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "pantry/shelf.c";
      const state = (needle: string, nth = 0) => {
        const r = callAt(rows, file, at(SHELF, needle, nth));
        return [r.call_state, r.dst];
      };
      const notKnown = ["not_known", null];
      // A call through a field: its target is a value.
      expect(state("open(1)")).toEqual(notKnown);
      // A function the file does not define: another file or a library has it, which the file does not say.
      expect(state('printf("x")')).toEqual(notKnown);
      expect(state("label_of(1)")).toEqual(notKnown);
      // A macro (6.10.3) is no function.
      expect(state("LABEL(2)")).toEqual(notKnown);
      // A name a block declares hides the file's (6.2.1 p4).
      expect(state("pick(2)")).toEqual(notKnown);
      expect(state("helper()", 1)).toEqual(notKnown);
      // Two definitions in different conditional groups, and one compiled only under a condition the call is not under.
      expect(state("width()")).toEqual(notKnown);
      expect(state("height()")).toEqual(notKnown);
      // A function a macro writes the head of: its real name is not written.
      expect(state("lid_fits()")).toEqual(notKnown);
    } finally {
      db.close();
    }
  });
});

// A function whose head a macro's parentheses wrap, its body after them, as a macro that adds an
// attribute writes it. The macros are defined in a header the file does not show.
const BED = lines(
  '#include "bed.h"', //                                         1
  "", //                                                         2
  "QUIET(static int rows_of(int n)) {", //                       3
  "  return n * 2;", //                                          4
  "}", //                                                        5
  "", //                                                         6
  "SHARED(struct plot* first_plot(const struct bed* b)) {", //   7
  "  return b->plots;", //                                       8
  "}", //                                                        9
  "", //                                                         10
  "int sow(const struct bed* b) {", //                           11
  "  return rows_of(1) + first_plot(b)->size;", //               12
  "}", //                                                        13
);

describe("a function a macro wraps", () => {
  test("a body at file level after a macro's parentheses is the body of the function they declare (6.9.1): the function is a node, and its calls are its own", async () => {
    const db = await built({ "garden/bed.c": BED });
    try {
      const file = "garden/bed.c";
      const rows = symbols(db, "a").filter((r) => r.path === file);
      expect(rows.map(({ kind, qualified_name, start_line, end_line, exported }) => ({ kind, qualified_name, start_line, end_line, exported }))).toEqual([
        { kind: "function", qualified_name: "rows_of", start_line: 3, end_line: 5, exported: 0 },
        { kind: "function", qualified_name: "first_plot", start_line: 7, end_line: 9, exported: 1 },
        { kind: "function", qualified_name: "sow", start_line: 11, end_line: 13, exported: 1 },
      ]);
      const all = calls(db, "a");
      // The file defines each once: a call by the plain name links to it (C11 6.2.1).
      const rowsOf = callAt(all, file, at(BED, "rows_of(1)"));
      expect([rowsOf.src, rowsOf.call_state, rowsOf.dst]).toEqual([`${file}:sow`, "linked", `${file}:rows_of`]);
      const firstPlot = callAt(all, file, at(BED, "first_plot(b)"));
      expect([firstPlot.src, firstPlot.call_state, firstPlot.dst]).toEqual([`${file}:sow`, "linked", `${file}:first_plot`]);
    } finally {
      db.close();
    }
  });
});

// A call written in a macro's arguments: the macro decides what its input becomes (6.10.3).
const SEEDS = lines(
  "#define EACH(kind, act) case kind: act; break", // 1
  "static int weigh(int n) { return n; }", //          2
  "int sort_seed(int kind) {", //                      3
  "  switch (kind) {", //                              4
  "    EACH(1, weigh(kind));", //                      5
  "  }", //                                            6
  "  return weigh(0);", //                             7
  "}", //                                              8
);

describe("a call in a macro's arguments", () => {
  test("a call in the arguments of a macro the file defines is not known; the same call outside it links", async () => {
    const db = await built({ "garden/seeds.c": SEEDS });
    try {
      const file = "garden/seeds.c";
      const all = calls(db, "a");
      const state = (needle: string) => {
        const r = callAt(all, file, at(SEEDS, needle));
        return [r.src, r.call_state, r.dst];
      };
      expect(state("weigh(kind)")).toEqual([`${file}:sort_seed`, "not_known", null]);
      expect(state("weigh(0)")).toEqual([`${file}:sort_seed`, "linked", `${file}:weigh`]);
    } finally {
      db.close();
    }
  });
});
