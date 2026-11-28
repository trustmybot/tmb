// Two ways to make links (trustmybot/tmb#311). The language's tool (way B) is the default
// (trustmybot/tmb#337); a repo whose `graph_links` setting is `language-tool`, set or by default,
// has its TypeScript and JavaScript calls linked by the TypeScript compiler, which is asked and
// never imitated:
// - linked, to each node of the graph among the callee's declarations the language proves it can go to;
// - outside, when every declaration is outside the repo (the compiler's lib, an installed package);
// - not known, when there is no answer or the declaration is no node, such as a parameter.
// Both ways make the same nodes; each link records the way that made it. A repo whose compiler
// cannot run is built by the built-in rules, and the layer says why. The fixtures are small
// programs of their own; each expectation is read off the rule, not off the graph's output.
import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts5 from "typescript5";
import type TS from "typescript5";
import { buildLayer } from "../../../../src/engine/graph/build.ts";
import { BASE_LAYER, GRAPH_SCHEMA_VERSION, graphDbPath, layerRow, openGraphDb } from "../../../../src/engine/graph/db.ts";
import { indexProject, openView } from "../../../../src/engine/graph/fresh.ts";
import { baseOptions, commitProgram } from "../../../../src/engine/graph/languages/typescript/compiler.ts";
import { openProjectStore, writeSetting } from "../../../../src/engine/index.ts";
import { graphLinksOf, readSettings, validateSetting } from "../../../../src/engine/settings.ts";
import type { Actor, Store } from "../../../../src/engine/store/index.ts";
import { installPinnedTools } from "../../../lib/pinned-tools.ts";
import { git } from "../../../lib/git.ts";

setDefaultTimeout(30_000);

// Way B loads the TypeScript compiler from tmb's tools folder; the setup installs tmb's pinned copy.
beforeAll(installPinnedTools);

const HUMAN: Actor = { kind: "human" };

let project: string;
let store: Store | undefined;

function write(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
}

/** Commits the files, and writes the untracked ones (installed packages) beside them. */
function commit(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  write({ ".gitignore": ".tmb/\nnode_modules/\n", ...files });
  write(untracked);
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  return git(project, "rev-parse", "HEAD");
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-link-ways-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  store?.close();
  store = undefined;
  rmSync(project, { recursive: true, force: true });
});

type EdgeRow = { src: string; dst_name: string; line: number; kind: string; dst: string | null; resolution: string; call_state: string | null; way: string | null };

function edges(db: Database, layer: string): EdgeRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name, e.line, e.kind, d.path || ':' || d.qualified_name AS dst, e.resolution, e.call_state, e.way
       FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
       WHERE e.layer = ? ORDER BY s.path, e.line, e.dst_name, e.kind`,
    )
    .all(layer) as EdgeRow[];
}

function nodes(db: Database, layer: string): unknown[] {
  return db.query("SELECT path, kind, qualified_name, start_line, end_line FROM symbols WHERE layer = ? ORDER BY path, start_line, qualified_name, kind").all(layer);
}

/** The call named `name` that `src` makes. */
function call(rows: EdgeRow[], src: string, name: string): EdgeRow {
  const found = rows.filter((r) => r.src === src && r.dst_name === name && r.call_state !== null);
  if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}`);
  return found[0]!;
}

// The page's first example: a value whose class only its type says. The built-in rules do not
// follow a function's return type; the compiler does.
const CART = {
  "src/cart.ts": ["export class Cart {", "  total(): number {", "    return 1;", "  }", "}", "export function makeCart(): Cart {", "  return new Cart();", "}", ""].join("\n"),
  "src/use.ts": [
    'import { makeCart } from "./cart";',
    'import { pad } from "padder";',
    "export function checkout(): number {",
    "  const c = makeCart();",
    "  return c.total();",
    "}",
    "export function decode(text: string): unknown {",
    "  return JSON.parse(text);",
    "}",
    "export function apply(f: () => number): number {",
    "  return f();",
    "}",
    "export function padded(): string {",
    '  return pad("x");',
    "}",
    "",
  ].join("\n"),
};
// An installed package, which git does not hold.
const PADDER = {
  "node_modules/padder/package.json": JSON.stringify({ name: "padder", version: "1.0.0", types: "index.d.ts" }),
  "node_modules/padder/index.d.ts": "export declare function pad(s: string): string;\n",
};

async function bothWays(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const sha = commit(files, untracked);
  const db = openGraphDb(project, null);
  await buildLayer(db, project, sha, "a", { force: true });
  const b = await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
  return { db, a: edges(db, "a"), b: edges(db, "b"), stats: b };
}

describe("way B, the TypeScript compiler", () => {
  test("links a call on a value whose class only its type says; the built-in rules do not", async () => {
    const { db, a, b } = await bothWays(CART, PADDER);
    expect(call(b, "src/use.ts:checkout", "total")).toMatchObject({ dst: "src/cart.ts:Cart.total", resolution: "exact", call_state: "linked", way: "language-tool" });
    expect(call(a, "src/use.ts:checkout", "total").dst).not.toBe("src/cart.ts:Cart.total");
    expect(call(b, "src/use.ts:checkout", "makeCart")).toMatchObject({ dst: "src/cart.ts:makeCart", call_state: "linked", way: "language-tool" });
    expect(call(b, "src/cart.ts:makeCart", "Cart")).toMatchObject({ dst: "src/cart.ts:Cart", call_state: "linked", way: "language-tool" });
    db.close();
  });

  test("a call of the compiler's lib or of an installed package is outside", async () => {
    const { db, b } = await bothWays(CART, PADDER);
    expect(call(b, "src/use.ts:decode", "parse")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    expect(call(b, "src/use.ts:padded", "pad")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    db.close();
  });

  test("a call of a parameter is not known: the declaration is no node", async () => {
    const { db, b } = await bothWays(CART, PADDER);
    expect(call(b, "src/use.ts:apply", "f")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    db.close();
  });

  test("a call the compiler cannot answer is not known, never a guess", async () => {
    const { db, b } = await bothWays({
      "src/loose.js": ["export function run(thing) {", "  return thing.spin();", "}", "export function spin() {", "  return 1;", "}", ""].join("\n"),
    });
    expect(call(b, "src/loose.js:run", "spin")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    db.close();
  });

  test("a function holding a function of its own name links to itself, the one that starts where its declaration does", async () => {
    const { db, b } = await bothWays({
      "src/wrap.ts": ["export const wrap = (n: number) => {", "  return function wrap() {", "    return n;", "  };", "};", ""].join("\n"),
      "src/main.ts": ['import { wrap } from "./wrap";', "export function main() {", "  return wrap(1);", "}", ""].join("\n"),
    });
    expect(call(b, "src/main.ts:main", "wrap")).toMatchObject({ dst: "src/wrap.ts:wrap", call_state: "linked", way: "language-tool" });
    const target = db.query("SELECT d.start_line AS start FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id WHERE e.layer = 'b' AND s.path = 'src/main.ts' AND e.dst_name = 'wrap' AND e.call_state = 'linked'").get();
    expect(target).toEqual({ start: 1 });
    db.close();
  });

  // A call is identified by its position in the file (CODE_GRAPH.md, "Two ways to make links"),
  // so two calls of one name on one line each get the compiler's own answer.
  const APPLIANCES = {
    "src/appliances.ts": [
      "export class Kettle {",
      "  switchOn(): number {",
      "    return 1;",
      "  }",
      "}",
      "export class Lamp {",
      "  switchOn(): number {",
      "    return 2;",
      "  }",
      "}",
      "export class Door {",
      "  open(): Hall {",
      "    return new Hall();",
      "  }",
      "}",
      "export class Hall {",
      "  open(): number {",
      "    return 3;",
      "  }",
      "}",
      "export function kettle(): Kettle {",
      "  return new Kettle();",
      "}",
      "export function lamp(): Lamp {",
      "  return new Lamp();",
      "}",
      "export function door(): Door {",
      "  return new Door();",
      "}",
      "export async function pour<T>(): Promise<number> {",
      "  return 4;",
      "}",
      "",
    ].join("\n"),
    "src/morning.ts": [
      'import { door, type Kettle, kettle, lamp, pour } from "./appliances";',
      "export function wake(): number {",
      "  const k = kettle();",
      "  const l = lamp();",
      "  return k.switchOn() + l.switchOn();",
      "}",
      "export function enter(): number {",
      "  return door().open().open();",
      "}",
      "export async function brew(ready: boolean, k?: Kettle): Promise<number> {",
      "  return (ready && k!.switchOn() ? 1 : 0) + (await pour<number>());",
      "}",
      "",
    ].join("\n"),
  };
  const byDst = (x: { dst: string | null }, y: { dst: string | null }) => String(x.dst).localeCompare(String(y.dst));

  // "Kinds of symbol": a name bound by a loop, a block or a catch at the top of a file is a local,
  // which is no node, though a function of that name is written on its lines.
  test("a call of a name a loop, a block or a catch binds at the top of a file is not known: the declaration is a local", async () => {
    const { db, b } = await bothWays({
      "src/top.ts": [
        "for (const run of [function run() { return 1; }]) run();",
        "{ const go = [function go() { return 2; }][0]!; go(); }",
        "try { JSON.parse(''); } catch ({ fail = function fail() { return 3; } }) { fail(); }",
        "",
      ].join("\n"),
    });
    for (const name of ["run", "go", "fail"]) expect(call(b, "src/top.ts:src/top.ts", name)).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    db.close();
  });

  test("two calls of one name on one line, on values of two classes, each link to their own class's method", async () => {
    const { db, b } = await bothWays(APPLIANCES);
    const calls = b.filter((r) => r.src === "src/morning.ts:wake" && r.dst_name === "switchOn");
    expect(calls.map((r) => ({ dst: r.dst, call_state: r.call_state, way: r.way })).sort(byDst)).toEqual([
      { dst: "src/appliances.ts:Kettle.switchOn", call_state: "linked", way: "language-tool" },
      { dst: "src/appliances.ts:Lamp.switchOn", call_state: "linked", way: "language-tool" },
    ]);
    db.close();
  });

  test("two calls of one name that start at one place, a call on a call's result, each link to their own declaration", async () => {
    const { db, b } = await bothWays(APPLIANCES);
    const calls = b.filter((r) => r.src === "src/morning.ts:enter" && r.dst_name === "open");
    expect(calls.map((r) => ({ dst: r.dst, call_state: r.call_state })).sort(byDst)).toEqual([
      { dst: "src/appliances.ts:Door.open", call_state: "linked" },
      { dst: "src/appliances.ts:Hall.open", call_state: "linked" },
    ]);
    db.close();
  });

  test("a call whose operators the parsers group otherwise is still found by where its name is written", async () => {
    // `await f<T>()` and `a && b!.f()`: the language binds the call tighter than the operator around
    // it, and the built-in parser does not, so the two parsers start the call at other places.
    const { db, b } = await bothWays(APPLIANCES);
    const calls = b.filter((r) => r.src === "src/morning.ts:brew").map((r) => ({ name: r.dst_name, dst: r.dst, call_state: r.call_state }));
    expect(calls.sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "pour", dst: "src/appliances.ts:pour", call_state: "linked" },
      { name: "switchOn", dst: "src/appliances.ts:Kettle.switchOn", call_state: "linked" },
    ]);
    db.close();
  });

  test("each call records its position, the offset where the name it calls is written; a reference that is no call records none", async () => {
    const { db } = await bothWays(APPLIANCES);
    const text = APPLIANCES["src/morning.ts"];
    const wake = text.indexOf("function wake");
    const first = text.indexOf("switchOn", wake);
    const second = text.indexOf("switchOn", first + 1);
    const line = text.slice(0, first).split("\n").length;
    for (const layer of ["a", "b"]) {
      const rows = db
        .query("SELECT e.line AS line, e.pos AS pos FROM edges e JOIN symbols s ON s.id = e.src_id WHERE e.layer = ? AND s.path = 'src/morning.ts' AND s.qualified_name = 'wake' AND e.dst_name = 'switchOn' ORDER BY e.pos")
        .all(layer);
      expect(rows).toEqual([
        { line, pos: first },
        { line, pos: second },
      ]);
      const notCalls = db.query("SELECT count(*) AS n FROM edges WHERE layer = ? AND call_state IS NULL AND pos IS NOT NULL").get(layer);
      expect(notCalls).toEqual({ n: 0 });
    }
    db.close();
  });

  test("both ways make the same nodes", async () => {
    const { db } = await bothWays(CART, PADDER);
    expect(nodes(db, "b")).toEqual(nodes(db, "a"));
    db.close();
  });

  test("each link records its way; references that are no call keep the built-in rules' links", async () => {
    const { db, a, b } = await bothWays(CART, PADDER);
    expect(new Set(a.map((r) => r.way))).toEqual(new Set(["built-in"]));
    for (const r of b) expect(r.way).toBe(r.call_state === null ? "built-in" : "language-tool");
    expect(b.filter((r) => r.call_state === null)).toEqual(a.filter((r) => r.call_state === null));
    db.close();
  });

  test("a language with no tool is built by the built-in rules, and the layer says so", async () => {
    const { db, a, b, stats } = await bothWays({ ...CART, "tools/run.sh": "go() {\n  wc -l\n}\nstart() {\n  go\n}\n" });
    const sh = (rows: EdgeRow[]) => rows.filter((r) => r.src.startsWith("tools/"));
    expect(sh(b)).toEqual(sh(a));
    expect(stats.links).toBe("language-tool");
    expect(stats.linksNote).toContain("bash: no language tool");
    expect(layerRow(db, "b")?.links_note).toBe(stats.linksNote);
    db.close();
  });
});

describe("the setting", () => {
  test("built-in, set or not, changes nothing", async () => {
    const sha = commit(CART, PADDER);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, "unset", { force: true });
    const stats = await buildLayer(db, project, sha, "set", { force: true, links: "built-in" });
    expect(edges(db, "set")).toEqual(edges(db, "unset"));
    expect(stats).toMatchObject({ links: "built-in", linksNote: null });
    expect(layerRow(db, "set")).toMatchObject({ links: "built-in", links_note: null });
    db.close();
  });

  test("graph_links takes built-in or language-tool, for the workspace and for one repo", () => {
    expect(validateSetting("graph_links", "language-tool")).toBe("language-tool");
    expect(validateSetting("graph_links", "built-in")).toBe("built-in");
    expect(() => validateSetting("graph_links", "B")).toThrow("graph links must be built-in or language-tool");
    expect(validateSetting("repos", { web: { base_branch: "main", graph_links: "language-tool" } })).toEqual({ web: { base_branch: "main", graph_links: "language-tool" } });
    expect(() => validateSetting("repos", { web: { base_branch: "main", graph_links: "A" } })).toThrow("graph links must be");
  });

  // The default itself, with nothing set, is in "the default way" below (trustmybot/tmb#337).
  test("a repo's own graph_links wins over the workspace's, which wins over the default", () => {
    const none = { host: null, host_roles: null, base_branch: null, review_mode: null, checks: null, shared_folders: null, graph_links: null, repos: null, issue_sync: null } as const;
    expect(graphLinksOf({ ...none, graph_links: "language-tool" }, "web")).toBe("language-tool");
    expect(graphLinksOf({ ...none, graph_links: "language-tool", repos: { web: { base_branch: "main", graph_links: "built-in" } }, issue_sync: null }, "web")).toBe("built-in");
    expect(graphLinksOf({ ...none, repos: { web: { base_branch: "main", graph_links: "language-tool" } } }, "web")).toBe("language-tool");
  });
});

describe("the compiler tmb uses", () => {
  // tmb uses its own copy of the TypeScript compiler, at its pin, in its tools folder (CODE_GRAPH.md,
  // "Where a language's tool comes from"), never the repo's own. The repo's installed
  // packages are still read from its working tree; without them a package call is not known, never
  // guessed to be outside. Each repo here is indexed the way the program indexes it, with no
  // compiler passed in.
  async function indexed(setting: "built-in" | "language-tool" | null) {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    store = opened.store;
    writeSetting(store, HUMAN, "base_branch", "main");
    if (setting !== null) writeSetting(store, HUMAN, "graph_links", setting);
    await indexProject(project, store, { rebuild: false });
    const view = await openView(project, store);
    return view;
  }

  // A repo with a call way A cannot link: a method on a value a function returns.
  const SHOP = {
    "lib/basket.ts": ["export class Basket {", "  weigh(): number {", "    return 2;", "  }", "}", "export function fill(): Basket {", "  return new Basket();", "}", ""].join("\n"),
    "lib/till.ts": [
      'import { fill } from "./basket";',
      'import { round } from "rounding";',
      'import money from "money-kit";',
      "export function ring(): number {",
      "  return fill().weigh();",
      "}",
      "export function rounded(n: number): number {",
      "  return round(n);",
      "}",
      "export function priced(): string {",
      "  return money.format(1);",
      "}",
      "export function stamp(): string {",
      "  return new Date(0).toISOString();",
      "}",
      "",
    ].join("\n"),
  };

  test("with no installed packages and no compiler in the repo, tmb's copy of the compiler makes the links", async () => {
    commit(SHOP);
    const view = await indexed("language-tool");
    expect(view.freshness.links).toEqual({ way: "language-tool", note: null });
    const rows = edges(view.db, view.layer);
    expect(call(rows, "lib/till.ts:ring", "weigh")).toMatchObject({ dst: "lib/basket.ts:Basket.weigh", call_state: "linked", way: "language-tool" });
    expect(call(rows, "lib/till.ts:ring", "fill")).toMatchObject({ dst: "lib/basket.ts:fill", call_state: "linked", way: "language-tool" });
    // The language's built-ins come with tmb's copy of the compiler.
    expect(call(rows, "lib/till.ts:stamp", "toISOString")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    view.db.close();
  });

  test("the built-in rules cannot link that call", async () => {
    commit(SHOP);
    const view = await indexed("built-in");
    expect(call(edges(view.db, view.layer), "lib/till.ts:ring", "weigh").dst).not.toBe("lib/basket.ts:Basket.weigh");
    view.db.close();
  });

  test("without the repo's installed packages, a package call is not known, never guessed to be outside", async () => {
    commit(SHOP);
    const view = await indexed("language-tool");
    const rows = edges(view.db, view.layer);
    expect(call(rows, "lib/till.ts:rounded", "round")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    expect(call(rows, "lib/till.ts:priced", "format")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    view.db.close();
  });

  test("the repo's installed packages are read from its working tree: a package call is outside", async () => {
    commit(SHOP, {
      "node_modules/rounding/package.json": JSON.stringify({ name: "rounding", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/rounding/index.d.ts": "export declare function round(n: number): number;\n",
    });
    const view = await indexed("language-tool");
    expect(call(edges(view.db, view.layer), "lib/till.ts:rounded", "round")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    view.db.close();
  });

  test("a typescript package the repo installs is never used, even one that would answer otherwise or fail", async () => {
    // A repo's own "typescript" that claims the program API at version 5 and throws when asked.
    commit(SHOP, {
      "node_modules/typescript/package.json": JSON.stringify({ name: "typescript", version: "5.0.0", main: "index.js" }),
      "node_modules/typescript/index.js": "module.exports = { version: '5.0.0', createProgram() { throw new Error('the repo\\'s own compiler was used'); } };\n",
      "node_modules/typescript/lib/lib.es5.d.ts": "declare var NotTheLibrary: number;\n",
    });
    const view = await indexed("language-tool");
    expect(view.freshness.links).toEqual({ way: "language-tool", note: null });
    const rows = edges(view.db, view.layer);
    expect(call(rows, "lib/till.ts:ring", "weigh")).toMatchObject({ dst: "lib/basket.ts:Basket.weigh", call_state: "linked", way: "language-tool" });
    expect(call(rows, "lib/till.ts:stamp", "toISOString")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    view.db.close();
  });

  test("a repo that installs the very compiler tmb pins reads its declarations as any installed package: its calls are outside", async () => {
    // The file is under no config, so the compiler's defaults hold: a default import of the
    // compiler's `export =` needs esModuleInterop, which they do not set, so the import is a namespace.
    commit({ "lib/parse.ts": ['import * as ts from "typescript";', "export function parse(text: string) {", '  return ts.createSourceFile("a.ts", text, ts.ScriptTarget.Latest);', "}", ""].join("\n") });
    // The repo's own typescript is the package at tmb's pin, installed where the repo installs packages.
    mkdirSync(path.join(project, "node_modules"), { recursive: true });
    symlinkSync(path.dirname(require.resolve("typescript5/package.json")), path.join(project, "node_modules", "typescript"), "dir");
    const view = await indexed("language-tool");
    expect(call(edges(view.db, view.layer), "lib/parse.ts:parse", "createSourceFile")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    view.db.close();
  });

  test("changing the setting rebuilds the layer the new way", async () => {
    commit(CART, PADDER);
    const first = await indexed("built-in");
    expect(first.freshness.links).toEqual({ way: "built-in", note: null });
    first.db.close();
    writeSetting(store!, HUMAN, "graph_links", "language-tool");
    const second = await openView(project, store!);
    expect(layerRow(second.db, BASE_LAYER)?.links).toBe("language-tool");
    expect(call(edges(second.db, second.layer), "src/use.ts:checkout", "total").way).toBe("language-tool");
    second.db.close();
  });
});

// The language's tool is the default (CODE_GRAPH.md, "Two ways to make links"; CONFIG.md,
// graph_links): with nothing set, a language that has a tool has its calls linked by it, and a
// language with none is built by the built-in rules, which the layer's note says. A workspace or a
// repo that sets built-in keeps it, and the repo's own setting wins. A layer built by the built-in
// rules before this default is rebuilt by the tool, as any change of way is.
describe("the default way", () => {
  const NONE = { host: null, host_roles: null, base_branch: null, review_mode: null, checks: null, shared_folders: null, graph_links: null, repos: null, issue_sync: null } as const;

  function opened(dir: string): Store {
    const result = openProjectStore(dir, { create: true });
    if (!result.ok) throw result.error;
    store = result.store;
    return result.store;
  }

  test("with nothing set, the way is the language's tool, for the project folder and for a repo", () => {
    expect(graphLinksOf(NONE, null)).toBe("language-tool");
    expect(graphLinksOf(NONE, "web")).toBe("language-tool");
    expect(graphLinksOf({ ...NONE, repos: { web: { base_branch: "main" } } }, "web")).toBe("language-tool");
  });

  test("built-in set for the workspace or for one repo is kept, and the repo's own wins", () => {
    expect(graphLinksOf({ ...NONE, graph_links: "built-in" }, null)).toBe("built-in");
    expect(graphLinksOf({ ...NONE, graph_links: "built-in" }, "web")).toBe("built-in");
    expect(graphLinksOf({ ...NONE, repos: { web: { base_branch: "main", graph_links: "built-in" } }, issue_sync: null }, "web")).toBe("built-in");
    expect(graphLinksOf({ ...NONE, graph_links: "built-in", repos: { web: { base_branch: "main", graph_links: "language-tool" } } }, "web")).toBe("language-tool");
    expect(graphLinksOf({ ...NONE, graph_links: "language-tool", repos: { web: { base_branch: "main", graph_links: "built-in" } }, issue_sync: null }, "web")).toBe("built-in");
  });

  test("a repo indexed with nothing set has its calls linked by the language's tool", async () => {
    commit(CART, PADDER);
    const s = opened(project);
    writeSetting(s, HUMAN, "base_branch", "main");
    await indexProject(project, s, { rebuild: false });
    const view = await openView(project, s);
    expect(view.freshness.links).toEqual({ way: "language-tool", note: null });
    expect(layerRow(view.db, BASE_LAYER)?.links).toBe("language-tool");
    expect(call(edges(view.db, view.layer), "src/use.ts:checkout", "total")).toMatchObject({ dst: "src/cart.ts:Cart.total", call_state: "linked", way: "language-tool" });
    view.db.close();
  });

  test("a workspace that sets built-in is built by the built-in rules", async () => {
    commit(CART, PADDER);
    const s = opened(project);
    writeSetting(s, HUMAN, "base_branch", "main");
    writeSetting(s, HUMAN, "graph_links", "built-in");
    const view = await openView(project, s);
    expect(view.freshness.links).toEqual({ way: "built-in", note: null });
    expect(new Set(edges(view.db, view.layer).map((r) => r.way))).toEqual(new Set(["built-in"]));
    view.db.close();
  });

  test("a repo that sets built-in is built by the built-in rules, while the workspace names none", async () => {
    // A workspace of one repo, web, whose own policy sets built-in.
    const web = path.join(project, "web");
    mkdirSync(web, { recursive: true });
    git(web, "init", "-q", "-b", "main");
    for (const [file, text] of Object.entries({ ".gitignore": "node_modules/\n", ...CART })) {
      mkdirSync(path.dirname(path.join(web, file)), { recursive: true });
      writeFileSync(path.join(web, file), text);
    }
    git(web, "add", "-A");
    git(web, "commit", "-q", "-m", "first");
    const s = opened(project);
    writeSetting(s, HUMAN, "repos", { web: { base_branch: "main", graph_links: "built-in" } });
    const view = await openView(project, s, { repo: "web" });
    expect(view.freshness.links).toEqual({ way: "built-in", note: null });
    expect(new Set(edges(view.db, view.layer).map((r) => r.way))).toEqual(new Set(["built-in"]));
    view.db.close();
  });

  test("in one repo, TypeScript is linked by its tool and bash, which has none, by the built-in rules; the note says so", async () => {
    commit({
      ...CART,
      "scripts/deploy.sh": ["#!/bin/bash", "greet() {", "  echo hi", "}", "deploy() {", "  greet", "}", 'deploy "$@"', ""].join("\n"),
    });
    const s = opened(project);
    writeSetting(s, HUMAN, "base_branch", "main");
    const view = await openView(project, s);
    expect(view.freshness.links.way).toBe("language-tool");
    expect(view.freshness.links.note).toContain("bash: no language tool");
    expect(layerRow(view.db, BASE_LAYER)?.links_note).toBe(view.freshness.links.note);
    const rows = edges(view.db, view.layer);
    expect(call(rows, "src/use.ts:checkout", "total")).toMatchObject({ dst: "src/cart.ts:Cart.total", way: "language-tool" });
    const bash = rows.filter((r) => r.src.startsWith("scripts/"));
    expect(bash.find((r) => r.src === "scripts/deploy.sh:deploy" && r.dst_name === "greet")).toMatchObject({ dst: "scripts/deploy.sh:greet", way: "built-in" });
    expect(bash.every((r) => r.way === "built-in")).toBe(true);
    view.db.close();
  });

  test("a graph built by the built-in rules before this default is rebuilt by the language's tool", async () => {
    const sha = commit(CART, PADDER);
    // The layer as an older tmb left it: built by the built-in rules, the default then, at this very commit.
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, BASE_LAYER, { force: true, links: "built-in" });
    db.close();
    const s = opened(project);
    writeSetting(s, HUMAN, "base_branch", "main");
    const view = await openView(project, s);
    expect(layerRow(view.db, BASE_LAYER)?.links).toBe("language-tool");
    expect(call(edges(view.db, view.layer), "src/use.ts:checkout", "total")).toMatchObject({ dst: "src/cart.ts:Cart.total", way: "language-tool" });
    view.db.close();
  });

  test("a graph that predates the way of each layer records it as built by the built-in rules, and is rebuilt", () => {
    const file = graphDbPath(project, null);
    mkdirSync(path.dirname(file), { recursive: true });
    const old = new Database(file, { create: true });
    old.run("CREATE TABLE layers (layer TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, extractor INTEGER NOT NULL, built_at TEXT NOT NULL, files INTEGER NOT NULL DEFAULT 0, symbols INTEGER NOT NULL DEFAULT 0, edges INTEGER NOT NULL DEFAULT 0, unresolved INTEGER NOT NULL DEFAULT 0, unresolved_imports INTEGER NOT NULL DEFAULT 0, functions INTEGER NOT NULL DEFAULT 0, not_parsed INTEGER NOT NULL DEFAULT 0, not_read TEXT NOT NULL DEFAULT '{}')");
    old.run("CREATE TABLE edges (layer TEXT NOT NULL, src_id INTEGER NOT NULL, dst_id INTEGER, dst_name TEXT NOT NULL, kind TEXT NOT NULL, resolution TEXT NOT NULL, line INTEGER, hint TEXT, call_state TEXT)");
    old.run("INSERT INTO layers (layer, commit_sha, extractor, built_at) VALUES ('base', 'abc', 12, 'then')");
    old.run("PRAGMA user_version = 6");
    old.close();
    const db = openGraphDb(project, null);
    expect(layerRow(db, "base")?.links).toBe("built-in");
    db.close();
  });
});

describe("the compiler's default library", () => {
  test("the library it is given is read from what is given, never from the compiler's folder", () => {
    const options = baseOptions(ts5);
    const name = path.basename(ts5.getDefaultLibFilePath(options));
    const given = "declare function onlyGiven(): number;\n";
    const texts = new Map([["main.ts", "export const n = onlyGiven();\n"]]);
    const program = commitProgram(ts5, project, texts.keys(), { texts, installed: false, library: new Map([[name, given]]) }, options);
    const sf = program.getSourceFile(path.join(project, "main.ts"))!;
    const call = (sf.statements[0] as TS.VariableStatement).declarationList.declarations[0]!.initializer as TS.CallExpression;
    const decl = program.getTypeChecker().getSymbolAtLocation(call.expression)?.declarations?.[0];
    expect(decl?.getSourceFile().text).toBe(given);
  });
});

describe("the graph's store", () => {
  test("a schema-7 graph gains the position of each call", () => {
    const file = graphDbPath(project, null);
    mkdirSync(path.dirname(file), { recursive: true });
    const old = new Database(file, { create: true });
    old.run("CREATE TABLE layers (layer TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, extractor INTEGER NOT NULL, built_at TEXT NOT NULL, files INTEGER NOT NULL DEFAULT 0, symbols INTEGER NOT NULL DEFAULT 0, edges INTEGER NOT NULL DEFAULT 0, unresolved INTEGER NOT NULL DEFAULT 0, unresolved_imports INTEGER NOT NULL DEFAULT 0, functions INTEGER NOT NULL DEFAULT 0, not_parsed INTEGER NOT NULL DEFAULT 0, not_read TEXT NOT NULL DEFAULT '{}', links TEXT NOT NULL DEFAULT 'built-in', links_note TEXT)");
    old.run("CREATE TABLE edges (layer TEXT NOT NULL, src_id INTEGER NOT NULL, dst_id INTEGER, dst_name TEXT NOT NULL, kind TEXT NOT NULL, resolution TEXT NOT NULL, line INTEGER, hint TEXT, call_state TEXT, way TEXT)");
    old.run("INSERT INTO layers (layer, commit_sha, extractor, built_at) VALUES ('base', 'abc', 15, 'then')");
    old.run("INSERT INTO edges (layer, src_id, dst_name, kind, resolution, line, call_state, way) VALUES ('base', 1, 'f', 'calls', 'unresolved', 3, 'not_known', 'built-in')");
    old.run("PRAGMA user_version = 7");
    old.close();
    const db = openGraphDb(project, null);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
    expect(db.query("SELECT line, pos FROM edges").all()).toEqual([{ line: 3, pos: null }]);
    db.close();
  });

  test("a schema-6 graph gains the way of each link and of each layer", () => {
    const file = graphDbPath(project, null);
    mkdirSync(path.dirname(file), { recursive: true });
    const old = new Database(file, { create: true });
    old.run("CREATE TABLE layers (layer TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, extractor INTEGER NOT NULL, built_at TEXT NOT NULL, files INTEGER NOT NULL DEFAULT 0, symbols INTEGER NOT NULL DEFAULT 0, edges INTEGER NOT NULL DEFAULT 0, unresolved INTEGER NOT NULL DEFAULT 0, unresolved_imports INTEGER NOT NULL DEFAULT 0, functions INTEGER NOT NULL DEFAULT 0, not_parsed INTEGER NOT NULL DEFAULT 0, not_read TEXT NOT NULL DEFAULT '{}')");
    old.run("CREATE TABLE edges (layer TEXT NOT NULL, src_id INTEGER NOT NULL, dst_id INTEGER, dst_name TEXT NOT NULL, kind TEXT NOT NULL, resolution TEXT NOT NULL, line INTEGER, hint TEXT, call_state TEXT)");
    old.run("INSERT INTO layers (layer, commit_sha, extractor, built_at) VALUES ('base', 'abc', 12, 'then')");
    old.run("PRAGMA user_version = 6");
    old.close();
    const db = openGraphDb(project, null);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
    expect(db.query("SELECT name FROM pragma_table_info('edges') WHERE name = 'way'").get()).toEqual({ name: "way" });
    expect(layerRow(db, "base")).toMatchObject({ links: "built-in", links_note: null });
    db.close();
  });
});
