// Two ways to make links (trustmybot/tmb#311). The built-in rules (way A) are the default; a repo
// whose `graph_links` setting is `language-tool` has its TypeScript and JavaScript calls linked by
// the TypeScript compiler (way B), which is asked and never imitated:
// - linked, when the callee's declaration is exactly one node of the graph;
// - outside, when every declaration is outside the repo (the compiler's lib, an installed package);
// - not known, when there is no answer or the declaration is no node, such as a parameter.
// Both ways make the same nodes; each link records the way that made it. A repo whose compiler
// cannot run is built by the built-in rules, and the layer says why. The fixtures are small
// programs of their own; each expectation is read off the rule, not off the graph's output.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ts5 from "typescript5";
import { buildLayer } from "../src/engine/graph/build.ts";
import { BASE_LAYER, GRAPH_SCHEMA_VERSION, graphDbPath, layerRow, openGraphDb } from "../src/engine/graph/db.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import { graphLinksOf, readSettings, validateSetting } from "../src/engine/settings.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const TOOLS = new Map<string, unknown>([["typescript", ts5]]);

let project: string;
let store: Store | undefined;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

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
  const b = await buildLayer(db, project, sha, "b", { force: true, links: "language-tool", tools: TOOLS });
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
    const { db, a, b, stats } = await bothWays({ ...CART, "tools/run.py": "def go():\n    return len([])\n" });
    const py = (rows: EdgeRow[]) => rows.filter((r) => r.src.startsWith("tools/"));
    expect(py(b)).toEqual(py(a));
    expect(stats.links).toBe("language-tool");
    expect(stats.linksNote).toContain("python: no language tool");
    expect(layerRow(db, "b")?.links_note).toBe(stats.linksNote);
    db.close();
  });
});

describe("the setting", () => {
  test("built-in, set or not, changes nothing", async () => {
    const sha = commit(CART, PADDER);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, "unset", { force: true });
    const stats = await buildLayer(db, project, sha, "set", { force: true, links: "built-in", tools: TOOLS });
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

  test("a repo's own graph_links wins over the workspace's, which wins over the default", () => {
    const none = { host: null, host_roles: null, base_branch: null, review_mode: null, checks: null, graph_links: null, repos: null } as const;
    expect(graphLinksOf(none, null)).toBe("built-in");
    expect(graphLinksOf({ ...none, graph_links: "language-tool" }, "web")).toBe("language-tool");
    expect(graphLinksOf({ ...none, graph_links: "language-tool", repos: { web: { base_branch: "main", graph_links: "built-in" } } }, "web")).toBe("built-in");
    expect(graphLinksOf({ ...none, repos: { web: { base_branch: "main", graph_links: "language-tool" } } }, "web")).toBe("language-tool");
  });
});

describe("the compiler tmb uses", () => {
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

  test("with no compiler installed in the repo, the repo is built by the built-in rules, and the answer says why", async () => {
    commit(CART, PADDER);
    const view = await indexed("language-tool");
    expect(view.freshness.links.way).toBe("language-tool");
    expect(view.freshness.links.note).toContain("cannot run (the repo has no node_modules/typescript, and tmb installs nothing)");
    expect(new Set(edges(view.db, view.layer).map((r) => r.way))).toEqual(new Set(["built-in"]));
    view.db.close();
  });

  test("a repo's compiler with no program API, such as version 7, is not used", async () => {
    commit(CART, {
      ...PADDER,
      "node_modules/typescript/package.json": JSON.stringify({ name: "typescript", version: "7.0.0", main: "index.js" }),
      "node_modules/typescript/index.js": "module.exports = { version: '7.0.0' };\n",
    });
    const view = await indexed("language-tool");
    expect(view.freshness.links.note).toContain("node_modules/typescript 7.0.0 has no JavaScript program API");
    expect(new Set(edges(view.db, view.layer).map((r) => r.way))).toEqual(new Set(["built-in"]));
    view.db.close();
  });

  test("a repo's compiler older than 5 is not used", async () => {
    commit(CART, { "node_modules/typescript/package.json": JSON.stringify({ name: "typescript", version: "4.9.5" }) });
    const view = await indexed("language-tool");
    expect(view.freshness.links.note).toContain("is version 4.9.5; way B needs 5 or later");
    view.db.close();
  });

  test("the repo's own installed compiler 5 or later makes the links", async () => {
    commit(CART, PADDER);
    // The 5.9 development dependency, installed in the fixture as the repo's own compiler.
    symlinkSync(path.dirname(require.resolve("typescript5/package.json")), path.join(project, "node_modules", "typescript"), "dir");
    const view = await indexed("language-tool");
    expect(view.freshness.links).toEqual({ way: "language-tool", note: null });
    expect(call(edges(view.db, view.layer), "src/use.ts:checkout", "total")).toMatchObject({ dst: "src/cart.ts:Cart.total", way: "language-tool" });
    view.db.close();
  });

  test("changing the setting rebuilds the layer the new way", async () => {
    commit(CART, PADDER);
    symlinkSync(path.dirname(require.resolve("typescript5/package.json")), path.join(project, "node_modules", "typescript"), "dir");
    const first = await indexed(null);
    expect(first.freshness.links).toEqual({ way: "built-in", note: null });
    first.db.close();
    writeSetting(store!, HUMAN, "graph_links", "language-tool");
    const second = await openView(project, store!);
    expect(layerRow(second.db, BASE_LAYER)?.links).toBe("language-tool");
    expect(call(edges(second.db, second.layer), "src/use.ts:checkout", "total").way).toBe("language-tool");
    second.db.close();
  });
});

describe("the graph's store", () => {
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
