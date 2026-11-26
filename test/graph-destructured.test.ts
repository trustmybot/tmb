// A name a destructuring binds at file level is file-level data (CODE_GRAPH.md, "Kinds of symbol";
// trustmybot/tmb#322), in every language that destructures: TypeScript and JavaScript's object and
// array patterns, with a new name, a rest and a nested pattern; Python's target lists, `a, b = …`,
// `(a, b) = …` and `[a, *b] = …`, nested too. Each name is its own node, and its lines are its
// whole declaration, so the names of one declaration share its lines. A name bound inside a
// function is a local and no node.
//
// Calls to such a name link only on proof ("Two ways to make links"): way B links a call when the
// compiler's declaration is a node of the graph, which such a binding now is. Way A links a call to
// such a name too when the file's own scope or an import proves it (trustmybot/tmb#332), and links
// its import to the node it imports. The fixtures use names of their own; each expectation is read
// off the page, not off the graph's output.
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
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-destructured-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

type Node = { kind: string; qualified_name: string; start_line: number; end_line: number };
type EdgeRow = { src: string; dst_name: string; kind: string; dst: string | null; call_state: string | null };

function nodesOf(db: Database, layer: string, file: string): Node[] {
  return db
    .query("SELECT kind, qualified_name, start_line, end_line FROM symbols WHERE layer = ? AND path = ? AND kind != 'module' ORDER BY start_line, qualified_name")
    .all(layer, file) as Node[];
}

function edgesOf(db: Database, layer: string): EdgeRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name, e.kind, d.path || ':' || d.qualified_name AS dst, e.call_state
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id WHERE e.layer = ?`,
    )
    .all(layer) as EdgeRow[];
}

/** The one call named `name` that `src` makes. */
function call(rows: EdgeRow[], src: string, name: string): EdgeRow {
  const found = rows.filter((r) => r.src === src && r.dst_name === name && r.call_state !== null);
  if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}`);
  return found[0]!;
}

/** The import of `name` that `file` makes. */
function imported(rows: EdgeRow[], file: string, name: string): EdgeRow {
  const found = rows.filter((r) => r.src.startsWith(`${file}:`) && r.kind === "imports" && r.dst_name === name);
  if (found.length !== 1) throw new Error(`${found.length} imports of ${name} in ${file}`);
  return found[0]!;
}

// Object, renamed, rest, array and nested patterns at file level; the same shapes inside a function.
const TS_FILES = {
  "src/forge.ts": lines(
    "export function supply() {", //                                         1
    "  return { ignite: () => 1, quench: () => 2, heat: 3, core: { spark: () => 4 } };", // 2
    "}", //                                                                  3
    "export function twin(): [() => number, () => number] {", //            4
    "  return [() => 5, () => 6];", //                                       5
    "}", //                                                                  6
    "export const {", //                                                     7
    "  ignite,", //                                                          8
    "  quench: douse,", //                                                   9
    "  ...spare", //                                                         10
    "} = supply();", //                                                      11
    "export const [lefty, righty] = twin();", //                             12
    "const {", //                                                            13
    "  core: { spark },", //                                                 14
    "} = supply();", //                                                      15
    "export function smith(): number {", //                                  16
    "  const { ignite: ownIgnite } = supply();", //                          17
    "  const [ownLefty] = twin();", //                                       18
    "  return ignite() + douse() + lefty() + spark() + ownIgnite() + ownLefty();", // 19
    "}", //                                                                  20
  ),
  "src/anvil.ts": lines(
    'import { ignite, douse as snuff, lefty } from "./forge";', //          1
    "export function strike(): number {", //                                 2
    "  return ignite() + snuff() + lefty();", //                             3
    "}", //                                                                  4
  ),
};

const PY_FILES = {
  "kiln/__init__.py": "",
  "kiln/glaze.py": lines(
    "def fire():", //                         1
    "    return 1, 2", //                     2
    "", //                                    3
    "", //                                    4
    "amber, umber = fire()", //               5
    "(ochre, sienna) = fire()", //            6
    "[sepia, *others] = fire()", //           7
    "tint, (hue, shade) = 1, (2, 3)", //      8
    "holder.slot, plain = 1, 2", //           9
    "(", //                                   10
    "    cobalt,", //                         11
    "    teal,", //                           12
    ") = fire()", //                          13
    "", //                                    14
    "", //                                    15
    "def paint():", //                        16
    "    own_a, own_b = fire()", //           17
    "    return amber", //                    18
  ),
  "kiln/pot.py": lines("from kiln.glaze import amber, others", "", "", "def throw():", "    return amber"),
};

const data = (name: string, start: number, end: number): Node => ({ kind: "const", qualified_name: name, start_line: start, end_line: end });

describe("TypeScript and JavaScript", () => {
  async function bothWays() {
    const sha = commit(TS_FILES);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, "a", { force: true });
    await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
    return db;
  }

  test("each name a file-level destructuring binds is a data node spanning the whole declaration", async () => {
    const db = await bothWays();
    const data_ = nodesOf(db, "a", "src/forge.ts").filter((n) => n.kind === "const");
    expect(data_).toEqual([data("douse", 7, 11), data("ignite", 7, 11), data("spare", 7, 11), data("lefty", 12, 12), data("righty", 12, 12), data("spark", 13, 15)]);
    db.close();
  });

  test("a key that is renamed or holds a nested pattern binds nothing, and a destructuring inside a function makes no node", async () => {
    const db = await bothWays();
    // The object `supply` returns holds functions named `ignite` and `quench`: those are its own nodes.
    const names = nodesOf(db, "a", "src/forge.ts")
      .filter((n) => n.kind === "const")
      .map((n) => n.qualified_name);
    for (const none of ["quench", "core", "ownIgnite", "ownLefty"]) expect(names).not.toContain(none);
    db.close();
  });

  test("both ways make the same nodes", async () => {
    const db = await bothWays();
    for (const file of Object.keys(TS_FILES)) expect(nodesOf(db, "b", file)).toEqual(nodesOf(db, "a", file));
    db.close();
  });

  test("way B links a call whose declaration is the binding, in its file and through an import, a renamed one included", async () => {
    const db = await bothWays();
    const b = edgesOf(db, "b");
    expect(call(b, "src/forge.ts:smith", "ignite")).toMatchObject({ dst: "src/forge.ts:ignite", call_state: "linked" });
    expect(call(b, "src/forge.ts:smith", "douse")).toMatchObject({ dst: "src/forge.ts:douse", call_state: "linked" });
    expect(call(b, "src/forge.ts:smith", "lefty")).toMatchObject({ dst: "src/forge.ts:lefty", call_state: "linked" });
    expect(call(b, "src/forge.ts:smith", "spark")).toMatchObject({ dst: "src/forge.ts:spark", call_state: "linked" });
    expect(call(b, "src/anvil.ts:strike", "ignite")).toMatchObject({ dst: "src/forge.ts:ignite", call_state: "linked" });
    expect(call(b, "src/anvil.ts:strike", "douse")).toMatchObject({ dst: "src/forge.ts:douse", call_state: "linked" });
    expect(call(b, "src/anvil.ts:strike", "lefty")).toMatchObject({ dst: "src/forge.ts:lefty", call_state: "linked" });
    db.close();
  });

  test("way B leaves a call of a local binding not known: its declaration is no node", async () => {
    const db = await bothWays();
    const b = edgesOf(db, "b");
    expect(call(b, "src/forge.ts:smith", "ownIgnite")).toMatchObject({ dst: null, call_state: "not_known" });
    expect(call(b, "src/forge.ts:smith", "ownLefty")).toMatchObject({ dst: null, call_state: "not_known" });
    db.close();
  });

  test("way A links the import of a destructured name to its node", async () => {
    const db = await bothWays();
    const a = edgesOf(db, "a");
    expect(imported(a, "src/anvil.ts", "ignite").dst).toBe("src/forge.ts:ignite");
    expect(imported(a, "src/anvil.ts", "douse").dst).toBe("src/forge.ts:douse");
    expect(imported(a, "src/anvil.ts", "lefty").dst).toBe("src/forge.ts:lefty");
    db.close();
  });

  test("way A links a call of a destructured name the file or an import proves, as way B does; a local binding stays not known", async () => {
    const db = await bothWays();
    const a = edgesOf(db, "a");
    for (const [src, name, dst] of [
      ["src/forge.ts:smith", "ignite", "src/forge.ts:ignite"],
      ["src/forge.ts:smith", "douse", "src/forge.ts:douse"],
      ["src/forge.ts:smith", "lefty", "src/forge.ts:lefty"],
      ["src/forge.ts:smith", "spark", "src/forge.ts:spark"],
      ["src/anvil.ts:strike", "ignite", "src/forge.ts:ignite"],
      ["src/anvil.ts:strike", "douse", "src/forge.ts:douse"],
      ["src/anvil.ts:strike", "lefty", "src/forge.ts:lefty"],
    ] as const) {
      expect(call(a, src, name)).toMatchObject({ dst, call_state: "linked" });
    }
    expect(call(a, "src/forge.ts:smith", "ownIgnite")).toMatchObject({ dst: null, call_state: "not_known" });
    db.close();
  });
});

describe("Python", () => {
  async function built() {
    const sha = commit(PY_FILES);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, "a", { force: true });
    return db;
  }

  test("each name a module-level target list binds is a data node spanning the whole statement", async () => {
    const db = await built();
    expect(nodesOf(db, "a", "kiln/glaze.py").filter((n) => n.kind === "const")).toEqual([
      data("amber", 5, 5),
      data("umber", 5, 5),
      data("ochre", 6, 6),
      data("sienna", 6, 6),
      data("others", 7, 7),
      data("sepia", 7, 7),
      data("hue", 8, 8),
      data("shade", 8, 8),
      data("tint", 8, 8),
      data("plain", 9, 9),
      data("cobalt", 10, 13),
      data("teal", 10, 13),
    ]);
    db.close();
  });

  test("an attribute target binds no name, and a target list inside a function makes no node", async () => {
    const db = await built();
    const names = nodesOf(db, "a", "kiln/glaze.py").map((n) => n.qualified_name);
    for (const none of ["holder.slot", "slot", "own_a", "own_b"]) expect(names).not.toContain(none);
    db.close();
  });

  test("an import of a destructured name links to its node", async () => {
    const db = await built();
    const a = edgesOf(db, "a");
    expect(imported(a, "kiln/pot.py", "amber").dst).toBe("kiln/glaze.py:amber");
    expect(imported(a, "kiln/pot.py", "others").dst).toBe("kiln/glaze.py:others");
    db.close();
  });
});
