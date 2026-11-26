// Way A links a bare-name call to a file-level data node (CODE_GRAPH.md, "Kinds of symbol",
// "Links on proof"; trustmybot/tmb#332). The name is looked up as the language looks it up: the
// function's own names and parameters, the scopes around it, then the file's names and imports.
// When that lookup ends at a name a statement of the file declares, the declaration is the proof,
// and no type is needed: the call links to that node, in its own file, through an import, an
// import under a new name and a re-export, and for each name a destructuring binds. A closer
// scope that binds the name (a parameter, a local, a loop's name at file level) decides first, so
// the call is not linked; a member call `x.f()` on a receiver way A does not prove is not linked.
//
// The fixtures use names of their own; each expectation is read off the page, not off the graph's
// output. Way B, the compiler, is the second judge of every TypeScript link expected here.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-data-calls-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

type EdgeRow = { src: string; dst_name: string; line: number; dst: string | null; call_state: string | null };

function callsOf(db: Database, layer: string): EdgeRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name, e.line, d.path || ':' || d.qualified_name AS dst, e.call_state
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state IS NOT NULL`,
    )
    .all(layer) as EdgeRow[];
}

/** The one call named `name` that `src` makes. */
function call(rows: EdgeRow[], src: string, name: string): EdgeRow {
  const found = rows.filter((r) => r.src === src && r.dst_name === name);
  if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}`);
  return found[0]!;
}

function names(db: Database, layer: string, file: string): string[] {
  return (db.query("SELECT qualified_name FROM symbols WHERE layer = ? AND path = ?").all(layer, file) as { qualified_name: string }[]).map((r) => r.qualified_name);
}

const TS_FILES = {
  "lib/loom.ts": lines(
    "function weave(): () => number {", //                                    1
    "  return () => 1;", //                                                   2
    "}", //                                                                   3
    "export const shuttle = weave();", //                                     4
    "export const { bobbin, spool: reel } = { bobbin: weave(), spool: weave() };", // 5
    "export let [heddle] = [weave()];", //                                    6
    "for (const treadle of [weave()]) treadle();", //                         7
    "const holder = { shuttle };", //                                         8
    "export function pattern(): number {", //                                 9
    "  return shuttle() + bobbin() + reel() + heddle();", //                  10
    "}", //                                                                   11
    "export function warp(shuttle: () => number): number {", //               12
    "  return shuttle();", //                                                 13
    "}", //                                                                   14
    "export function weft(): number {", //                                    15
    "  const bobbin = weave();", //                                           16
    "  return bobbin();", //                                                  17
    "}", //                                                                   18
    "export function loose(): number {", //                                   19
    "  return holder.shuttle();", //                                          20
    "}", //                                                                   21
  ),
  "lib/index.ts": lines('export { shuttle as flyer } from "./loom";'),
  "lib/crate.ts": lines(
    "function nail(): () => number {", //   1
    "  return () => 1;", //                 2
    "}", //                                 3
    "namespace Left {", //                  4
    "  export const lid = nail();", //      5
    "  export function open(): number {", // 6
    "    return lid();", //                 7
    "  }", //                               8
    "}", //                                 9
    "namespace Right {", //                 10
    "  export const lid = nail();", //      11
    "  export function shut(): number {", // 12
    "    return lid();", //                 13
    "  }", //                               14
    "}", //                                 15
  ),
  "lib/mill.ts": lines(
    'import { shuttle, bobbin, reel as spindle } from "./loom";', //          1
    'import { heddle as frame } from "./loom";', //                           2
    'import { flyer } from "./index";', //                                    3
    "export function run(): number {", //                                     4
    "  return shuttle() + bobbin() + spindle() + frame() + flyer();", //     5
    "}", //                                                                   6
  ),
};

describe("TypeScript and JavaScript", () => {
  async function bothWays() {
    const sha = commit(TS_FILES);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, "a", { force: true, links: "built-in" });
    await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
    return db;
  }

  // Each call, and the node the page says it reaches.
  const LINKED = [
    ["lib/loom.ts:pattern", "shuttle", "lib/loom.ts:shuttle"],
    ["lib/loom.ts:pattern", "bobbin", "lib/loom.ts:bobbin"],
    ["lib/loom.ts:pattern", "reel", "lib/loom.ts:reel"],
    ["lib/loom.ts:pattern", "heddle", "lib/loom.ts:heddle"],
    ["lib/mill.ts:run", "shuttle", "lib/loom.ts:shuttle"],
    ["lib/mill.ts:run", "bobbin", "lib/loom.ts:bobbin"],
    ["lib/mill.ts:run", "reel", "lib/loom.ts:reel"],
    ["lib/mill.ts:run", "heddle", "lib/loom.ts:heddle"],
  ] as const;

  test("a call whose name the file's own scope proves links to the file-level data node, destructured names included", async () => {
    const db = await bothWays();
    const a = callsOf(db, "a");
    for (const [src, name, dst] of LINKED.filter(([src]) => src.startsWith("lib/loom.ts"))) {
      expect({ name, ...call(a, src, name) }).toMatchObject({ name, dst, call_state: "linked" });
    }
    db.close();
  });

  test("a call through an import, an import under a new name included, links to the node the import names", async () => {
    const db = await bothWays();
    const a = callsOf(db, "a");
    for (const [src, name, dst] of LINKED.filter(([src]) => src.startsWith("lib/mill.ts"))) {
      expect({ name, ...call(a, src, name) }).toMatchObject({ name, dst, call_state: "linked" });
    }
    db.close();
  });

  test("a call through a re-export under a new name links where the name is declared", async () => {
    const db = await bothWays();
    expect(call(callsOf(db, "a"), "lib/mill.ts:run", "flyer")).toMatchObject({ dst: "lib/loom.ts:shuttle", call_state: "linked" });
    db.close();
  });

  test("way A's links are the compiler's: way B links each of the same calls to the same node", async () => {
    const db = await bothWays();
    const b = callsOf(db, "b");
    for (const [src, name, dst] of LINKED) expect({ name, ...call(b, src, name) }).toMatchObject({ name, dst, call_state: "linked" });
    db.close();
  });

  test("a parameter or a local of the same name decides first: the call is not linked", async () => {
    const db = await bothWays();
    const a = callsOf(db, "a");
    expect(call(a, "lib/loom.ts:warp", "shuttle")).toMatchObject({ dst: null, call_state: "not_known" });
    expect(call(a, "lib/loom.ts:weft", "bobbin")).toMatchObject({ dst: null, call_state: "not_known" });
    db.close();
  });

  test("a name a loop binds at file level is a local: no node, and its call is not linked", async () => {
    const db = await bothWays();
    expect(names(db, "a", "lib/loom.ts")).not.toContain("treadle");
    expect(call(callsOf(db, "a"), "lib/loom.ts:lib/loom.ts", "treadle")).toMatchObject({ dst: null, call_state: "not_known" });
    db.close();
  });

  test("a variable in a namespace is a member of that namespace, no file-level data: no node, and its call is not linked", async () => {
    const db = await bothWays();
    expect(names(db, "a", "lib/crate.ts")).not.toContain("lid");
    const a = callsOf(db, "a");
    expect(call(a, "lib/crate.ts:open", "lid")).toMatchObject({ dst: null });
    expect(call(a, "lib/crate.ts:shut", "lid")).toMatchObject({ dst: null });
    db.close();
  });

  test("a member call on a receiver way A does not prove is not linked to the data node of that name", async () => {
    const db = await bothWays();
    expect(call(callsOf(db, "a"), "lib/loom.ts:loose", "shuttle")).toMatchObject({ dst: null, call_state: "not_known" });
    db.close();
  });
});

const PY_FILES = {
  "reel/__init__.py": "",
  "reel/loom.py": lines(
    "def weave():", //                          1
    "    return lambda: 1", //                  2
    "", //                                      3
    "", //                                      4
    "shuttle = weave()", //                     5
    "bobbin, (spool, heddle) = weave(), (weave(), weave())", // 6
    "", //                                      7
    "", //                                      8
    "def pattern():", //                        9
    "    return shuttle() + bobbin() + spool()", // 10
    "", //                                      11
    "", //                                      12
    "def warp(shuttle):", //                    13
    "    return shuttle()", //                  14
    "", //                                      15
    "", //                                      16
    "def weft():", //                           17
    "    bobbin = weave()", //                  18
    "    return bobbin()", //                   19
  ),
  "reel/mill.py": lines(
    "from reel.loom import shuttle, bobbin as spindle", // 1
    "", //                                      2
    "", //                                      3
    "def run():", //                            4
    "    return shuttle() + spindle()", //      5
    "", //                                      6
    "", //                                      7
    "def inner():", //                          8
    "    from reel.loom import heddle as frame", // 9
    "    return frame()", //                    10
  ),
  "reel/twice.py": lines(
    "from reel.loom import spool", //           1
    "", //                                      2
    "spool = spool or None", //                 3
    "", //                                      4
    "", //                                      5
    "def use():", //                            6
    "    return spool()", //                    7
  ),
};

describe("Python", () => {
  async function built() {
    const sha = commit(PY_FILES);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, "a", { force: true, links: "built-in" });
    return db;
  }

  test("a call of a module-level name links to its data node, in the module and through an import, under a new name too", async () => {
    const db = await built();
    const a = callsOf(db, "a");
    for (const [src, name, dst] of [
      ["reel/loom.py:pattern", "shuttle", "reel/loom.py:shuttle"],
      ["reel/loom.py:pattern", "bobbin", "reel/loom.py:bobbin"],
      ["reel/loom.py:pattern", "spool", "reel/loom.py:spool"],
      ["reel/mill.py:run", "shuttle", "reel/loom.py:shuttle"],
      ["reel/mill.py:run", "bobbin", "reel/loom.py:bobbin"],
      ["reel/mill.py:inner", "heddle", "reel/loom.py:heddle"],
    ] as const) {
      expect({ name, ...call(a, src, name) }).toMatchObject({ name, dst, call_state: "linked" });
    }
    db.close();
  });

  test("a parameter or a local of the same name decides first: the call is not linked", async () => {
    const db = await built();
    const a = callsOf(db, "a");
    expect(call(a, "reel/loom.py:warp", "shuttle")).toMatchObject({ dst: null, call_state: "not_known" });
    expect(call(a, "reel/loom.py:weft", "bobbin")).toMatchObject({ dst: null, call_state: "not_known" });
    db.close();
  });

  test("a name the module binds both by an assignment and by an import is bound twice: the call is not linked", async () => {
    const db = await built();
    expect(call(callsOf(db, "a"), "reel/twice.py:use", "spool")).toMatchObject({ dst: null });
    db.close();
  });
});
