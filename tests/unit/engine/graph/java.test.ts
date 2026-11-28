// Java in the code graph (trustmybot/tmb#353), read by its tree-sitter grammar: the nodes the page's
// "Kinds of symbol" gives Java, the place and owner of each call ("The three states of a call", "Two
// ways to make links"), and the links and states way A's built-in rules prove ("Links on proof").
// Each expectation is read off the page and the Java Language Specification (Java SE 21), call by
// call, not off the graph's output. The fixtures are small programs of their own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../../../../src/engine/graph/build.ts";
import { openGraphDb } from "../../../../src/engine/graph/db.ts";
import { BUILTINS_FILE, builtinsText, javaBuiltins } from "../../../../src/engine/graph/languages/java/builtins.gen.ts";
import { BUILTINS_JAVA_VERSION } from "../../../../src/engine/graph/languages/java/builtins.ts";
import { javaReference } from "../../../benchmark/java.ts";
import { git } from "../../../lib/git.ts";
import { commitFiles, RECORD_IGNORE } from "../../../lib/project.ts";

setDefaultTimeout(30_000);

let project: string;

/** Commits the files with the record ignored, as the first commit, and returns it. */
function commit(files: Record<string, string>): string {
  return commitFiles(project, { ".gitignore": RECORD_IGNORE, ...files });
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-java-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const BED = lines(
  "package garden;", //                                                  1
  "", //                                                                 2
  "import java.util.List;", //                                           3
  "", //                                                                 4
  "/** A bed of plants. */", //                                          5
  "public class Bed {", //                                               6
  "  private final int rows = count();", //                              7
  "  static {", //                                                       8
  "    warm();", //                                                      9
  "  }", //                                                              10
  "", //                                                                 11
  "  /** Makes one row. */", //                                          12
  "  public Bed() {", //                                                 13
  "    this(1);", //                                                     14
  "  }", //                                                              15
  "", //                                                                 16
  "  Bed(int n) {", //                                                   17
  "    super();", //                                                     18
  "  }", //                                                              19
  "", //                                                                 20
  "  @Deprecated", //                                                    21
  "  static int count() {", //                                           22
  "    return 2;", //                                                    23
  "  }", //                                                              24
  "", //                                                                 25
  "  private static void warm() {}", //                                  26
  "", //                                                                 27
  "  int water(List<String> names) {", //                                28
  "    names.forEach(n -> soak(n));", //                                 29
  "    return count() + new Seed().grow() + toString().length();", //   30
  "  }", //                                                              31
  "", //                                                                 32
  "  void soak(String n) {}", //                                         33
  "", //                                                                 34
  "  void soak(int n) {}", //                                            35
  "", //                                                                 36
  "  void both() {", //                                                  37
  "    soak(1);", //                                                     38
  "  }", //                                                              39
  "", //                                                                 40
  "  class Seed {", //                                                   41
  "    int grow() {", //                                                 42
  "      return count() + sprout() + this.sprout();", //                 43
  "    }", //                                                            44
  "", //                                                                 45
  "    int sprout() {", //                                               46
  "      return new StringBuilder().length();", //                       47
  "    }", //                                                            48
  "  }", //                                                              49
  "", //                                                                 50
  "  interface Tool {", //                                               51
  "    int use();", //                                                   52
  "", //                                                                 53
  "    default int twice() {", //                                        54
  "      return use() + use();", //                                      55
  "    }", //                                                            56
  "  }", //                                                              57
  "", //                                                                 58
  "  enum Season {", //                                                  59
  "    SPRING(1),", //                                                   60
  "    FALL(2) {", //                                                    61
  "      int heat() {", //                                               62
  "        return 0;", //                                                63
  "      }", //                                                          64
  "    };", //                                                           65
  "", //                                                                 66
  "    Season(int h) {}", //                                             67
  "", //                                                                 68
  "    int heat() {", //                                                 69
  "      return ordinal();", //                                          70
  "    }", //                                                            71
  "", //                                                                 72
  "    static Season first() {", //                                      73
  "      return values()[0];", //                                        74
  "    }", //                                                            75
  "  }", //                                                              76
  "", //                                                                 77
  "  record Plot(int width) {", //                                       78
  "    Plot {", //                                                       79
  "      check();", //                                                   80
  "    }", //                                                            81
  "", //                                                                 82
  "    static void check() {}", //                                       83
  "", //                                                                 84
  "    int area() {", //                                                 85
  "      return width() * 2;", //                                        86
  "    }", //                                                            87
  "  }", //                                                              88
  "", //                                                                 89
  "  @interface Mark {", //                                              90
  "    int level() default 1;", //                                       91
  "  }", //                                                              92
  "", //                                                                 93
  "  Runnable later() {", //                                             94
  "    class Helper {", //                                               95
  "      void help() {", //                                              96
  "        warm();", //                                                  97
  "      }", //                                                          98
  "    }", //                                                            99
  "    return new Runnable() {", //                                      100
  "      public void run() {", //                                        101
  "        new Helper().help();", //                                     102
  "      }", //                                                          103
  "    };", //                                                           104
  "  }", //                                                              105
  "}", //                                                                106
);

const SHED = lines(
  "package garden;", //                                                  1
  "", //                                                                 2
  "import static java.lang.Math.max;", //                                3
  "import garden.tools.Rake;", //                                        4
  "", //                                                                 5
  "class Shed extends Bed {", //                                         6
  "  Shed() {", //                                                       7
  "    super();", //                                                     8
  "  }", //                                                              9
  "", //                                                                 10
  "  int store() {", //                                                  11
  "    return count() + max(1, 2) + toString().length();", //           12
  "  }", //                                                              13
  "}", //                                                                14
  "", //                                                                 15
  "class Lock {", //                                                     16
  "  Lock() {", //                                                       17
  "    super();", //                                                     18
  "  }", //                                                              19
  "", //                                                                 20
  "  Object open() {", //                                                21
  "    return new Thread();", //                                         22
  "  }", //                                                              23
  "", //                                                                 24
  "  Object rake() {", //                                                25
  "    return new Rake();", //                                           26
  "  }", //                                                              27
  "", //                                                                 28
  "  int size(String s, Object Byte) {", //                              29
  "    return String.valueOf(s).length() + Math.abs(-1) + Byte.hashCode();", // 30
  "  }", //                                                              31
  "}", //                                                                32
  "", //                                                                 33
  "class Base {}", //                                                    34
  "", //                                                                 35
  "class Derived extends Base {", //                                     36
  "  Derived() {", //                                                    37
  "    super();", //                                                     38
  "  }", //                                                              39
  "", //                                                                 40
  "  Base again() {", //                                                 41
  "    return new Derived();", //                                        42
  "  }", //                                                              43
  "}", //                                                                44
);

const FILES: Record<string, string> = {
  "garden/Bed.java": BED,
  "garden/Shed.java": SHED,
  // A type of the package with a name `java.lang` declares too: the package's own type hides it (JLS 6.4.1).
  "garden/Thread.java": lines("package garden;", "", "class Thread {}"),
  "garden/tools/Rake.java": lines("package garden.tools;", "", "public class Rake {}"),
  "garden/Refs.java": lines("package garden;", "", "class Refs {", "  Runnable make() {", "    return Refs::new;", "  }", "}"),
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

describe("nodes", () => {
  test("each type, method, constructor and annotation element is a node, held by its type and named through it", async () => {
    const db = await built();
    try {
      const file = "garden/Bed.java";
      const rows = symbols(db, "a").filter((r) => r.path === file);
      const named = rows.filter((r) => r.unnamed === 0).map(({ kind, qualified_name, start_line, end_line, parent }) => ({ kind, qualified_name, start_line, end_line, parent }));
      const want = [
        // A class (JLS 8.1) is a type; its lines start at its first modifier, not at its doc comment.
        { kind: "type", qualified_name: "Bed", start_line: 6, end_line: 106, parent: file },
        // A constructor (8.8) is a method named by its class; two constructors are two nodes.
        { kind: "method", qualified_name: "Bed.Bed", start_line: 13, end_line: 15, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.Bed", start_line: 17, end_line: 19, parent: "Bed" },
        // A method's lines start at its first annotation (8.4).
        { kind: "method", qualified_name: "Bed.count", start_line: 21, end_line: 24, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.warm", start_line: 26, end_line: 26, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.water", start_line: 28, end_line: 31, parent: "Bed" },
        // Overloads (8.4.9) are each a node.
        { kind: "method", qualified_name: "Bed.soak", start_line: 33, end_line: 33, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.soak", start_line: 35, end_line: 35, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.both", start_line: 37, end_line: 39, parent: "Bed" },
        // A member class (8.5) is a type inside its type, named through it.
        { kind: "type", qualified_name: "Bed.Seed", start_line: 41, end_line: 49, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.Seed.grow", start_line: 42, end_line: 44, parent: "Bed.Seed" },
        { kind: "method", qualified_name: "Bed.Seed.sprout", start_line: 46, end_line: 48, parent: "Bed.Seed" },
        // An interface (9.1) is a type; its method with no body is a node (9.4).
        { kind: "type", qualified_name: "Bed.Tool", start_line: 51, end_line: 57, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.Tool.use", start_line: 52, end_line: 52, parent: "Bed.Tool" },
        { kind: "method", qualified_name: "Bed.Tool.twice", start_line: 54, end_line: 56, parent: "Bed.Tool" },
        // An enum (8.9) is a class; its constructor is a method.
        { kind: "type", qualified_name: "Bed.Season", start_line: 59, end_line: 76, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.Season.Season", start_line: 67, end_line: 67, parent: "Bed.Season" },
        { kind: "method", qualified_name: "Bed.Season.heat", start_line: 69, end_line: 71, parent: "Bed.Season" },
        { kind: "method", qualified_name: "Bed.Season.first", start_line: 73, end_line: 75, parent: "Bed.Season" },
        // A record (8.10) is a class; its compact constructor (8.10.4) is a method named by it.
        { kind: "type", qualified_name: "Bed.Plot", start_line: 78, end_line: 88, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.Plot.Plot", start_line: 79, end_line: 81, parent: "Bed.Plot" },
        { kind: "method", qualified_name: "Bed.Plot.check", start_line: 83, end_line: 83, parent: "Bed.Plot" },
        { kind: "method", qualified_name: "Bed.Plot.area", start_line: 85, end_line: 87, parent: "Bed.Plot" },
        // An annotation interface (9.6) is an interface; its element is a method (9.6.1).
        { kind: "type", qualified_name: "Bed.Mark", start_line: 90, end_line: 92, parent: "Bed" },
        { kind: "method", qualified_name: "Bed.Mark.level", start_line: 91, end_line: 91, parent: "Bed.Mark" },
        { kind: "method", qualified_name: "Bed.later", start_line: 94, end_line: 105, parent: "Bed" },
        // A local class (14.3) is a named type inside its method, named by itself.
        { kind: "type", qualified_name: "Helper", start_line: 95, end_line: 99, parent: "Bed.later" },
        { kind: "method", qualified_name: "Helper.help", start_line: 96, end_line: 98, parent: "Helper" },
        // A method of an anonymous class body (15.9.5), an enum constant's included (8.9.1), is a method
        // of a type with no name: no type node holds it, so it is held by the node around it.
        { kind: "method", qualified_name: "heat", start_line: 62, end_line: 64, parent: "Bed.Season" },
        { kind: "method", qualified_name: "run", start_line: 101, end_line: 103, parent: "Bed.later" },
      ];
      expect(named).toEqual(expect.arrayContaining(want));
      // Nothing else is a node: no field, enum constant, record component, parameter or local.
      expect(named).toHaveLength(want.length);
      for (const local of ["rows", "SPRING", "FALL", "width", "names", "n"]) expect(rows.map((r) => r.qualified_name)).not.toContain(local);
      // A lambda (15.27) is an unnamed function, held and owned by the method it is written in.
      const unnamed = rows.filter((r) => r.unnamed === 1);
      expect(unnamed.map(({ kind, qualified_name, start_line, end_line, parent, owner }) => ({ kind, qualified_name, start_line, end_line, parent, owner }))).toEqual([
        { kind: "function", qualified_name: "callback of `forEach`", start_line: 29, end_line: 29, parent: "Bed.water", owner: "Bed.water" },
      ]);
    } finally {
      db.close();
    }
  });

  test("a declaration's doc is the Javadoc comment above it, and it is exported when it is public, as every member of an interface is", async () => {
    const db = await built();
    try {
      const rows = symbols(db, "a").filter((r) => r.path === "garden/Bed.java");
      const of = (name: string, line?: number) => rows.find((r) => r.qualified_name === name && (line === undefined || r.start_line === line))!;
      expect(of("Bed").doc).toBe("A bed of plants.");
      expect(of("Bed.Bed", 13).doc).toBe("Makes one row.");
      // `public` (6.6.1), and a member of an interface, which is public unless it is private (9.4, 9.6.1).
      expect([of("Bed").exported, of("Bed.Bed", 13).exported, of("Bed.Tool.use").exported, of("Bed.Mark.level").exported, of("run").exported]).toEqual([1, 1, 1, 1, 1]);
      expect([of("Bed.Bed", 17).exported, of("Bed.count").exported, of("Bed.warm").exported, of("Bed.Seed").exported, of("Helper").exported]).toEqual([0, 0, 0, 0, 0]);
    } finally {
      db.close();
    }
  });
});

describe("calls", () => {
  test("a call is placed where its called name is written: a method's name, a created class's name, `this` or `super`", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "garden/Bed.java";
      expect(callAt(rows, file, at(BED, "this(1)")).dst_name).toBe("this");
      expect(callAt(rows, file, at(BED, "super()")).dst_name).toBe("super");
      expect(callAt(rows, file, at(BED, "Seed()")).dst_name).toBe("Seed");
      expect(callAt(rows, file, at(BED, "grow()", 0)).dst_name).toBe("grow");
      // Two calls of one name on one line are two.
      expect(callAt(rows, file, at(BED, "use()", 1)).line).toBe(55);
      expect(callAt(rows, file, at(BED, "use()", 2)).line).toBe(55);
      // An enum constant's arguments make no call of its own (8.9.1): line 60 and 61 hold none.
      expect(rows.filter((r) => r.src.startsWith(`${file}:`) && (r.line === 60 || r.line === 61))).toEqual([]);
      // A method reference names a method and calls none (15.13).
      expect(rows.filter((r) => r.src.startsWith("garden/Refs.java:"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a call belongs to the nearest callable; in a field's value or an initializer, to the type; in a lambda, to the lambda", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "garden/Bed.java";
      expect(callAt(rows, file, at(BED, "count()", 0)).src).toBe(`${file}:Bed`);
      expect(callAt(rows, file, at(BED, "warm()", 0)).src).toBe(`${file}:Bed`);
      const inLambda = callAt(rows, file, at(BED, "soak(n)"));
      expect([inLambda.src, inLambda.src_unnamed]).toEqual([`${file}:callback of \`forEach\``, 1]);
      expect(callAt(rows, file, at(BED, "warm()", 2)).src).toBe(`${file}:Helper.help`);
      expect(callAt(rows, file, at(BED, "Helper()")).src).toBe(`${file}:run`);
      expect(callAt(rows, file, at(BED, "Runnable()")).src).toBe(`${file}:Bed.later`);
    } finally {
      db.close();
    }
  });
});

describe("way A", () => {
  test("a bare method name links to the one method of that name in the innermost type around it that has a member of that name (JLS 15.12.1)", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "garden/Bed.java";
      const link = (needle: string, nth = 0) => {
        const r = callAt(rows, file, at(BED, needle, nth));
        return [r.call_state, r.dst, r.dst_line];
      };
      expect(link("count()", 0)).toEqual(["linked", `${file}:Bed.count`, 21]);
      expect(link("warm()", 0)).toEqual(["linked", `${file}:Bed.warm`, 26]);
      expect(link("count()", 2)).toEqual(["linked", `${file}:Bed.count`, 21]);
      // From a member class, the walk goes out to the class around it when the member class has no such member.
      expect(link("count()", 3)).toEqual(["linked", `${file}:Bed.count`, 21]);
      expect(link("sprout()", 0)).toEqual(["linked", `${file}:Bed.Seed.sprout`, 46]);
      // `this.m()` looks in the class of `this` only.
      expect(link("sprout()", 1)).toEqual(["linked", `${file}:Bed.Seed.sprout`, 46]);
      // An interface's method with no body is the target.
      expect(link("use()", 1)).toEqual(["linked", `${file}:Bed.Tool.use`, 52]);
      expect(link("use()", 2)).toEqual(["linked", `${file}:Bed.Tool.use`, 52]);
      expect(link("check()")).toEqual(["linked", `${file}:Bed.Plot.check`, 83]);
      // From a local class, out to the class whose method declares it.
      expect(link("warm()", 2)).toEqual(["linked", `${file}:Bed.warm`, 26]);
    } finally {
      db.close();
    }
  });

  test("a construction links to its class, `this(…)` to the class itself and `super(…)` to the superclass, when the file declares it in scope", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const link = (file: string, text: string, needle: string, nth = 0) => {
        const r = callAt(rows, file, at(text, needle, nth));
        return [r.call_state, r.dst];
      };
      expect(link("garden/Bed.java", BED, "Seed()")).toEqual(["linked", "garden/Bed.java:Bed.Seed"]);
      expect(link("garden/Bed.java", BED, "this(1)")).toEqual(["linked", "garden/Bed.java:Bed"]);
      expect(link("garden/Shed.java", SHED, "super()", 2)).toEqual(["linked", "garden/Shed.java:Base"]);
      expect(link("garden/Shed.java", SHED, "Derived()", 1)).toEqual(["linked", "garden/Shed.java:Derived"]);
    } finally {
      db.close();
    }
  });

  test("what the language gives every program is outside: Object's, Enum's and java.lang's, unless the repo declares the name", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const state = (file: string, text: string, needle: string, nth = 0) => callAt(rows, file, at(text, needle, nth)).call_state;
      // A class that names no superclass extends Object (8.1.4); an enum extends Enum (8.9).
      expect(state("garden/Bed.java", BED, "toString()")).toBe("outside");
      expect(state("garden/Bed.java", BED, "super()")).toBe("outside");
      expect(state("garden/Shed.java", SHED, "super()", 1)).toBe("outside");
      expect(state("garden/Bed.java", BED, "ordinal()")).toBe("outside");
      // A type of java.lang, which every file imports on demand (7.3): its construction and its static methods.
      expect(state("garden/Bed.java", BED, "StringBuilder()")).toBe("outside");
      expect(state("garden/Shed.java", SHED, "valueOf(s)")).toBe("outside");
      expect(state("garden/Shed.java", SHED, "abs(-1)")).toBe("outside");
      // The package declares its own Thread, which hides java.lang's (6.4.1).
      expect(state("garden/Shed.java", SHED, "Thread()")).toBe("not_known");
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
      const bed = "garden/Bed.java";
      const shed = "garden/Shed.java";
      // Two methods of the name: which one is chosen by the arguments' types (15.12.2).
      expect(state(bed, BED, "soak(n)")).toEqual(notKnown);
      expect(state(bed, BED, "soak(1)")).toEqual(notKnown);
      // A method called on a value: its type is the tool's to work out.
      expect(state(bed, BED, "forEach(")).toEqual(notKnown);
      expect(state(bed, BED, "grow()")).toEqual(notKnown);
      // An enum's and a record's implicit members (8.9.3, 8.10.3) have no declaration to link.
      expect(state(bed, BED, "values()")).toEqual(notKnown);
      expect(state(bed, BED, "width()")).toEqual(notKnown);
      // An anonymous class (15.9.5) and a local class's construction.
      expect(state(bed, BED, "Runnable()")).toEqual(notKnown);
      expect(state(bed, BED, "Helper()")).toEqual(notKnown);
      // A class that extends another: what it inherits is not written here.
      expect(state(shed, SHED, "super()", 0)).toEqual(notKnown);
      expect(state(shed, SHED, "count()")).toEqual(notKnown);
      expect(state(shed, SHED, "toString()")).toEqual(notKnown);
      // A static import (7.5.3) and a single-type import (7.5.1) name code in another file or outside.
      expect(state(shed, SHED, "max(1")).toEqual(notKnown);
      expect(state(shed, SHED, "Rake()")).toEqual(notKnown);
      // A name that is a variable is no type (6.5.2): `Byte` here is a parameter.
      expect(state(shed, SHED, "hashCode()")).toEqual(notKnown);
    } finally {
      db.close();
    }
  });
});

const javaFound = spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0;

describe("Java's own parser", () => {
  test.skipIf(!javaFound)("every method, constructor and lambda javac's parser finds is one function of the graph, and the graph has no other (skipped without java on PATH)", async () => {
    const db = await built();
    try {
      const ref = javaReference(new Map(Object.entries(FILES)));
      for (const file of Object.keys(FILES)) {
        const answer = ref.files[file];
        if (answer === undefined || "error" in answer) throw new Error(`javac cannot read ${file}: ${JSON.stringify(answer)}`);
        const graph = db
          .query("SELECT start_line || '-' || end_line AS span FROM symbols WHERE layer = 'a' AND path = ? AND kind IN ('function', 'method') ORDER BY span")
          .all(file) as { span: string }[];
        expect({ file, spans: graph.map((r) => r.span).sort() }).toEqual({ file, spans: [...answer.functions].sort() });
      }
    } finally {
      db.close();
    }
  });

  test.skipIf(!javaFound)("every call javac's parser finds has a state, in the function it belongs to (skipped without java on PATH)", async () => {
    const db = await built();
    try {
      const ref = javaReference(new Map(Object.entries(FILES)));
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
      }
      expect(graph).toEqual(want);
    } finally {
      db.close();
    }
  });

  const builtins = javaFound ? javaBuiltins() : null;
  const same = builtins !== null && builtins.version === BUILTINS_JAVA_VERSION;
  // The lists follow one Java release; another, or none on PATH, cannot check them.
  test.skipIf(!same)(`the Java built-ins are what Java ${BUILTINS_JAVA_VERSION}'s own classes declare (skipped without that Java on PATH)`, () => {
    expect(readFileSync(BUILTINS_FILE, "utf8")).toBe(builtinsText(builtins!));
  });
});
