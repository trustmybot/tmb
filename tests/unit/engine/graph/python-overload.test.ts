// Overload stubs are one function (CODE_GRAPH.md, "Two ways to make links"; trustmybot/tmb#368):
// a Python function's `@overload` stubs are no nodes, and the one definition that runs is the node,
// in either way. A stub is a definition decorated with `typing.overload` or
// `typing_extensions.overload`, as Python's own lookup finds it: imported under any name, or used
// as an attribute of the module imported under any name. A decorator that only shares the name is
// not it, and its definitions stay nodes. Every expectation is read off the rule, not off the graph.
import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../../../../src/engine/graph/build.ts";
import { openGraphDb } from "../../../../src/engine/graph/db.ts";
import type { LinkWay } from "../../../../src/engine/graph/ways.ts";
import { installPinnedTools } from "../../../lib/pinned-tools.ts";
import { git } from "../../../lib/git.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

// Way B loads pyright from tmb's tools folder; the setup installs tmb's pinned copy.
beforeAll(installPinnedTools);

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-python-overload-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;

/** The repo's graph built by one way, at a commit of the files. */
async function built(files: Record<string, string>, links: LinkWay, layer: string): Promise<Database> {
  for (const [file, text] of Object.entries({ ".gitignore": ".tmb/\n", ...files })) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  const db = openGraphDb(project, null);
  await buildLayer(db, project, git(project, "rev-parse", "HEAD"), layer, { force: true, links });
  return db;
}

type Node = { name: string; kind: string; start: number; end: number };

/** The nodes of a file, by name and lines. */
function nodes(db: Database, layer: string, file: string): Node[] {
  return db
    .query(`SELECT qualified_name AS name, kind, start_line AS start, end_line AS end FROM symbols WHERE layer = ? AND path = ? AND kind != 'file' ORDER BY start_line, qualified_name`)
    .all(layer, file) as Node[];
}

type CallRow = { name: string; line: number; dst: string | null; dst_start: number | null; state: string };

/** The calls `src` makes, with where each links. */
function callsOf(db: Database, layer: string, src: string): CallRow[] {
  return db
    .query(
      `SELECT e.dst_name AS name, e.line, d.path || ':' || d.qualified_name AS dst, d.start_line AS dst_start, e.call_state AS state
       FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
       WHERE e.layer = ? AND e.call_state IS NOT NULL AND s.path || ':' || s.qualified_name = ? ORDER BY e.line, e.dst_name`,
    )
    .all(layer, src) as CallRow[];
}

// Three spellings of the one decorator: a name imported under a new name, the module imported
// under a new name, and the module under its own.
const STENCIL = lines(
  "from typing import overload as variant", // 1
  "import typing_extensions as tx", // 2
  "import typing", // 3
  "", // 4
  "", // 5
  "@variant", // 6
  "def tint(c: int) -> int: ...", // 7
  "@variant", // 8
  "def tint(c: str) -> str: ...", // 9
  "def tint(c):", // 10
  "    return c", // 11
  "", // 12
  "", // 13
  "class Palette:", // 14
  "    @typing.overload", // 15
  "    def mix(self, a: int) -> int: ...", // 16
  "    @typing.overload", // 17
  "    def mix(self, a: str) -> str: ...", // 18
  "    def mix(self, a):", // 19
  "        return a", // 20
  "", // 21
  "    @tx.overload", // 22
  "    @staticmethod", // 23
  "    def blend(a: int) -> int: ...", // 24
  "    @tx.overload", // 25
  "    @staticmethod", // 26
  "    def blend(a: str) -> str: ...", // 27
  "    @staticmethod", // 28
  "    def blend(a):", // 29
  "        return a", // 30
  "", // 31
  "    def swatch(self):", // 32
  "        return self.mix(tint(1))", // 33
);

const EASEL = lines("from paint.stencil import tint", "", "", "def sketch():", "    return tint(2)");

const FILES = { "paint/__init__.py": "", "paint/stencil.py": STENCIL, "paint/easel.py": EASEL };

const WAYS: [string, LinkWay, string][] = [
  ["way A, the built-in rules", "built-in", "a"],
  ["way B, pyright", "language-tool", "b"],
];

for (const [title, way, layer] of WAYS) {
  describe(`overload stubs are one function: ${title}`, () => {
    test("the stubs give no nodes; the one definition that runs is the node", async () => {
      const db = await built(FILES, way, layer);
      expect(nodes(db, layer, "paint/stencil.py")).toEqual([
        { name: "tint", kind: "function", start: 10, end: 11 },
        { name: "Palette", kind: "type", start: 14, end: 33 },
        { name: "Palette.mix", kind: "method", start: 19, end: 20 },
        { name: "Palette.blend", kind: "method", start: 28, end: 30 },
        { name: "Palette.swatch", kind: "method", start: 32, end: 33 },
      ]);
      db.close();
    });

    test("a call links to the definition that runs: across files, in its file, and on the object itself", async () => {
      const db = await built(FILES, way, layer);
      expect(callsOf(db, layer, "paint/easel.py:sketch")).toEqual([{ name: "tint", line: 5, dst: "paint/stencil.py:tint", dst_start: 10, state: "linked" }]);
      expect(callsOf(db, layer, "paint/stencil.py:Palette.swatch")).toEqual([
        { name: "mix", line: 33, dst: "paint/stencil.py:Palette.mix", dst_start: 19, state: "linked" },
        { name: "tint", line: 33, dst: "paint/stencil.py:tint", dst_start: 10, state: "linked" },
      ]);
      db.close();
    });

    // Stubs with no definition after them, as in a `Protocol`, are one node together: a method
    // with only a declaration, held by its class. A call the rules prove reaches it links to it.
    test("stubs with no definition after them are one node together, held by its class, and a call links to it", async () => {
      const db = await built(
        {
          "loom/__init__.py": "",
          "loom/thread.py": lines(
            "from typing import Protocol, overload", // 1
            "import typing as ty", // 2
            "", // 3
            "", // 4
            "class Spool(Protocol):", // 5
            "    @overload", // 6
            "    def wind(self, n: int) -> int: ...", // 7
            "    @overload", // 8
            "    def wind(self, n: str) -> str: ...", // 9
            "", // 10
            "    def twist(self) -> int:", // 11
            "        return self.wind(3)", // 12
            "", // 13
            "", // 14
            "class Bobbin(Spool):", // 15
            "    def turn(self) -> int:", // 16
            "        return self.wind(4)", // 17
            "", // 18
            "", // 19
            "@ty.overload", // 20
            "def knot(a: int) -> int: ...", // 21
            "@ty.overload", // 22
            "def knot(a: str) -> str: ...", // 23
          ),
          "loom/frame.py": lines("from loom.thread import Spool", "", "", "def weave(s: Spool) -> int:", "    return s.wind(5)"),
        },
        way,
        layer,
      );
      expect(nodes(db, layer, "loom/thread.py")).toEqual([
        { name: "Spool", kind: "type", start: 5, end: 12 },
        { name: "Spool.wind", kind: "method", start: 6, end: 9 },
        { name: "Spool.twist", kind: "method", start: 11, end: 12 },
        { name: "Bobbin", kind: "type", start: 15, end: 17 },
        { name: "Bobbin.turn", kind: "method", start: 16, end: 17 },
        { name: "knot", kind: "function", start: 20, end: 23 },
      ]);
      const parent = db.query(`SELECT p.qualified_name AS name FROM symbols s JOIN symbols p ON p.id = s.parent_id WHERE s.layer = ? AND s.path = 'loom/thread.py' AND s.qualified_name = 'Spool.wind'`).get(layer) as { name: string } | null;
      expect(parent?.name).toBe("Spool");
      // On the object itself, in its class and in a class that inherits it: both ways prove it.
      expect(callsOf(db, layer, "loom/thread.py:Spool.twist")).toEqual([{ name: "wind", line: 12, dst: "loom/thread.py:Spool.wind", dst_start: 6, state: "linked" }]);
      expect(callsOf(db, layer, "loom/thread.py:Bobbin.turn")).toEqual([{ name: "wind", line: 17, dst: "loom/thread.py:Spool.wind", dst_start: 6, state: "linked" }]);
      // On a parameter whose type is written: the language's tool proves it; the built-in rules do not.
      expect(callsOf(db, layer, "loom/frame.py:weave")).toEqual([
        way === "language-tool"
          ? { name: "wind", line: 5, dst: "loom/thread.py:Spool.wind", dst_start: 6, state: "linked" }
          : { name: "wind", line: 5, dst: null, dst_start: null, state: "not_known" },
      ]);
      db.close();
    });

    test("a decorator that only shares the name is not typing's: each of its definitions stays a node", async () => {
      const db = await built(
        {
          "kiln/glaze.py": lines(
            "from kiln.marks import overload", // 1
            "", // 2
            "", // 3
            "@overload", // 4
            "def fire(t: int) -> int: ...", // 5
            "@overload", // 6
            "def fire(t: str) -> str: ...", // 7
          ),
          "kiln/marks.py": lines("def overload(f):", "    return f"),
        },
        way,
        layer,
      );
      expect(nodes(db, layer, "kiln/glaze.py")).toEqual([
        { name: "fire", kind: "function", start: 4, end: 5 },
        { name: "fire", kind: "function", start: 6, end: 7 },
      ]);
      db.close();
    });
  });
}
