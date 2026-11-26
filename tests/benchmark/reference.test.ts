// The benchmark's references on small fixtures (trustmybot/tmb#244): Python's own parser's
// functions and the function each call belongs to, by Python's rules; and, for TypeScript, which
// calls the compiler declares as a node of the graph, and the kind of code each call is, for the
// misses by cause. Every expectation is written from the rule, by hand.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { compilerProgram } from "../../src/engine/graph/languages/typescript/links.ts";
import { pythonReference, referenceCounts } from "./python.ts";
import { CAUSES, causeOf, declaresANode } from "./typescript.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const PYTHON = [
  "import functools", // 1
  "", // 2
  "def deco(f):", // 3
  "    return functools.wraps(f)(f)", // 4
  "", // 5
  "@deco", // 6
  "@functools.lru_cache()", // 7
  "def total(items=list()):", // 8
  "    key = lambda x: x.price", // 9
  "    return sum(map(key, items))", // 10
  "", // 11
  "class Cart:", // 12
  "    tax = round(0.08, 2)", // 13
  "    async def add(self, x):", // 14
  "        def inner():", // 15
  "            return len(x)", // 16
  "        return inner()", // 17
  "",
].join("\n");

const METHOD = [
  "def deco():", // 1
  "    return lambda f: f", // 2
  "", // 3
  "def make():", // 4
  "    return 1", // 5
  "", // 6
  "class Box:", // 7
  "    @deco()", // 8: runs where `build` is defined, in the class body
  "    def build(self, x=make()):", // 9: the default too
  "        return make()", // 10: the method's own
  "",
].join("\n");

const hasPython = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;

describe("Python's own parser as the reference", () => {
  if (!hasPython) {
    console.warn("skipped: Python's reference: no python3 on PATH");
    test.skip("Python's reference (skipped: no python3 on PATH)", () => {});
    return;
  }

  test("every def, async def and lambda is a function, its lines starting at its first decorator", () => {
    const { functions } = referenceCounts(pythonReference(new Map([["cart.py", PYTHON]])));
    expect(functions.get("cart.py")).toEqual(["14-17", "15-16", "3-4", "6-10", "9-9"]);
  });

  test("a call belongs to the function whose body runs it; decorators, defaults and a class body's calls to the code around them", () => {
    const { calls } = referenceCounts(pythonReference(new Map([["cart.py", PYTHON]])));
    expect(Object.fromEntries(calls)).toEqual({
      // `wraps(f)` and the call of its result.
      "cart.py:3-4": 2,
      // `lru_cache()` and `list()` run where `total` is defined; `round` in the class body.
      "cart.py:": 3,
      "cart.py:6-10": 2,
      "cart.py:15-16": 1,
      "cart.py:14-17": 1,
    });
  });

  // Python has no decorator on a parameter; what runs where a method is defined is its decorators
  // and its parameters' defaults, and they belong to the class body around it (trustmybot/tmb#317).
  test("a method's decorator and its parameter's default belong to the class around it, its body's calls to the method", () => {
    const { functions, calls } = referenceCounts(pythonReference(new Map([["box.py", METHOD]])));
    expect(functions.get("box.py")).toEqual(["1-2", "2-2", "4-5", "8-10"]);
    // The reference counts a class body's calls for the file.
    expect(Object.fromEntries(calls)).toEqual({ "box.py:": 2, "box.py:8-10": 1 });
  });

  test("a file Python cannot parse is named, not scored", () => {
    const { functions, errors } = referenceCounts(pythonReference(new Map([["bad.py", "def (:\n"]])));
    expect(functions.has("bad.py")).toBe(false);
    expect(errors).toEqual([expect.stringContaining("bad.py: SyntaxError")]);
  });
});

const CART = [
  "export class Cart {",
  "  total() { return 1; }",
  "  static make() { return new Cart(); }",
  "}",
  "export function helper() { return 1; }",
  "export const arrow = () => 2;",
  "function makeData() { return () => 3; }",
  "export const data = makeData();",
  "export interface Shape { area(): number }",
  "",
].join("\n");

// Each call's line, its callee, and the cause the rule gives, or null when the compiler declares
// the callee as no node of the graph.
const USE: [string, string, string | null][] = [
  ['import * as ns from "./cart";', "", null],
  ['import { Cart, helper, arrow, data, type Shape } from "./cart";', "", null],
  ["const { picked } = { picked: () => 4 };", "", null],
  ["export function use(s: Shape, typed: Cart, cb: () => void) {", "", null],
  ["  helper();", "helper", CAUSES.direct],
  ["  arrow();", "arrow", CAUSES.direct],
  ["  data();", "data", CAUSES.data],
  ["  picked();", "picked", CAUSES.destructured],
  ["  ns.helper();", "helper", CAUSES.moduleOrClass],
  ["  Cart.make();", "make", CAUSES.moduleOrClass],
  ["  const c = new Cart();", "Cart", CAUSES.construct],
  ["  c.total();", "total", CAUSES.made],
  ["  typed.total();", "total", CAUSES.written],
  ["  new Cart().total();", "total", CAUSES.chain],
  // A signature with no body, a parameter and a local holding no function written there: no node.
  ["  s.area();", "area", CAUSES.written],
  ["  cb();", "cb", null],
  ["  const local = helper;", "", null],
  ["  local();", "local", null],
  // A local holding a function written there: the function is a node.
  ["  const inner = () => 5;", "", null],
  ["  inner();", "inner", CAUSES.direct],
  ["}", "", null],
];

// "Kinds of symbol": only a name the whole file can see is file-level data. A name bound by a
// loop, a block or a catch at the top of a file is a local, which is no node; a function written
// as a value is a node wherever it is bound. Each callee, and whether the compiler's declaration
// of it is a node of the graph.
const TOP = [
  "function pick() { return () => 1; }",
  "const pairs = [[1, pick()]] as const;",
  "const table = { a: pick() };",
  "const data = pick();",
  "export const { spread } = { spread: pick() };",
  "data(); spread();",
  "for (const [, fn] of pairs) fn();",
  "for (let i = 0, step = pick(); i < 1; i++) step();",
  "for (const key in table) key();",
  "for (var hoisted of [pick()]) hoisted();",
  "{ const inBlock = pick(); inBlock(); }",
  "{ const arrowInBlock = () => 2; arrowInBlock(); }",
  "try { pick(); } catch (failed) { failed(); }",
  "try { pick(); } catch ({ handle }) { handle(); }",
  "",
];
/** The callee each call of top.ts names, and whether the compiler declares it as a node. */
const TOP_WANT: Record<string, boolean> = {
  data: true,
  spread: true,
  fn: false,
  step: false,
  key: false,
  hoisted: false,
  inBlock: false,
  failed: false,
  handle: false,
  arrowInBlock: true,
};

let repo: string;
beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-benchmark-ref-")));
  writeFileSync(path.join(repo, "cart.ts"), CART);
  writeFileSync(path.join(repo, "use.ts"), `${USE.map(([line]) => line).join("\n")}\n`);
  writeFileSync(path.join(repo, "top.ts"), TOP.join("\n"));
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("the TypeScript compiler as the reference for links found", () => {
  test("a call counts when the compiler declares its callee as a node, and each is the kind of code its syntax says", () => {
    const program = compilerProgram(repo, resolveCommit(repo, "HEAD")!);
    // The calls made in use(), with the line and the callee's name as the compiler sees them.
    const got = program
      .calls("use.ts")
      .filter((c) => c.line >= 5)
      .map((c) => [c.line, c.callee?.text ?? "", declaresANode(c, program.checkerOf("use.ts")) ? causeOf(c, program.checkerOf("use.ts")) : null]);
    const want = USE.flatMap(([, callee, cause], i) => (callee === "" ? [] : [[i + 1, callee, cause]]));
    // `new Cart().total()` holds two calls on one line: the construction too, inside the outer call.
    want.splice(want.findIndex(([, , cause]) => cause === CAUSES.chain) + 1, 0, [14, "Cart", CAUSES.construct]);
    expect(got).toEqual(want);
  });
});

describe("the reference's nodes follow the Local row of Kinds of symbol", () => {
  test("a name bound by a loop, a block or a catch at the top of a file is a local, and no node", () => {
    const program = compilerProgram(repo, resolveCommit(repo, "HEAD")!);
    const got: Record<string, boolean> = {};
    for (const c of program.calls("top.ts")) {
      const name = c.callee?.text;
      if (name !== undefined && name in TOP_WANT) got[name] = declaresANode(c, program.checkerOf("top.ts"));
    }
    expect(got).toEqual(TOP_WANT);
  });
});
