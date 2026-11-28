// C++ in the code graph (trustmybot/tmb#355), read by its tree-sitter grammar: the nodes the page's
// "Kinds of symbol" gives C++, the place and owner of each call ("The three states of a call", "Two
// ways to make links"), and the links way A's built-in rules prove ("Links on proof"). Each
// expectation is read off the page and the C++ standard (ISO/IEC 14882:2020, by its stable names),
// call by call, not off the graph's output. The fixtures are small programs of their own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../../../../src/engine/graph/build.ts";
import { openGraphDb } from "../../../../src/engine/graph/db.ts";
import { git } from "../../../lib/git.ts";
import { commitFiles, RECORD_IGNORE } from "../../../lib/project.ts";

setDefaultTimeout(30_000);

let project: string;

/** Commits the files with the record ignored, as the first commit, and returns it. */
function commit(files: Record<string, string>): string {
  return commitFiles(project, { ".gitignore": RECORD_IGNORE, ...files });
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-cpp-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const STOVE = lines(
  "// The stove.", //                                                    1
  '#include "stove.h"', //                                               2
  "#include <vector>", //                                                3
  "", //                                                                 4
  "#define KITCHEN_API", //                                              5
  "", //                                                                 6
  "namespace kitchen {", //                                              7
  "", //                                                                 8
  "class KITCHEN_API Burner : public Part {", //                         9
  " public:", //                                                         10
  "  Burner();", //                                                      11
  "  explicit Burner(int heat);", //                                     12
  "  virtual ~Burner();", //                                             13
  "  virtual int Level() const = 0;", //                                 14
  "  int Boost() { return Level() + Step(); }", //                       15
  "  int Step();", //                                                    16
  "  Burner(const Burner&) = delete;", //                                17
  "  Burner& operator=(const Burner&) = default;", //                    18
  "  void Twice(int a);", //                                             19
  "  void Twice(double a);", //                                          20
  "  void Mix() { Twice(1); }", //                                       21
  "  using Part::Reset;", //                                             22
  "  void Clean() { Reset(); Wipe(); this->Boost(); }", //               23
  " private:", //                                                        24
  "  struct Flame { int size; };", //                                    25
  "  Flame Light() { return Flame(); }", //                              26
  "  Burner* Copy() { return new Burner(2); }", //                       27
  "  int heat_;", //                                                     28
  "};", //                                                               29
  "", //                                                                 30
  "int Burner::Step() {", //                                             31
  "  return heat_ + Level();", //                                        32
  "}", //                                                                33
  "", //                                                                 34
  "Burner::~Burner() {}", //                                             35
  "", //                                                                 36
  "template <typename T>", //                                            37
  "T Hottest(const std::vector<T>& all) {", //                           38
  "  return all.front();", //                                            39
  "}", //                                                                40
  "", //                                                                 41
  "static int Warm() { return 1; }", //                                  42
  "", //                                                                 43
  "int Cook() {", //                                                     44
  "  int n = Warm();", //                                                45
  "  n += Later();", //                                                  46
  "  n += Simmer(2);", //                                                47
  "  auto stir = [n](int k) { return k + Warm(); };", //                 48
  "  std::sort(nullptr, nullptr, [](int a, int b) { return a < b; });", // 49
  "  n += static_cast<int>(2.0) + int(3);", //                           50
  "  return n + stir(1);", //                                            51
  "}", //                                                                52
  "", //                                                                 53
  "int Later() { return 2; }", //                                        54
  "int Simmer(int x) { return x; }", //                                  55
  "", //                                                                 56
  "namespace {", //                                                      57
  "int Secret() { return 7; }", //                                       58
  "}  // namespace", //                                                  59
  "", //                                                                 60
  "}  // namespace kitchen", //                                          61
  "", //                                                                 62
  "int Pot::Fill() { return Cook(); }", //                               63
  "", //                                                                 64
  "int counter = kitchen::Cook();", //                                   65
  "", //                                                                 66
  "namespace kitchen::tools {", //                                       67
  "int depth = 3;", //                                                   68
  "void Sharpen() {}", //                                                69
  "}  // namespace kitchen::tools", //                                   70
  "", //                                                                 71
  "OVEN_TEST(Stove, Lights) {", //                                       72
  "  kitchen::tools::Sharpen();", //                                     73
  "}", //                                                                74
);

// The header the stove includes: the base class it names, and a prototype.
const STOVE_H = lines(
  "#pragma once", //                                                     1
  "namespace kitchen {", //                                              2
  "class Part {", //                                                     3
  " public:", //                                                         4
  "  void Reset();", //                                                  5
  "  void Wipe() {}", //                                                 6
  "};", //                                                               7
  "int Cook();", //                                                      8
  "}  // namespace kitchen", //                                          9
);

const FILES: Record<string, string> = {
  "kitchen/stove.cc": STOVE,
  "kitchen/stove.h": STOVE_H,
};

type SymbolRow = { path: string; kind: string; qualified_name: string; start_line: number; end_line: number; parent: string | null; unnamed: number; doc: string; exported: number };

function symbols(db: Database, layer: string): SymbolRow[] {
  return db
    .query(
      `SELECT s.path, s.kind, s.qualified_name, s.start_line, s.end_line, p.qualified_name AS parent, s.unnamed, s.doc, s.exported
         FROM symbols s LEFT JOIN symbols p ON p.id = s.parent_id
        WHERE s.layer = ? AND s.kind != 'file'`,
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

describe("nodes", () => {
  test("namespaces and classes are types; members are named through them; a declaration with no body is no node, a pure virtual, deleted or defaulted one is", async () => {
    const db = await built();
    try {
      const file = "kitchen/stove.cc";
      const rows = symbols(db, "a").filter((r) => r.path === file && r.unnamed === 0);
      const got = rows.map(({ kind, qualified_name, start_line, end_line, parent }) => ({ kind, qualified_name, start_line, end_line, parent }));
      const want = [
        // A namespace is a type-like container (CODE_GRAPH.md, "Kinds of symbol").
        { kind: "type", qualified_name: "kitchen", start_line: 7, end_line: 61, parent: file },
        // A class head has one class name ([class.pre]): a macro written before it, as an export
        // macro, leaves the class its own name.
        { kind: "type", qualified_name: "kitchen.Burner", start_line: 9, end_line: 29, parent: "kitchen" },
        // A pure virtual function is a method with only a declaration, and a node ([class.abstract]).
        { kind: "method", qualified_name: "kitchen.Burner.Level", start_line: 14, end_line: 14, parent: "kitchen.Burner" },
        { kind: "method", qualified_name: "kitchen.Burner.Boost", start_line: 15, end_line: 15, parent: "kitchen.Burner" },
        // A deleted and a defaulted function are definitions ([dcl.fct.def.delete], [dcl.fct.def.default]).
        { kind: "method", qualified_name: "kitchen.Burner.Burner", start_line: 17, end_line: 17, parent: "kitchen.Burner" },
        { kind: "method", qualified_name: "kitchen.Burner.operator=", start_line: 18, end_line: 18, parent: "kitchen.Burner" },
        { kind: "method", qualified_name: "kitchen.Burner.Mix", start_line: 21, end_line: 21, parent: "kitchen.Burner" },
        { kind: "method", qualified_name: "kitchen.Burner.Clean", start_line: 23, end_line: 23, parent: "kitchen.Burner" },
        { kind: "type", qualified_name: "kitchen.Burner.Flame", start_line: 25, end_line: 25, parent: "kitchen.Burner" },
        { kind: "method", qualified_name: "kitchen.Burner.Light", start_line: 26, end_line: 26, parent: "kitchen.Burner" },
        { kind: "method", qualified_name: "kitchen.Burner.Copy", start_line: 27, end_line: 27, parent: "kitchen.Burner" },
        // A member defined outside its class is named through it and held by it when the file defines the class.
        { kind: "method", qualified_name: "kitchen.Burner.Step", start_line: 31, end_line: 33, parent: "kitchen.Burner" },
        { kind: "method", qualified_name: "kitchen.Burner.~Burner", start_line: 35, end_line: 35, parent: "kitchen.Burner" },
        // A template's lines start at its `template` head ([temp.pre]).
        { kind: "function", qualified_name: "kitchen.Hottest", start_line: 37, end_line: 40, parent: "kitchen" },
        { kind: "function", qualified_name: "kitchen.Warm", start_line: 42, end_line: 42, parent: "kitchen" },
        { kind: "function", qualified_name: "kitchen.Cook", start_line: 44, end_line: 52, parent: "kitchen" },
        { kind: "function", qualified_name: "kitchen.Later", start_line: 54, end_line: 54, parent: "kitchen" },
        { kind: "function", qualified_name: "kitchen.Simmer", start_line: 55, end_line: 55, parent: "kitchen" },
        // An unnamed namespace adds no name ([namespace.unnamed]).
        { kind: "function", qualified_name: "kitchen.Secret", start_line: 58, end_line: 58, parent: "kitchen" },
        // A member of a class the file does not define is held by the file (CODE_GRAPH.md, "Kinds of symbol", edge case 3).
        { kind: "method", qualified_name: "Pot.Fill", start_line: 63, end_line: 63, parent: file },
        // A variable of the global namespace is file-level data.
        { kind: "file_level_data", qualified_name: "counter", start_line: 65, end_line: 65, parent: file },
        // A nested namespace definition names each namespace it opens ([namespace.def]).
        { kind: "type", qualified_name: "kitchen.tools", start_line: 67, end_line: 70, parent: file },
        { kind: "function", qualified_name: "kitchen.tools.Sharpen", start_line: 69, end_line: 69, parent: "kitchen.tools" },
        // A macro that writes a function's head still makes a function: named by the name the parser reads.
        { kind: "function", qualified_name: "OVEN_TEST", start_line: 72, end_line: 74, parent: file },
      ];
      expect(got).toEqual(expect.arrayContaining(want));
      // No other node: no constructor or member with only a declaration (lines 11, 12, 13, 16, 19,
      // 20), no data member, and no variable of a named namespace, which is a field (line 68).
      expect(got).toHaveLength(want.length);
      const header = symbols(db, "a").filter((r) => r.path === "kitchen/stove.h");
      expect(header.map(({ kind, qualified_name }) => ({ kind, qualified_name }))).toEqual(
        expect.arrayContaining([
          { kind: "type", qualified_name: "kitchen" },
          { kind: "type", qualified_name: "kitchen.Part" },
          { kind: "method", qualified_name: "kitchen.Part.Wipe" },
        ]),
      );
      expect(header).toHaveLength(3);
      // A lambda is an unnamed function, held and owned by the function it is written in.
      const unnamed = symbols(db, "a").filter((r) => r.path === file && r.unnamed === 1);
      expect(unnamed.map(({ kind, qualified_name, start_line, parent }) => ({ kind, qualified_name, start_line, parent }))).toEqual([
        { kind: "function", qualified_name: "function at line 48", start_line: 48, parent: "kitchen.Cook" },
        { kind: "function", qualified_name: "callback of `sort`", start_line: 49, parent: "kitchen.Cook" },
      ]);
    } finally {
      db.close();
    }
  });

  test("a member is exported when it is public; a name of an unnamed namespace, and a static function, are not", async () => {
    const db = await built();
    try {
      const rows = symbols(db, "a").filter((r) => r.path === "kitchen/stove.cc");
      const of = (name: string) => rows.find((r) => r.qualified_name === name)!;
      expect([of("kitchen.Burner").exported, of("kitchen.Burner.Boost").exported, of("kitchen.Cook").exported]).toEqual([1, 1, 1]);
      // `private:` ([class.access.spec]), `static` ([basic.link] p3) and an unnamed namespace ([basic.link] p4).
      expect([of("kitchen.Burner.Light").exported, of("kitchen.Burner.Flame").exported, of("kitchen.Warm").exported, of("kitchen.Secret").exported]).toEqual([0, 0, 0, 0]);
    } finally {
      db.close();
    }
  });
});

describe("calls", () => {
  test("a call is placed at the name it calls, a construction with `new` at its type's; a cast is no call", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "kitchen/stove.cc";
      expect(callAt(rows, file, at(STOVE, "Burner(2)")).dst_name).toBe("Burner");
      expect(callAt(rows, file, at(STOVE, "Sharpen();")).dst_name).toBe("Sharpen");
      expect(callAt(rows, file, at(STOVE, "Boost();")).dst_name).toBe("Boost");
      // `static_cast<int>(2.0)` and `int(3)` are conversions to a built-in type, not calls ([expr.static.cast], [expr.type.conv]).
      expect(rows.filter((r) => r.line === 50)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a call belongs to the function it is written in; in a lambda, to the lambda; in a variable's value, to the variable", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "kitchen/stove.cc";
      expect(callAt(rows, file, at(STOVE, "Level() +")).src).toBe(`${file}:kitchen.Burner.Boost`);
      expect(callAt(rows, file, at(STOVE, "Warm();", 1)).src).toBe(`${file}:function at line 48`);
      expect(callAt(rows, file, at(STOVE, "sort(")).src).toBe(`${file}:kitchen.Cook`);
      expect(callAt(rows, file, at(STOVE, "Cook();", 1)).src).toBe(`${file}:counter`);
      expect(callAt(rows, file, at(STOVE, "Sharpen();")).src).toBe(`${file}:OVEN_TEST`);
    } finally {
      db.close();
    }
  });
});

describe("way A", () => {
  test("in a member function, a name the class declares as one member function links to that member's node ([class.member.lookup])", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "kitchen/stove.cc";
      const link = (needle: string, nth = 0) => {
        const r = callAt(rows, file, at(STOVE, needle, nth));
        return [r.call_state, r.dst, r.dst_line];
      };
      // A pure virtual function is the target of a call through its class.
      expect(link("Level() +")).toEqual(["linked", `${file}:kitchen.Burner.Level`, 14]);
      // A member declared in the class and defined outside it: the definition.
      expect(link("Step()", 0)).toEqual(["linked", `${file}:kitchen.Burner.Step`, 31]);
      // `this->m()` is the same lookup.
      expect(link("Boost();")).toEqual(["linked", `${file}:kitchen.Burner.Boost`, 15]);
      // In a member defined outside its class, the class's scope is searched too ([basic.lookup.unqual] p8).
      expect(link("Level();")).toEqual(["linked", `${file}:kitchen.Burner.Level`, 14]);
    } finally {
      db.close();
    }
  });

  test("in a member function, the class's own name and a member class's name are the class: a construction links to it", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "kitchen/stove.cc";
      const link = (needle: string) => {
        const r = callAt(rows, file, at(STOVE, needle));
        return [r.call_state, r.dst];
      };
      expect(link("Flame()")).toEqual(["linked", `${file}:kitchen.Burner.Flame`]);
      expect(link("Burner(2)")).toEqual(["linked", `${file}:kitchen.Burner`]);
    } finally {
      db.close();
    }
  });

  test("outside a class, `f()` with no arguments links when the file declares `f` before it and defines one `f` in the same namespace ([basic.lookup.unqual], [basic.lookup.argdep])", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "kitchen/stove.cc";
      const link = (needle: string, nth = 0) => {
        const r = callAt(rows, file, at(STOVE, needle, nth));
        return [r.call_state, r.dst];
      };
      expect(link("Warm();", 0)).toEqual(["linked", `${file}:kitchen.Warm`]);
      // In a lambda of that function, the same lookup.
      expect(link("Warm();", 1)).toEqual(["linked", `${file}:kitchen.Warm`]);
    } finally {
      db.close();
    }
  });

  test("what the rules cannot prove is not known, never guessed", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "kitchen/stove.cc";
      const state = (needle: string, nth = 0) => {
        const r = callAt(rows, file, at(STOVE, needle, nth));
        return [r.call_state, r.dst];
      };
      const notKnown = ["not_known", null];
      // Overloads: the arguments' types choose ([over.match]).
      expect(state("Twice(1)")).toEqual(notKnown);
      // A using-declaration brings a base's members in ([namespace.udecl]); a name the class does not declare is a base's, in another file.
      expect(state("Reset()")).toEqual(notKnown);
      expect(state("Wipe()")).toEqual(notKnown);
      // A call through a value.
      expect(state("front()")).toEqual(notKnown);
      // Declared only after the call, so lookup there finds another declaration.
      expect(state("Later()")).toEqual(notKnown);
      // With arguments, argument-dependent lookup searches other namespaces too ([basic.lookup.argdep]).
      expect(state("Simmer(2)")).toEqual(notKnown);
      // A local variable, a qualified name and a library's function.
      expect(state("stir(1)")).toEqual(notKnown);
      expect(state("Cook();", 1)).toEqual(notKnown);
      expect(state("Sharpen();")).toEqual(notKnown);
      expect(state("sort(")).toEqual(notKnown);
      // In a member of a class the file does not define, the class's members are not in the file.
      expect(state("Cook();", 0)).toEqual(notKnown);
    } finally {
      db.close();
    }
  });
});

// A function whose head a macro's parentheses wrap, its body after them. The macros are defined in a
// header the file does not show.
const HEDGE = lines(
  '#include "hedge.h"', //                  1
  "", //                                    2
  "QUIET(static int trim(int n)) {", //     3
  "  return n - 1;", //                     4
  "}", //                                   5
  "", //                                    6
  "namespace garden {", //                  7
  "SHARED(int prune(int n)) {", //          8
  "  return trim(n);", //                   9
  "}", //                                   10
  "}", //                                   11
);

describe("a function a macro wraps", () => {
  test("a body after a macro's parentheses, with no return type before them, is the body of the function they declare ([dcl.fct.def.general]): the function is a node, and its calls are its own", async () => {
    const db = await built({ "garden/hedge.cc": HEDGE });
    try {
      const file = "garden/hedge.cc";
      const rows = symbols(db, "a").filter((r) => r.path === file);
      expect(rows.map(({ kind, qualified_name, start_line, end_line, parent }) => ({ kind, qualified_name, start_line, end_line, parent }))).toEqual(
        expect.arrayContaining([
          { kind: "function", qualified_name: "trim", start_line: 3, end_line: 5, parent: file },
          { kind: "type", qualified_name: "garden", start_line: 7, end_line: 11, parent: file },
          { kind: "function", qualified_name: "garden.prune", start_line: 8, end_line: 10, parent: "garden" },
        ]),
      );
      expect(rows).toHaveLength(3);
      expect(callAt(calls(db, "a"), file, at(HEDGE, "trim(n)")).src).toBe(`${file}:garden.prune`);
    } finally {
      db.close();
    }
  });
});

// A member class with a macro in its head, and functions with a macro after their declarator, as an
// annotation macro writes it. The macros are defined in a header the file does not show.
const SHED = lines(
  "namespace garden {", //                       1
  "class Shed {", //                             2
  " public:", //                                 3
  "  class TOOLS_API Rack {", //                  4
  "   public:", //                               5
  "    virtual ~Rack();", //                     6
  "    virtual void Hang(const char* tool) = 0;", // 7
  "  };", //                                     8
  "  int Count(int n) const", //                 9
  "      GUARDED_BY_LOCK(lock_) {", //           10
  "    return n;", //                            11
  "  }", //                                      12
  "};", //                                       13
  "int Total(int n) HOLDS(lock) {", //           14
  "  return n;", //                              15
  "}", //                                        16
  "}", //                                        17
);

describe("macros around a head", () => {
  test("a member class's head has one class name too; a word after a function's declarator and before its body is no function of its own ([class.pre], [dcl.fct.def.general])", async () => {
    const db = await built({ "garden/shed.cc": SHED });
    try {
      const file = "garden/shed.cc";
      const rows = symbols(db, "a").filter((r) => r.path === file);
      expect(rows.map(({ kind, qualified_name, start_line, end_line, parent }) => ({ kind, qualified_name, start_line, end_line, parent }))).toEqual(
        expect.arrayContaining([
          { kind: "type", qualified_name: "garden", start_line: 1, end_line: 17, parent: file },
          { kind: "type", qualified_name: "garden.Shed", start_line: 2, end_line: 13, parent: "garden" },
          { kind: "type", qualified_name: "garden.Shed.Rack", start_line: 4, end_line: 8, parent: "garden.Shed" },
          { kind: "method", qualified_name: "garden.Shed.Rack.Hang", start_line: 7, end_line: 7, parent: "garden.Shed.Rack" },
          { kind: "method", qualified_name: "garden.Shed.Count", start_line: 9, end_line: 12, parent: "garden.Shed" },
          { kind: "function", qualified_name: "garden.Total", start_line: 14, end_line: 16, parent: "garden" },
        ]),
      );
      expect(rows).toHaveLength(6);
    } finally {
      db.close();
    }
  });
});

// `new T*[n]` and `new T*()` make pointers to T, and a pointer has no constructor ([expr.new]: the
// object made is of the new-type-id's type, here a pointer); `new T[n]` and `new T()` make T's, so
// they are constructions of T.
const PANTRY = lines(
  "namespace pantry {", //                                     1
  "class Jar {", //                                            2
  " public:", //                                               3
  "  Jar() {}", //                                             4
  "  Jar** Shelf(int n) { return new Jar*[n]; }", //           5
  "  Jar** Slot() { return new Jar*(); }", //                  6
  "  Jar* Row(int n) { return new Jar[n]; }", //               7
  "  Jar* One() { return new Jar(); }", //                     8
  "};", //                                                     9
  "}  // namespace pantry", //                                 10
);

describe("a new pointer", () => {
  test("`new T*[n]` and `new T*()` make pointers, which have no constructor: no call; `new T[n]` and `new T()` construct T ([expr.new])", async () => {
    const db = await built({ "pantry/jar.cc": PANTRY });
    try {
      const rows = calls(db, "a").filter((r) => r.src.startsWith("pantry/jar.cc:"));
      expect(rows.filter((r) => r.line === 5 || r.line === 6)).toEqual([]);
      expect(rows.filter((r) => r.line === 7 || r.line === 8).map(({ line, dst_name, dst }) => ({ line, dst_name, dst }))).toEqual([
        { line: 7, dst_name: "Jar", dst: "pantry/jar.cc:pantry.Jar" },
        { line: 8, dst_name: "Jar", dst: "pantry/jar.cc:pantry.Jar" },
      ]);
    } finally {
      db.close();
    }
  });
});

// A lambda bound to a file-level name is the function of that name, as in every language: the
// variable `Steep` holds the closure and nothing else, so its lines are the function's. A lambda
// elsewhere stays an unnamed function.
const KETTLE = lines(
  "int Pour(int n) { return n; }", //                           1
  "auto Steep = [](int n) {", //                               2
  "  return Pour(n);", //                                      3
  "};", //                                                     4
  "static auto Boil = [] { return Pour(1); };", //             5
  "int Brew() {", //                                           6
  "  auto cup = [] { return 2; };", //                         7
  "  return Steep(2) + Boil() + cup();", //                    8
  "}", //                                                      9
);

describe("a lambda bound to a file-level name", () => {
  test("`auto f = [] {…}` at file level is the function `f`, its calls are `f`'s; a lambda in a function stays unnamed", async () => {
    const db = await built({ "tea/kettle.cc": KETTLE });
    try {
      const rows = symbols(db, "a").filter((r) => r.path === "tea/kettle.cc");
      expect(rows.map(({ kind, qualified_name, start_line, end_line, unnamed, exported }) => ({ kind, qualified_name, start_line, end_line, unnamed, exported }))).toEqual(
        expect.arrayContaining([
          { kind: "function", qualified_name: "Steep", start_line: 2, end_line: 4, unnamed: 0, exported: 1 },
          { kind: "function", qualified_name: "Boil", start_line: 5, end_line: 5, unnamed: 0, exported: 0 },
          { kind: "function", qualified_name: "function at line 7", start_line: 7, end_line: 7, unnamed: 1, exported: 0 },
        ]),
      );
      expect(rows).toHaveLength(5);
      const all = calls(db, "a");
      expect(callAt(all, "tea/kettle.cc", at(KETTLE, "Pour(n)")).src).toBe("tea/kettle.cc:Steep");
      expect(callAt(all, "tea/kettle.cc", at(KETTLE, "Pour(1)")).src).toBe("tea/kettle.cc:Boil");
    } finally {
      db.close();
    }
  });
});

// A conditional directive is processed before the code is parsed ([cpp.pre], [cpp.cond]): the
// compiler reads one group of each conditional, and the directive may stand between any two tokens,
// here inside a constructor's member initializer list. Way A reads the constructor with the
// conditional's first group, and the members after it are read as they are.
const LADDER = lines(
  "namespace orchard {", //                             1
  "class Ladder {", //                                  2
  " public:", //                                        3
  "  explicit Ladder(int rungs)", //                    4
  "      :", //                                        5
  "#if defined(SAFETY_CHECKS)", //                      6
  "        checked_(true),", //                         7
  "#else", //                                           8
  "        checked_(false),", //                        9
  "#endif", //                                          10
  "        rungs_(rungs), height_(rungs * 2) {}", //    11
  "  int Rungs() const { return rungs_; }", //          12
  "  int Height() const { return Climb(height_); }", // 13
  "  int Climb(int h) const;", //                       14
  "", //                                                15
  " private:", //                                       16
  "  int rungs_;", //                                   17
  "  bool checked_;", //                                18
  "  int height_;", //                                  19
  "};", //                                              20
  "", //                                                21
  "int Ladder::Climb(int h) const { return h; }", //    22
  "}  // namespace orchard", //                         23
);

describe("a conditional inside a construct", () => {
  test("a member initializer list a conditional cuts is read with the conditional's first group ([cpp.cond]); the members after it are nodes of the class, and their calls link", async () => {
    const db = await built({ "orchard/ladder.cc": LADDER });
    try {
      const file = "orchard/ladder.cc";
      const rows = symbols(db, "a").filter((r) => r.path === file);
      expect(rows.map(({ kind, qualified_name, start_line, end_line, parent }) => ({ kind, qualified_name, start_line, end_line, parent }))).toEqual(
        expect.arrayContaining([
          { kind: "type", qualified_name: "orchard", start_line: 1, end_line: 23, parent: file },
          { kind: "type", qualified_name: "orchard.Ladder", start_line: 2, end_line: 20, parent: "orchard" },
          { kind: "method", qualified_name: "orchard.Ladder.Ladder", start_line: 4, end_line: 11, parent: "orchard.Ladder" },
          { kind: "method", qualified_name: "orchard.Ladder.Rungs", start_line: 12, end_line: 12, parent: "orchard.Ladder" },
          { kind: "method", qualified_name: "orchard.Ladder.Height", start_line: 13, end_line: 13, parent: "orchard.Ladder" },
          { kind: "method", qualified_name: "orchard.Ladder.Climb", start_line: 22, end_line: 22, parent: "orchard.Ladder" },
        ]),
      );
      expect(rows).toHaveLength(6);
      const r = callAt(calls(db, "a"), file, at(LADDER, "Climb(height_)"));
      expect([r.src, r.call_state, r.dst]).toEqual([`${file}:orchard.Ladder.Height`, "linked", `${file}:orchard.Ladder.Climb`]);
    } finally {
      db.close();
    }
  });
});
