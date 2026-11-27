// Every call written in a function is in one of three states (trustmybot/tmb#252): linked to a
// definition of the repo; outside the repo, when the language's own lookup proves its name a
// built-in or an import from a package; or not known. The three counts add up to the calls
// written there, and a call in an unnamed function is that function's own and adds to the named
// function around it. The fixtures are small programs of their own; each count below is read off
// the rule, call by call, not off the graph's output.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GRAPH_SCHEMA_VERSION, openGraphDb } from "../../src/engine/graph/db.ts";
import { indexProject, openView } from "../../src/engine/graph/fresh.ts";
import { BUILTINS_FILE, builtinsText, pythonBuiltins } from "../../src/engine/graph/languages/python/builtins.gen.ts";
import { BUILTINS_PYTHON_VERSION } from "../../src/engine/graph/languages/python/builtins.ts";
import { GLOBALS_FILE, globalsText } from "../../src/engine/graph/languages/typescript/globals.gen.ts";
import { type CallCounts, callCounts, lookupSymbol } from "../../src/engine/graph/lookups.ts";
import { openProjectStore, writeSetting } from "../../src/engine/index.ts";
import type { Actor, Store } from "../../src/engine/store/index.ts";

setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };

let project: string;
let store: Store;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

async function build(files: Record<string, string>): Promise<{ db: Database; layer: string; close: () => void }> {
  for (const [file, text] of Object.entries({ ".gitignore": ".tmb/\n", ...files })) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  writeSetting(store, HUMAN, "base_branch", "main");
  // These test the built-in rules, so the repo names them; the default is the language's tool (trustmybot/tmb#337).
  writeSetting(store, HUMAN, "graph_links", "built-in");
  await indexProject(project, store, { rebuild: false });
  const view = await openView(project, store);
  return { db: view.db, layer: view.layer, close: () => view.db.close() };
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-call-states-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  store?.close();
  rmSync(project, { recursive: true, force: true });
});

const counts = (linked: number, outside: number, notKnown: number): CallCounts => ({ linked, outside, notKnown });

function card(db: Database, layer: string, name: string, file: string) {
  const [found] = lookupSymbol(db, layer, name, file).cards;
  if (!found) throw new Error(`no ${name} in ${file}`);
  return found;
}

/** The own counts of each unnamed function in `file`, in the order they are written. */
function unnamedCounts(db: Database, layer: string, file: string): CallCounts[] {
  const rows = db.query("SELECT id FROM symbols WHERE layer = ? AND path = ? AND unnamed = 1 ORDER BY start_line, id").all(layer, file) as { id: number }[];
  return rows.map((r) => callCounts(db, r.id));
}

describe("TypeScript", () => {
  const FILES: Record<string, string> = {
    "src/shapes.ts": ["export function surface(w: number, h: number) { return w * h; }", "export class Crate { open() { return 1; } }", "export function maker() { return () => 2; }", ""].join("\n"),
    // A script, with no import or export: its top-level names are globals of every script, so a
    // built-in of the same name is not proven to be the built-in.
    "src/legacy.js": "function queueMicrotask(cb) { cb(); }\n",
    "src/use.ts": [
      'import { surface, Crate, maker } from "./shapes.ts";',
      'import * as nodePath from "node:path";',
      'import paint from "some-painter";',
      'import { tally } from "some-counter";',
      'import { gone } from "./nowhere.ts";',
      "export function measure(items: number[]) {",
      "  surface(2, 3);", // linked
      "  new Crate();", // linked
      "  Math.max(1, 2);", // outside: Math is a global and declares max
      '  parseFloat("4");', // outside: a global
      '  nodePath.join("a", "b");', // outside: called on an import of a package
      '  paint("x");', // outside: a default import of a package
      "  tally(items);", // outside: a named import of a package
      "  gone();", // not known: a relative import names the repo's own code
      "  items.map((n) => Math.abs(n));", // items.map: not known, no receiver type is guessed; Math.abs is the arrow's own
      "  maker()();", // maker(): linked; the call of its result: not known
      "  queueMicrotask(() => {});", // not known: a script of the repo declares that name at its top
      "}",
      "export function shadowed(parseFloat: (s: string) => number) {",
      '  return parseFloat("1");', // not known: the parameter is not the global
      "}",
      "const Reflect = { own() { return 0; } };",
      "export function fileShadow() {",
      "  return Reflect.own();", // not outside: the file declares Reflect
      "}",
      "export function notAMember() {",
      "  return Math.nothingSuch();", // not known: the global declares no such member
      "}",
      "",
    ].join("\n"),
  };

  test("each call is linked, outside or not known, and the three add up to the calls written", async () => {
    const { db, layer, close } = await build(FILES);
    try {
      const measure = card(db, layer, "measure", "src/use.ts");
      // 12 calls written in measure and 1 in its arrow: 3 linked, 6 outside, 4 not known.
      expect(measure.calls).toEqual(counts(3, 6, 4));
      expect(measure.callsNote).toBe("Calls not known: 4 of 13. The graph could not prove where they go; search its body by text for them.");
      expect(card(db, layer, "shadowed", "src/use.ts").calls).toEqual(counts(0, 0, 1));
      const fileShadow = card(db, layer, "fileShadow", "src/use.ts").calls;
      expect(fileShadow.outside).toBe(0);
      expect(fileShadow.linked + fileShadow.notKnown).toBe(1);
      expect(card(db, layer, "notAMember", "src/use.ts").calls).toEqual(counts(0, 0, 1));
      expect(card(db, layer, "surface", "src/shapes.ts").calls).toEqual(counts(0, 0, 0));
      expect(card(db, layer, "surface", "src/shapes.ts").callsNote).toBeUndefined();
    } finally {
      close();
    }
  });

  test("a call in an unnamed function counts in that function's own counts", async () => {
    const { db, layer, close } = await build(FILES);
    try {
      // The arrows of use.ts, in order: `(n) => Math.abs(n)`, then `() => {}`.
      expect(unnamedCounts(db, layer, "src/use.ts")).toEqual([counts(0, 1, 0), counts(0, 0, 0)]);
    } finally {
      close();
    }
  });
});

describe("Python", () => {
  const FILES: Record<string, string> = {
    "pkg/__init__.py": "",
    "pkg/geometry.py": "def surface(w, h):\n    return w * h\n",
    // A module of the repo, found from any folder: an import of it is not proven a package.
    "lib/helpers.py": "def go():\n    return 1\n",
    "pkg/use.py": [
      "import os",
      "import json as j",
      "from collections import OrderedDict",
      "from .geometry import surface",
      "import helpers",
      "",
      "def measure(items):",
      "    surface(2, 3)", // linked
      "    len(items)", // outside: a builtin
      "    os.getcwd()", // outside: called on an import of a package
      "    j.dumps({})", // outside: an import bound under another name
      "    OrderedDict()", // outside: a name imported from a package
      "    items.append(1)", // not known: no receiver type is guessed
      "    helpers.go()", // not outside: the repo has a helpers module
      '    "x".join([])', // not known: called on no name
      "    sorted(items, key=lambda v: abs(v))", // sorted and abs: outside; a lambda is no function of its own here, so abs is measure's
      "    str.upper('a')", // outside: the builtin str has a callable upper
      "    dict.nothing_such()", // not known: the builtin has no such attribute
      "",
      "def own_open(path):",
      "    def open(p):",
      "        return p",
      "    return open(path)", // linked or not known, never outside: the function binds open
      "",
      "class Shelf:",
      "    len = 3",
      "    size = len([1])", // not outside: the class body binds len before the builtins
      "",
    ].join("\n"),
    "pkg/starred.py": ["from os.path import *", "", "def uses():", "    return len([])", ""].join("\n"), // not outside: the star may bind len
  };

  test("each call is linked, outside or not known, and the three add up to the calls written", async () => {
    const { db, layer, close } = await build(FILES);
    try {
      const measure = card(db, layer, "measure", "pkg/use.py").calls;
      // 12 calls: surface linked; len, os.getcwd, j.dumps, OrderedDict, sorted, abs, str.upper
      // outside; items.append, "x".join, dict.nothing_such not known; helpers.go linked or not known.
      expect(measure.outside).toBe(7);
      expect(measure.linked + measure.outside + measure.notKnown).toBe(12);
      expect(measure.notKnown).toBeGreaterThanOrEqual(3);
      const ownOpen = card(db, layer, "own_open", "pkg/use.py").calls;
      expect(ownOpen.outside).toBe(0);
      expect(ownOpen.linked + ownOpen.notKnown).toBe(1);
      const shelf = card(db, layer, "Shelf", "pkg/use.py").calls;
      expect(shelf.outside).toBe(0);
      expect(shelf.linked + shelf.notKnown).toBe(1);
      expect(card(db, layer, "uses", "pkg/starred.py").calls).toEqual(counts(0, 0, 1));
    } finally {
      close();
    }
  });
});

describe("the built-in lists", () => {
  test("the TypeScript globals are what the compiler's default library declares", () => {
    expect(readFileSync(GLOBALS_FILE, "utf8")).toBe(globalsText());
  });

  const builtins = pythonBuiltins();
  const same = builtins !== null && builtins.version === BUILTINS_PYTHON_VERSION;
  // The list follows one Python version; another version, or none on PATH, cannot check it.
  test.skipIf(!same)(`the Python builtins are what Python ${BUILTINS_PYTHON_VERSION}'s builtins module holds (skipped without that Python on PATH)`, () => {
    expect(readFileSync(BUILTINS_FILE, "utf8")).toBe(builtinsText(builtins!));
  });
});

describe("schema", () => {
  test("a graph of schema 5 gains the call state column and keeps its edges", () => {
    const dir = path.join(project, ".tmb");
    mkdirSync(dir, { recursive: true });
    // Open once to learn the file's place, then wind it back to schema 5 without the column.
    openGraphDb(project).close();
    const file = path.join(dir, "graph.db");
    const old = new Database(file);
    old.run("ALTER TABLE edges DROP COLUMN call_state");
    old.run("PRAGMA user_version = 5");
    old.close();
    const db = openGraphDb(project);
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(GRAPH_SCHEMA_VERSION);
      expect(db.query("SELECT 1 FROM pragma_table_info('edges') WHERE name = 'call_state'").get()).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
