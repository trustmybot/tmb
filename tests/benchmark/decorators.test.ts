// Who owns a decorator's call (trustmybot/tmb#244), from CODE_GRAPH.md's "What a call is" and
// "Who owns a call": `@cache()` is a call and `@cache` a use; a decorator's call belongs to what
// encloses the decorated thing, since it runs when that thing is defined: the type for anything
// inside a type (a method, an accessor, a field, or a parameter of one), the file for a top-level
// function or type. The graph, the TypeScript compiler's check and Python's own parser must each
// follow it. Every expectation is written from the rule, by hand.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { compilerCalls } from "../../src/engine/graph/languages/typescript/links.ts";
import { withGraph } from "./graph.ts";
import { pythonReference, referenceCounts } from "./python.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const TS = [
  "function cache(): any { return () => {}; }", // 1
  "function tag(): any { return () => {}; }", // 2
  "@tag()", // 3: decorates a top-level type, so it belongs to the file
  "class Box {", // 4
  "  @cache()", // 5: decorates a method, so it belongs to the type
  "  total(): number {", // 6
  "    return count();", // 7: in the method's body, so the method's
  "  }", // 8
  "  @cache", // 9: a bare name, a use and not a call
  "  size(): number { return 0; }", // 10
  "}", // 11
  "function count(): number { return 1; }", // 12
  "export { Box };", // 13
  "",
].join("\n");

// Decorators on what a type holds besides its methods (trustmybot/tmb#317): each runs when the
// class is defined, so each call is the type's.
const MEMBERS = [
  "function inject(): any { return () => {}; }", // 1
  "function label(): string { return \"\"; }", // 2
  "export class Service {", // 3
  "  @inject()", // 4: decorates a field, so it belongs to the type
  "  name = \"\";", // 5
  "  @inject()", // 6: decorates an accessor, so it belongs to the type
  "  get size(): number { return 0; }", // 7
  "  constructor(@inject() dep: number) {", // 8: decorates a constructor's parameter, so it belongs to the type
  "    this.name = label();", // 9: in the constructor's body, so the constructor's
  "  }", // 10
  "  run(@inject() a: number): number { return a; }", // 11: decorates a method's parameter, so it belongs to the type
  "}", // 12
  "",
].join("\n");

const PY = [
  "def cache():", // 1
  "    return lambda f: f", // 2
  "", // 3
  "@cache()", // 4: decorates a top-level function, so it belongs to the file
  "def top():", // 5
  "    return 1", // 6
  "", // 7
  "class Cart:", // 8
  "    @cache()", // 9: decorates a method, so it belongs to the class
  "    def total(self):", // 10
  "        return top()", // 11: in the method's body, so the method's
  "", // 12
  "    @cache", // 13: a bare name, a use and not a call
  "    def size(self):", // 14
  "        return 0", // 15
  "",
].join("\n");

let repo = "";
let sha = "";
beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-benchmark-deco-")));
  writeFileSync(path.join(repo, "deco.ts"), TS);
  writeFileSync(path.join(repo, "deco.py"), PY);
  writeFileSync(path.join(repo, "members.ts"), MEMBERS);
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "fixture"]]) {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  sha = resolveCommit(repo, "HEAD")!;
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

type Owned = { file: string; kind: string; name: string; callee: string; line: number };
const owners = (db: Database): Owned[] =>
  db
    .query(
      `SELECT s.path AS file, s.kind AS kind, s.qualified_name AS name, e.dst_name AS callee, e.line AS line
         FROM edges e JOIN symbols s ON s.id = e.src_id WHERE e.call_state IS NOT NULL ORDER BY s.path, e.line`,
    )
    .all() as Owned[];

describe("TypeScript: a decorator's call belongs to what encloses the decorated thing", () => {
  test("the compiler's check: the class's decorator counts for the file, the method's for the type, never for the method", () => {
    // compilerCalls counts a call the type owns, outside its methods, for the file.
    expect(Object.fromEntries(compilerCalls("deco.ts", TS))).toEqual({ "": 2, "5-8": 1 });
  });

  test("the graph: the class's decorator is the file's call, the method's is the class's, and a bare decorator is no call", async () => {
    const got = await withGraph(repo, sha, {}, (db) => owners(db).filter((o) => o.file === "deco.ts"));
    expect(got.map(({ kind, callee, line }) => ({ kind, callee, line }))).toEqual([
      { kind: "module", callee: "tag", line: 3 },
      { kind: "class", callee: "cache", line: 5 },
      { kind: "method", callee: "count", line: 7 },
    ]);
  });

  test("the compiler's check: a field's, an accessor's and a parameter's decorators count for the type, never for the method", () => {
    expect(Object.fromEntries(compilerCalls("members.ts", MEMBERS))).toEqual({ "": 4, "8-10": 1 });
  });

  test("the graph: a field's, an accessor's and a parameter's decorators are the class's calls", async () => {
    const got = await withGraph(repo, sha, (db) => owners(db).filter((o) => o.file === "members.ts"));
    expect(got.map(({ kind, name, callee, line }) => ({ kind, name, callee, line }))).toEqual([
      { kind: "class", name: "Service", callee: "inject", line: 4 },
      { kind: "class", name: "Service", callee: "inject", line: 6 },
      { kind: "class", name: "Service", callee: "inject", line: 8 },
      { kind: "method", name: "Service.constructor", callee: "label", line: 9 },
      { kind: "class", name: "Service", callee: "inject", line: 11 },
    ]);
  });
});

const hasPython = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;

describe("Python: a decorator's call belongs to what encloses the decorated thing", () => {
  test("the graph: the top-level function's decorator is the file's call, the method's is the class's", async () => {
    const got = await withGraph(repo, sha, {}, (db) => owners(db).filter((o) => o.file === "deco.py"));
    expect(got.map(({ kind, callee, line }) => ({ kind, callee, line }))).toEqual([
      { kind: "module", callee: "cache", line: 4 },
      { kind: "class", callee: "cache", line: 9 },
      { kind: "method", callee: "top", line: 11 },
    ]);
  });

  if (!hasPython) {
    console.warn("skipped: Python's reference: no python3 on PATH");
    test.skip("Python's reference (skipped: no python3 on PATH)", () => {});
    return;
  }

  test("Python's own parser: both decorators' calls are outside every function, and a bare decorator is no call", () => {
    const { calls } = referenceCounts(pythonReference(new Map([["deco.py", PY]])));
    // The reference counts a class body's calls, outside its methods, for the file.
    expect(Object.fromEntries(calls)).toEqual({ "deco.py:": 2, "deco.py:9-11": 1 });
  });
});
