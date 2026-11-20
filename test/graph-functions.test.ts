// Every function in the code graph (trustmybot/tmb#140): each function of TypeScript, TSX and
// JavaScript is one node, unnamed ones included, with a link to what contains it, matched one
// to one against a second, independent parser on a fixture and on tmb's own repo. Agents'
// lookups still name the nearest named function, and nothing is skipped in silence.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ExtractedSymbol, extractFile, inSymbolScope } from "../src/engine/graph/extract.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { loadParsers, type Parsers } from "../src/engine/graph/loader.ts";
import { find, lookupSymbol } from "../src/engine/graph/lookups.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";
import { compilerFunctions, coveredLanguage, graphFunctions, surplus } from "./support/function-coverage.ts";

const REPO = path.resolve(import.meta.dir, "..");

let parsers: Parsers;
beforeAll(async () => {
  parsers = await loadParsers();
});

// One case of each kind of function the measurement of 2026-11-20 counted, and the shapes
// around them: a signature without a body is no function.
const KINDS = `import { run } from "./lib";

export function topLevel(a: number): number {
  function innerNamed() {
    return a;
  }
  const innerArrow = () => innerNamed();
  return [a].map((x) => x + innerArrow()).length;
}

export const topArrow = async (s: string) => s.trim();

export class Shop {
  private total = 0;
  onChange = (n: number) => {
    this.total = n;
  };
  constructor(start: number) {
    this.total = start;
  }
  get value(): number {
    return this.total;
  }
  set value(n: number) {
    this.total = n;
  }
  *items() {
    yield this.total;
  }
  load(): void {
    run(() => this.total);
  }
}

export const handlers = {
  save(id: string) {
    return id;
  },
  remove: (id: string) => id,
  ["computed"]: function () {
    return 1;
  },
};

export function makeCounter() {
  let n = 0;
  return () => ++n;
}

export function overloaded(a: string): string;
export function overloaded(a: number): number;
export function overloaded(a: unknown): unknown {
  return a;
}

declare function declaredOnly(): void;

export abstract class Base {
  abstract shape(): string;
  describe() {
    return this.shape();
  }
}

(function () {
  return 0;
})();

test("lists open tasks", () => {
  expect(topLevel(1)).toBe(1);
});
`;

const JSX = `export function List(props: { items: string[]; onPick: (s: string) => void }) {
  return (
    <ul>
      {props.items.map((item) => (
        <li key={item} onClick={() => props.onPick(item)}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export default function () {
  return <List items={[]} onPick={function (s) { console.log(s); }} />;
}
`;

const JS = `const express = require("express");
module.exports.start = function start(port) {
  const app = express();
  app.get("/", (req, res) => res.send("ok"));
  app.listen(port, function () {
    console.log("listening");
  });
};
exports.helper = () => 1;
`;

function symbols(relPath: string, text: string): ExtractedSymbol[] {
  const lang = coveredLanguage(relPath);
  if (lang === null) throw new Error(relPath);
  return extractFile(parsers, relPath, lang, text).symbols;
}

const fn = (all: ExtractedSymbol[], name: string): ExtractedSymbol => {
  const hit = all.find((s) => s.qualified_name === name && (s.kind === "function" || s.kind === "method"));
  if (!hit) throw new Error(`no function ${name} in ${all.map((s) => s.qualified_name).join(", ")}`);
  return hit;
};

describe("every function is a node", () => {
  for (const [file, text] of [
    ["src/kinds.ts", KINDS],
    ["src/list.tsx", JSX],
    ["web/server.js", JS],
  ] as const) {
    test(`${file} matches the TypeScript compiler one to one`, () => {
      const want = compilerFunctions(file, text);
      const have = graphFunctions(parsers, file, text);
      expect({ missing: surplus(want, have), extra: surplus(have, want) }).toEqual({ missing: [], extra: [] });
      expect(want.length).toBeGreaterThan(3);
    });
  }

  test("each kind of function has its node and its name", () => {
    const all = symbols("src/kinds.ts", KINDS);
    // A named function at the top of a file, and a `const f = () => …` there.
    expect(fn(all, "topLevel").unnamed).toBeUndefined();
    expect(fn(all, "topArrow").kind).toBe("function");
    // Class methods, a constructor, getters and setters, a generator and a class field.
    for (const name of ["Shop.constructor", "Shop.items", "Shop.load", "Shop.onChange", "Base.describe"]) expect(fn(all, name).kind).toBe("method");
    expect(all.filter((s) => s.qualified_name === "Shop.value").length).toBe(2);
    // A named function and a `const f = () => …` inside another function.
    expect(fn(all, "innerNamed").reach).toBe("nested");
    expect(fn(all, "innerArrow").reach).toBe("nested");
    // A callback, named by where it is used; for a test, with the test's name.
    expect(fn(all, "callback of `map`").unnamed).toBe(1);
    expect(fn(all, "callback of `run`").unnamed).toBe(1);
    expect(fn(all, "callback of `test` 'lists open tasks'").unnamed).toBe(1);
    // An object's methods and properties take their key.
    for (const name of ["save", "remove", "computed"]) expect(fn(all, name).reach).toBe("member");
    // A returned function and an immediately called one are named by their line.
    expect(fn(all, "function at line 47").unnamed).toBe(1);
    expect(fn(all, "function at line 65").unnamed).toBe(1);
    // A signature without a body is not a function.
    expect(all.filter((s) => s.qualified_name === "overloaded").length).toBe(1);
    expect(all.some((s) => s.qualified_name === "declaredOnly" || s.qualified_name === "Base.shape")).toBe(false);
  });

  test("functions inside JSX are nodes, named by the attribute or call they are passed to", () => {
    const all = symbols("src/list.tsx", JSX);
    expect(fn(all, "callback of `map`").unnamed).toBe(1);
    expect(fn(all, "callback of `onClick`").unnamed).toBe(1);
    expect(fn(all, "callback of `onPick`").unnamed).toBe(1);
    expect(fn(all, "default export").unnamed).toBe(1);
  });

  test("a function assigned to a property takes the property's name", () => {
    const all = symbols("web/server.js", JS);
    expect(fn(all, "start").reach).toBe("member");
    expect(fn(all, "helper").reach).toBe("member");
    expect(fn(all, "callback of `get` '/'").unnamed).toBe(1);
    expect(fn(all, "callback of `listen`").unnamed).toBe(1);
  });
});

describe("every symbol has a container", () => {
  test("a nested function's container is its parent function, a method's its class, the rest the file", () => {
    const all = symbols("src/kinds.ts", KINDS);
    const index = (s: ExtractedSymbol) => all.indexOf(s);
    expect(all[0]!.kind).toBe("module");
    expect(all[0]!.parent).toBeUndefined();
    for (const s of all.slice(1)) expect(s.parent).toBeNumber();
    expect(fn(all, "innerNamed").parent).toBe(index(fn(all, "topLevel")));
    expect(fn(all, "innerArrow").parent).toBe(index(fn(all, "topLevel")));
    expect(fn(all, "callback of `map`").parent).toBe(index(fn(all, "topLevel")));
    const shop = all.findIndex((s) => s.kind === "class" && s.qualified_name === "Shop");
    expect(fn(all, "Shop.load").parent).toBe(shop);
    expect(fn(all, "callback of `run`").parent).toBe(index(fn(all, "Shop.load")));
    expect(fn(all, "topLevel").parent).toBe(0);
    expect(fn(all, "save").parent).toBe(0);
  });

  test("an unnamed function's owner is the nearest named function around it", () => {
    const all = symbols("src/kinds.ts", KINDS);
    expect(fn(all, "callback of `map`").owner).toBe(all.indexOf(fn(all, "topLevel")));
    expect(fn(all, "callback of `test` 'lists open tasks'").owner).toBe(0);
  });

  test("a call made inside an unnamed function starts at that function", () => {
    const { symbols: all, edges } = extractFile(parsers, "src/kinds.ts", "typescript", KINDS);
    const callback = all.indexOf(fn(all, "callback of `map`"));
    expect(edges.filter((e) => e.src === callback && e.kind === "calls").map((e) => e.dst_name)).toEqual(["innerArrow"]);
  });

  test("other languages' symbols are contained too", () => {
    const py = extractFile(parsers, "tools/a.py", "python", "class A:\n    def run(self):\n        return 1\n\ndef top():\n    return 2\n").symbols;
    expect(py.find((s) => s.qualified_name === "A.run")?.parent).toBe(py.findIndex((s) => s.qualified_name === "A"));
    expect(py.find((s) => s.qualified_name === "top")?.parent).toBe(0);
    const sql = extractFile(null, "db/a.sql", "sql", "CREATE TABLE t (id INTEGER);\n").symbols;
    expect(sql[1]?.parent).toBe(0);
  });
});

describe("the coverage test on tmb's own repo", () => {
  test("every TypeScript and JavaScript function of the repo is one node of the graph, and no node is more", () => {
    const files = spawnSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
      .stdout.split("\n")
      .filter((file) => file !== "" && inSymbolScope(file) && coveredLanguage(file) !== null);
    let total = 0;
    const misses: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(REPO, file), "utf8");
      } catch {
        continue; // deleted in the working folder, not yet committed
      }
      const want = compilerFunctions(file, text);
      const have = graphFunctions(parsers, file, text);
      total += want.length;
      for (const lines of surplus(want, have)) misses.push(`missing ${file}:${lines}`);
      for (const lines of surplus(have, want)) misses.push(`extra ${file}:${lines}`);
    }
    expect(misses).toEqual([]);
    expect(total).toBeGreaterThan(3000);
  });
});

// --- through the index and the agents' lookups ---

const HUMAN: Actor = { kind: "human" };
let project: string;
let store: Store;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const PROJECT: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "src/pricing.ts": `export function applyDiscount(total: number): number {
  return total * 0.9;
}
`,
  "src/cart.ts": `import { applyDiscount } from "./pricing";

export function cartTotal(items: number[]): number {
  return items.map((n) => applyDiscount(n)).reduce((a, b) => a + b, 0);
}
`,
  "test/pricing.test.ts": `import { applyDiscount } from "../src/pricing";

test("ten percent off", () => {
  expect(applyDiscount(100)).toBe(90);
});
`,
  "assets/logo.svg": "<svg/>\n",
};

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-fn-")));
  git(project, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(PROJECT)) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  // Larger than tmb parses: in the graph, marked not parsed with its reason.
  writeFileSync(path.join(project, "src/huge.ts"), `export const big = "${"x".repeat(1_000_100)}";\n`);
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  writeSetting(store, HUMAN, "base_branch", "main");
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

describe("indexing and lookups", () => {
  test("the index counts functions and files not parsed, and keeps both in the graph", async () => {
    const stats = await indexProject(project, store, { rebuild: false });
    // applyDiscount, cartTotal, its two callbacks, and the test's callback.
    expect(stats.functions).toBe(5);
    expect(stats.notParsed).toBe(1);
    const view = await openView(project, store);
    try {
      const huge = view.db.query("SELECT lang, parse_error FROM files WHERE layer = ? AND path = 'src/huge.ts'").get(view.layer) as { lang: string; parse_error: string };
      expect(huge.lang).toBe("typescript");
      expect(huge.parse_error).toContain("not parsed");
      const logo = view.db.query("SELECT lang FROM files WHERE layer = ? AND path = 'assets/logo.svg'").get(view.layer) as { lang: string | null };
      expect(logo.lang).toBeNull();
      const callback = view.db
        .query("SELECT s.unnamed, p.qualified_name AS parent, n.qualified_name AS named FROM symbols s JOIN symbols p ON p.id = s.parent_id JOIN symbols n ON n.id = s.named_id WHERE s.layer = ? AND s.qualified_name = 'callback of `map`'")
        .get(view.layer);
      expect(callback).toEqual({ unnamed: 1, parent: "cartTotal", named: "cartTotal" });
      const orphans = view.db.query("SELECT count(*) AS n FROM symbols WHERE layer = ? AND kind <> 'module' AND parent_id IS NULL").get(view.layer);
      expect(orphans).toEqual({ n: 0 });
    } finally {
      view.db.close();
    }
  });

  test("a lookup names the nearest named function around a caller, and unnamed functions stay out of search", async () => {
    const view = await openView(project, store);
    try {
      const [discount] = lookupSymbol(view.db, view.layer, "applyDiscount").cards;
      expect(discount!.callers.map((c) => c.qualifiedName).sort()).toEqual(["cartTotal", "test/pricing.test.ts"]);
      expect(discount!.tests).toEqual(["test/pricing.test.ts"]);
      const [cart] = lookupSymbol(view.db, view.layer, "cartTotal").cards;
      expect(cart!.callees.map((c) => c.name)).toContain("applyDiscount");
      expect(lookupSymbol(view.db, view.layer, "callback of `map`").cards).toEqual([]);
      expect(find(view.db, view.layer, "callback").filter((h) => h.kind === "symbol")).toEqual([]);
    } finally {
      view.db.close();
    }
  });
});
