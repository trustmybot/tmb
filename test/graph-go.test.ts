// Go in the code graph (trustmybot/tmb#352), read by its tree-sitter grammar: the nodes the page's
// "Kinds of symbol" gives Go, the place and owner of each call ("The three states of a call", "Two
// ways to make links"), and the links and states way A's built-in rules prove ("Links on proof").
// Each expectation is read off the page and the Go spec (https://go.dev/ref/spec), call by call,
// not off the graph's output. The fixtures are small programs of their own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../src/engine/graph/build.ts";
import { openGraphDb } from "../src/engine/graph/db.ts";
import { BUILTINS_FILE, builtinsText, goBuiltins } from "../src/engine/graph/languages/go/builtins.gen.ts";
import { BUILTINS_GO_VERSION } from "../src/engine/graph/languages/go/builtins.ts";
import { goReference } from "../tests/benchmark/go.ts";

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
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-go-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const PANTRY = lines(
  "package pantry", //                                                   1
  "", //                                                                 2
  'import "strings"', //                                                 3
  "", //                                                                 4
  "// Shelf holds jars.", //                                             5
  "type Shelf[K comparable] struct {", //                                6
  "\tjars []int", //                                                     7
  "}", //                                                                8
  "", //                                                                 9
  "type (", //                                                           10
  "\tLabeler interface {", //                                            11
  "\t\tLabel(n int) string", //                                          12
  "\t\tWidth() int", //                                                  13
  "\t}", //                                                              14
  "\tCount = int", //                                                    15
  ")", //                                                                16
  "", //                                                                 17
  "var opener = func() int { return weigh(1) }", //                      18
  "", //                                                                 19
  "var top, bottom = level(), level()", //                               20
  "", //                                                                 21
  "var depth = level()", //                                              22
  "", //                                                                 23
  "var _ = level()", //                                                  24
  "", //                                                                 25
  "const Grams = 1", //                                                  26
  "", //                                                                 27
  "func weigh(n int) int {", //                                          28
  '\treturn n + len(strings.Repeat("a", n))', //                         29
  "}", //                                                                30
  "", //                                                                 31
  "func level() int { return 1 }", //                                    32
  "", //                                                                 33
  "func (s *Shelf[K]) Stock() int {", //                                 34
  "\tfill := func(v int) int { return weigh(v) }", //                    35
  "\treturn fill(1) + weigh(2) + opener()", //                           36
  "}", //                                                                37
  "", //                                                                 38
  "func (Shelf[K]) Bare() bool { return false }", //                     39
);

const FILES: Record<string, string> = {
  "pantry/pantry.go": PANTRY,
  // The same package in another file: Go's package block spans its files.
  "pantry/more.go": lines(
    "package pantry", //                                   1
    "", //                                                 2
    "func (s *Shelf[K]) Restock() int {", //               3
    "\treturn level() + weigh(3)", //                      4
    "}", //                                                5
  ),
  // Names bound inside a function come first in Go's lookup ("Declarations and scope").
  "pantry/shadow.go": lines(
    "package pantry", //                                   1
    "", //                                                 2
    "func hide(len func(string) int, weigh int) int {", // 3
    "\tlevel := func() int { return 2 }", //              4
    '\treturn len("x") + level() + weigh', //             5
    "}", //                                                6
    "", //                                                 7
    "func cast[T ~int](v int) T {", //                     8
    "\treturn T(v)", //                                    9
    "}", //                                                10
  ),
  // Calls of Go's predeclared functions and conversions to its predeclared types ("Predeclared identifiers").
  "pantry/grow.go": lines(
    "package pantry", //                                   1
    "", //                                                 2
    "func grow(xs []int) []int {", //                      3
    "\tys := make([]int, 0)", //                           4
    "\treturn append(ys, int(int64(len(xs))))", //         5
    "}", //                                                6
  ),
  // Another package, which declares a name Go predeclares and a name the first package declares.
  "tally/tally.go": lines(
    "package tally", //                                    1
    "", //                                                 2
    "func min(a, b int) int { return a }", //              3
    "", //                                                 4
    "func level() int { return 9 }", //                    5
    "", //                                                 6
    "func pick[T any](a, b T) T { return a }", //          7
    "", //                                                 8
    "func Use() int { return pick[int](1, 2) }", //        9
    "", //                                                 10
    'func Raw() []byte { return []byte("a") }', //         11
  ),
  "other/other.go": lines(
    "package other", //                                    1
    "", //                                                 2
    "func Low(a, b int) int {", //                         3
    "\treturn max(a, b) + min(a, b)", //                   4
    "}", //                                                5
  ),
};

type SymbolRow = { path: string; kind: string; qualified_name: string; start_line: number; end_line: number; parent: string | null; unnamed: number; owner: string | null; doc: string; exported: number };

function symbols(db: Database, layer: string): SymbolRow[] {
  return db
    .query(
      `SELECT s.path, s.kind, s.qualified_name, s.start_line, s.end_line, p.qualified_name AS parent, s.unnamed, o.qualified_name AS owner, s.doc, s.exported
         FROM symbols s LEFT JOIN symbols p ON p.id = s.parent_id LEFT JOIN symbols o ON o.id = s.named_id
        WHERE s.layer = ? AND s.kind != 'module'`,
    )
    .all(layer) as SymbolRow[];
}

type CallRow = { src: string; src_unnamed: number; dst_name: string; line: number; pos: number; dst: string | null; call_state: string };

function calls(db: Database, layer: string): CallRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, s.unnamed AS src_unnamed, e.dst_name, e.line, e.pos, d.path || ':' || d.qualified_name AS dst, e.call_state
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state IS NOT NULL ORDER BY e.pos`,
    )
    .all(layer) as CallRow[];
}

/** The calls named `name` that `src` makes, in the order they are written. */
function callsOf(rows: CallRow[], src: string, name: string): CallRow[] {
  return rows.filter((r) => r.src === src && r.dst_name === name);
}

/** The one call named `name` that `src` makes. */
function call(rows: CallRow[], src: string, name: string): CallRow {
  const found = callsOf(rows, src, name);
  if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}`);
  return found[0]!;
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

async function built(files: Record<string, string> = FILES): Promise<Database> {
  const sha = commit(files);
  const db = openGraphDb(project, null);
  await buildLayer(db, project, sha, "a", { force: true, links: "built-in" });
  return db;
}

describe("nodes", () => {
  test("each function, method, type, interface method and file-level name is a node, held by its container", async () => {
    const db = await built();
    try {
      const rows = symbols(db, "a").filter((r) => r.path === "pantry/pantry.go");
      const named = rows.filter((r) => r.unnamed === 0).map(({ kind, qualified_name, start_line, end_line, parent }) => ({ kind, qualified_name, start_line, end_line, parent }));
      const file = "pantry/pantry.go";
      expect(named).toEqual(
        expect.arrayContaining([
          // A type declaration: a struct is a named shape; a lone declaration starts at `type`.
          { kind: "type", qualified_name: "Shelf", start_line: 6, end_line: 8, parent: file },
          // An interface type, and each of its method specs: a method declared in a type, with no body.
          { kind: "interface", qualified_name: "Labeler", start_line: 11, end_line: 14, parent: file },
          { kind: "method", qualified_name: "Labeler.Label", start_line: 12, end_line: 12, parent: "Labeler" },
          { kind: "method", qualified_name: "Labeler.Width", start_line: 13, end_line: 13, parent: "Labeler" },
          // An alias declaration is a type declaration too.
          { kind: "type", qualified_name: "Count", start_line: 15, end_line: 15, parent: file },
          // A function written as the value of a file-level name is one callable node, from where the declaration starts.
          { kind: "function", qualified_name: "opener", start_line: 18, end_line: 18, parent: file },
          // Each name a file-level declaration binds is file-level data.
          { kind: "const", qualified_name: "top", start_line: 20, end_line: 20, parent: file },
          { kind: "const", qualified_name: "bottom", start_line: 20, end_line: 20, parent: file },
          { kind: "const", qualified_name: "depth", start_line: 22, end_line: 22, parent: file },
          { kind: "const", qualified_name: "Grams", start_line: 26, end_line: 26, parent: file },
          { kind: "function", qualified_name: "weigh", start_line: 28, end_line: 30, parent: file },
          { kind: "function", qualified_name: "level", start_line: 32, end_line: 32, parent: file },
          // A method is named through its receiver's base type, a pointer or a generic one included, and held by it.
          { kind: "method", qualified_name: "Shelf.Stock", start_line: 34, end_line: 37, parent: "Shelf" },
          { kind: "method", qualified_name: "Shelf.Bare", start_line: 39, end_line: 39, parent: "Shelf" },
        ]),
      );
      // The blank identifier declares nothing; nothing inside a function is a node, but an unnamed function.
      expect(rows.map((r) => r.qualified_name)).not.toContain("_");
      expect(rows.map((r) => r.qualified_name)).not.toContain("fill");
      expect(rows.filter((r) => r.unnamed === 0)).toHaveLength(14);
      // A function literal is an unnamed function, held by the function it is written in, which owns it.
      const unnamed = rows.filter((r) => r.unnamed === 1);
      expect(unnamed.map(({ kind, start_line, end_line, parent, owner }) => ({ kind, start_line, end_line, parent, owner }))).toEqual([
        { kind: "function", start_line: 35, end_line: 35, parent: "Shelf.Stock", owner: "Shelf.Stock" },
      ]);
      // A method declared in another file than its type keeps the type's name.
      expect(symbols(db, "a").filter((r) => r.path === "pantry/more.go" && r.kind === "method").map((r) => r.qualified_name)).toEqual(["Shelf.Restock"]);
    } finally {
      db.close();
    }
  });

  test("a declaration's doc is the comment above it, and a name is exported when it starts with an upper-case letter", async () => {
    const db = await built();
    try {
      const rows = symbols(db, "a").filter((r) => r.path === "pantry/pantry.go");
      const of = (name: string) => rows.find((r) => r.qualified_name === name)!;
      expect(of("Shelf").doc).toBe("Shelf holds jars.");
      expect([of("Shelf").exported, of("Grams").exported, of("Shelf.Stock").exported]).toEqual([1, 1, 1]);
      expect([of("weigh").exported, of("depth").exported, of("opener").exported]).toEqual([0, 0, 0]);
    } finally {
      db.close();
    }
  });
});

describe("calls", () => {
  test("a call is placed where its called name is written, and two calls of one name on one line are two", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      const file = "pantry/pantry.go:pantry/pantry.go";
      expect(callsOf(rows, file, "level").map((r) => r.pos)).toEqual([at(PANTRY, "level()", 0), at(PANTRY, "level()", 1), at(PANTRY, "level()", 3)]);
      expect(call(rows, "pantry/pantry.go:weigh", "Repeat").pos).toBe(at(PANTRY, "Repeat"));
      const tally = readFileSync(path.join(project, "tally/tally.go"), "utf8");
      // An explicit instantiation `pick[int](…)` calls `pick`; a conversion to a type literal names nothing, so it is placed where it starts.
      expect(call(rows, "tally/tally.go:Use", "pick").pos).toBe(at(tally, "pick[int]"));
      const raw = rows.filter((r) => r.src === "tally/tally.go:Raw");
      expect(raw.map((r) => r.pos)).toEqual([at(tally, '[]byte("a")')]);
    } finally {
      db.close();
    }
  });

  test("a call belongs to the nearest callable; in a file-level name's value, to that name, or to the file when one value binds several", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      expect(call(rows, "pantry/pantry.go:opener", "weigh").line).toBe(18);
      expect(call(rows, "pantry/pantry.go:depth", "level").line).toBe(22);
      // `top, bottom = level(), level()` binds two names, and `_` binds none: the file owns those calls.
      expect(callsOf(rows, "pantry/pantry.go:pantry/pantry.go", "level").map((r) => r.line)).toEqual([20, 20, 24]);
      // A call in a function literal is that unnamed function's own.
      const inLiteral = rows.filter((r) => r.line === 35);
      expect(inLiteral.map((r) => [r.dst_name, r.src_unnamed])).toEqual([["weigh", 1]]);
      expect(callsOf(rows, "pantry/pantry.go:Shelf.Stock", "weigh").map((r) => r.line)).toEqual([36]);
    } finally {
      db.close();
    }
  });
});

describe("way A", () => {
  test("a bare call of a function or file-level name declared in the same file links to it", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      expect(call(rows, "pantry/pantry.go:opener", "weigh")).toMatchObject({ dst: "pantry/pantry.go:weigh", call_state: "linked" });
      expect(call(rows, "pantry/pantry.go:depth", "level")).toMatchObject({ dst: "pantry/pantry.go:level", call_state: "linked" });
      const stock = "pantry/pantry.go:Shelf.Stock";
      expect(call(rows, stock, "weigh")).toMatchObject({ dst: "pantry/pantry.go:weigh", call_state: "linked" });
      expect(call(rows, stock, "opener")).toMatchObject({ dst: "pantry/pantry.go:opener", call_state: "linked" });
      expect(rows.find((r) => r.line === 35 && r.dst_name === "weigh")).toMatchObject({ dst: "pantry/pantry.go:weigh", call_state: "linked" });
      expect(call(rows, "tally/tally.go:Use", "pick")).toMatchObject({ dst: "tally/tally.go:pick", call_state: "linked" });
    } finally {
      db.close();
    }
  });

  test("a closure held in a local, a parameter and a type parameter are bound inside the function: never linked, never outside", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      expect(call(rows, "pantry/pantry.go:Shelf.Stock", "fill")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(call(rows, "pantry/shadow.go:hide", "len")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(call(rows, "pantry/shadow.go:hide", "level")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(call(rows, "pantry/shadow.go:cast", "T")).toMatchObject({ dst: null, call_state: "not_known" });
    } finally {
      db.close();
    }
  });

  test("a predeclared function or type is outside, unless a file of the repo declares the name", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      for (const name of ["make", "append", "int", "int64", "len"]) expect(call(rows, "pantry/grow.go:grow", name)).toMatchObject({ dst: null, call_state: "outside" });
      expect(call(rows, "pantry/pantry.go:weigh", "len")).toMatchObject({ call_state: "outside" });
      expect(call(rows, "other/other.go:Low", "max")).toMatchObject({ dst: null, call_state: "outside" });
      // tally declares a `min`: the repo is looked up first, so other's `min` is not proven the built-in.
      expect(call(rows, "other/other.go:Low", "min")).toMatchObject({ dst: null, call_state: "not_known" });
    } finally {
      db.close();
    }
  });

  test("a name declared in another file is never linked by its name alone, nor a call on a package or a value", async () => {
    const db = await built();
    try {
      const rows = calls(db, "a");
      // pantry/more.go is in pantry's package, and tally declares a `level` of its own.
      expect(call(rows, "pantry/more.go:Shelf.Restock", "level")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(call(rows, "pantry/more.go:Shelf.Restock", "weigh")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(call(rows, "pantry/pantry.go:weigh", "Repeat")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(rows.filter((r) => r.src === "tally/tally.go:Raw").map((r) => r.call_state)).toEqual(["not_known"]);
    } finally {
      db.close();
    }
  });
});

// Shapes of Go's grammar for the coverage check: every function Go's own parser finds is one
// function of the graph, by file and lines, and the graph holds no other.
const SHAPES = lines(
  "package shapes",
  "",
  "type Box[T any] struct{ v T }",
  "",
  "type Doer interface {",
  "\tDo(",
  "\t\tx int,",
  "\t) error",
  "\tfmt() string",
  "}",
  "",
  "type Handler func(int) int",
  "",
  "var (",
  "\tfirst = func(a int) int {",
  "\t\treturn a",
  "\t}",
  "\tsecond, third = func() {}, func() {}",
  ")",
  "",
  "func (b Box[T]) Get() T { return b.v }",
  "",
  "func (b *Box[T]) Map(f func(T) T) {",
  "\tb.v = f(b.v)",
  "\tgo func() {",
  "\t\tdefer func() { recover() }()",
  "\t}()",
  "}",
  "",
  "func init() {}",
  "func init() {}",
  "",
  "func Outer() Handler {",
  "\ttype local interface{ Hidden() }",
  "\treturn func(n int) int {",
  "\t\treturn n",
  "\t}",
  "}",
  "",
  "func Anon(x interface{ Inline() }) {}",
);

const goFound = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

describe("Go's own parser", () => {
  test.skipIf(!goFound)("every function go/parser finds is one function of the graph, and the graph has no other (skipped without go on PATH)", async () => {
    const files = { "shapes/shapes.go": SHAPES, ...FILES };
    const db = await built(files);
    try {
      const ref = goReference(new Map(Object.entries(files)));
      for (const file of Object.keys(files)) {
        const answer = ref.files[file];
        if (answer === undefined || "error" in answer) throw new Error(`go/parser cannot read ${file}: ${JSON.stringify(answer)}`);
        const graph = db
          .query("SELECT start_line || '-' || end_line AS span FROM symbols WHERE layer = 'a' AND path = ? AND kind IN ('function', 'method') ORDER BY span")
          .all(file) as { span: string }[];
        expect({ file, spans: graph.map((r) => r.span).sort() }).toEqual({ file, spans: [...answer.functions].sort() });
      }
    } finally {
      db.close();
    }
  });

  test.skipIf(!goFound)("every call go/parser finds has a state, in the function it belongs to (skipped without go on PATH)", async () => {
    const files = { "shapes/shapes.go": SHAPES, ...FILES };
    const db = await built(files);
    try {
      const ref = goReference(new Map(Object.entries(files)));
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

  const builtins = goBuiltins();
  const same = builtins !== null && builtins.version === BUILTINS_GO_VERSION;
  // The list follows one Go release; another, or none on PATH, cannot check it.
  test.skipIf(!same)(`the Go built-ins are what ${BUILTINS_GO_VERSION}'s universe scope declares (skipped without that Go on PATH)`, () => {
    expect(readFileSync(BUILTINS_FILE, "utf8")).toBe(builtinsText(builtins!));
  });
});
