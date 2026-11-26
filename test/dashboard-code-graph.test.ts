// The dashboard's code graph page reads: walked from the top folder down, they reach every
// function the graph holds, each once; a function's view matches the agents' lookup; and no
// answer draws more than one level.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { childOf, file, functionView, search, tree } from "../src/engine/doors/dashboard/code-graph.ts";
import { FUNCTION_KINDS } from "../src/engine/graph/build.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { lookupSymbol } from "../src/engine/graph/lookups.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const REPO = path.resolve(import.meta.dir, "..");
const HUMAN: Actor = { kind: "human" };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const PROJECT: Record<string, string> = {
  "README.md": "# Shop\n\nA small shop.\n",
  "src/shop/pricing.ts": `export function applyDiscount(price: number): number {
  return price * 0.9;
}
`,
  "src/shop/cart.ts": `import { applyDiscount } from "./pricing";

export class Cart {
  items: number[] = [];
  total(): number {
    return this.items.map((p) => applyDiscount(p)).reduce((a, b) => a + b, 0);
  }
}

export function makeCart(): Cart {
  function seed(c: Cart) {
    c.items.push(1);
  }
  const c = new Cart();
  seed(c);
  return c;
}
`,
  "src/main.ts": `import { makeCart } from "./shop/cart";

export function main(): number {
  return makeCart().total();
}
`,
  "test/cart.test.ts": `import { makeCart } from "../src/shop/cart";

test("a cart", () => {
  makeCart();
});
`,
};

type Walk = { functions: Map<number, string>; dirs: number; files: number; widest: number };

/** Walks the page's data from the top folder down, as a person clicking every folder and file would. */
function walk(db: Database, layer: string): Walk {
  const out: Walk = { functions: new Map(), dirs: 0, files: 0, widest: 0 };
  const seen: number[] = [];
  const visit = (dir: string): number => {
    const level = tree(db, layer, dir)!;
    out.dirs++;
    out.widest = Math.max(out.widest, level.children.length);
    let sum = 0;
    for (const child of level.children) {
      // One level only: each child sits directly in this folder.
      expect(childOf(level.path, child.path)).toBe(child.path);
      if (child.kind === "dir") {
        const inside = visit(child.path);
        expect(inside).toBe(child.functions);
        sum += inside;
      } else {
        out.files++;
        const one = file(db, layer, child.path)!;
        const fns = one.symbols.filter((s) => FUNCTION_KINDS.has(s.kind));
        expect(fns.length).toBe(child.functions);
        expect(one.functions).toBe(child.functions);
        for (const s of fns) {
          seen.push(s.id);
          out.functions.set(s.id, `${child.path}:${s.qualifiedName}`);
        }
        // Each symbol's container is drawn on the same page.
        const ids = new Set(one.symbols.map((s) => s.id));
        for (const s of one.symbols) if (s.parent !== null) expect(ids.has(s.parent)).toBe(true);
        sum += child.functions;
      }
    }
    expect(sum).toBe(level.functions);
    return sum;
  };
  visit(".");
  // Exactly once: no function is reached twice.
  expect(seen.length).toBe(out.functions.size);
  return out;
}

function graphFunctionIds(db: Database, layer: string): Set<number> {
  const kinds = [...FUNCTION_KINDS];
  const rows = db.query(`SELECT id FROM symbols WHERE layer = ? AND kind IN (${kinds.map(() => "?").join(", ")})`).all(layer, ...kinds) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

describe("a small project", () => {
  let project: string;
  let store: Store;
  let db: Database;
  let layer: string;

  beforeAll(async () => {
    project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-code-page-")));
    git(project, "init", "-q", "-b", "main");
    for (const [name, text] of Object.entries(PROJECT)) {
      mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      writeFileSync(path.join(project, name), text);
    }
    writeFileSync(path.join(project, "src/huge.ts"), `export const big = "${"x".repeat(1_000_100)}";\n`);
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "first");
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    store = opened.store;
    writeSetting(store, HUMAN, "base_branch", "main");
    // These test the built-in rules, so the repo names them; the default is the language's tool (trustmybot/tmb#337).
    writeSetting(store, HUMAN, "graph_links", "built-in");
    const view = await openView(project, store);
    db = view.db;
    layer = view.layer;
  });

  afterAll(() => {
    db.close();
    store.close();
    rmSync(project, { recursive: true, force: true });
  });

  test("walking from the top folder down finds every function the graph holds, each once", () => {
    const walked = walk(db, layer);
    expect(new Set(walked.functions.keys())).toEqual(graphFunctionIds(db, layer));
    expect([...walked.functions.values()].sort()).toEqual(
      [
        "src/main.ts:main",
        "src/shop/cart.ts:Cart.total",
        "src/shop/cart.ts:callback of `map`",
        "src/shop/cart.ts:callback of `reduce`",
        "src/shop/cart.ts:makeCart",
        "src/shop/cart.ts:seed",
        "src/shop/pricing.ts:applyDiscount",
        "test/cart.test.ts:callback of `test` 'a cart'",
      ].sort(),
    );
  });

  test("the top folder shows its own folders and files only, with function counts and proven links", () => {
    const top = tree(db, layer, ".")!;
    expect(top.children.map((c) => `${c.kind}:${c.path}:${c.functions}`)).toEqual(["dir:src:7", "dir:test:1", "file:README.md:0"]);
    expect(top.links).toContainEqual({ from: "test", to: "src", calls: 1, imports: 1 });
    const src = tree(db, layer, "src")!;
    expect(src.children.map((c) => c.path)).toEqual(["src/shop", "src/huge.ts", "src/main.ts"]);
    expect(src.links.find((l) => l.from === "src/main.ts" && l.to === "src/shop")).toMatchObject({ imports: 1 });
  });

  test("a file the graph could not parse is drawn, marked so", () => {
    const huge = tree(db, layer, "src")!.children.find((c) => c.path === "src/huge.ts")!;
    expect(huge).toMatchObject({ kind: "file", functions: 0 });
    expect(huge.kind === "file" && huge.notParsed).toContain("not parsed");
    expect(file(db, layer, "src/huge.ts")!.notParsed).toContain("not parsed");
    const readme = tree(db, layer, ".")!.children.find((c) => c.path === "README.md")!;
    expect(readme.kind === "file" && readme.notParsed).toBeNull();
  });

  test("a function with functions inside it holds them, and a class holds its methods", () => {
    const cart = file(db, layer, "src/shop/cart.ts")!;
    const by = (name: string) => cart.symbols.find((s) => s.qualifiedName === name)!;
    expect(by("seed").parent).toBe(by("makeCart").id);
    expect(by("Cart.total").parent).toBe(by("Cart").id);
    expect(by("callback of `map`").parent).toBe(by("Cart.total").id);
    expect(by("callback of `map`").unnamed).toBe(true);
    expect(by("makeCart").parent).toBeNull();
    // makeCart calls seed, in this file: a link on the file's page.
    expect(cart.links).toContainEqual({ from: by("makeCart").id, to: by("seed").id, count: 1 });
  });

  test("one function's view shows the same callers and callees as the agents' lookup", () => {
    for (const name of ["makeCart", "applyDiscount", "Cart.total", "main"]) {
      const card = lookupSymbol(db, layer, name).cards[0]!;
      const row = db.query("SELECT id FROM symbols WHERE layer = ? AND qualified_name = ? AND unnamed = 0").get(layer, name) as { id: number };
      const view = functionView(db, layer, row.id)!;
      expect(view.card).toEqual(card);
      expect(view.callers.map(({ id: _id, ...ref }) => ref)).toEqual(card.callers);
      expect(view.callees.map((c) => c.qualifiedName)).toEqual(card.callees.filter((c) => c.target !== null).map((c) => c.target!.qualifiedName));
      // Each proven caller and callee in a function opens by its id.
      for (const ref of [...view.callers, ...view.callees]) if (ref.kind !== "module") expect(ref.id).not.toBeNull();
    }
    const applyDiscount = db.query("SELECT id FROM symbols WHERE layer = ? AND qualified_name = 'applyDiscount'").get(layer) as { id: number };
    // Called from inside an unnamed callback: reported from the nearest named function, as the lookup does.
    expect(functionView(db, layer, applyDiscount.id)!.callers.map((c) => c.qualifiedName)).toEqual(["Cart.total"]);
  });

  test("an unnamed function opens too, inside its container", () => {
    const cart = file(db, layer, "src/shop/cart.ts")!;
    const callback = cart.symbols.find((s) => s.qualifiedName === "callback of `map`")!;
    const view = functionView(db, layer, callback.id)!;
    expect(view.unnamed).toBe(true);
    expect(view.parent).toBe(cart.symbols.find((s) => s.qualifiedName === "Cart.total")!.id);
    expect(view.callees.map((c) => c.qualifiedName)).toEqual(["applyDiscount"]);
  });

  test("a function shows its calls by state, and an unnamed one its own (trustmybot/tmb#252)", () => {
    const cart = file(db, layer, "src/shop/cart.ts")!;
    const by = (name: string) => cart.symbols.find((s) => s.qualifiedName === name)!;
    // Cart.total writes `.map(…)` and `.reduce(…)`, on no proven type; its callback calls applyDiscount.
    expect(by("Cart.total").calls).toEqual({ linked: 0, outside: 0, notKnown: 2 });
    expect(by("callback of `map`").calls).toEqual({ linked: 1, outside: 0, notKnown: 0 });
    const view = functionView(db, layer, by("Cart.total").id)!;
    expect(view.card.calls).toEqual({ linked: 1, outside: 0, notKnown: 2 });
    expect(view.card.callsNote).toContain("Calls not known: 2 of 3.");
  });

  test("search finds a function by part of its name, named ones first", () => {
    expect(search(db, layer, "applyDisc").map((h) => h.qualifiedName)).toEqual(["applyDiscount"]);
    expect(search(db, layer, "cart").map((h) => h.qualifiedName)).toEqual(["Cart", "makeCart", "Cart.total", "callback of `test` 'a cart'"]);
    expect(search(db, layer, "callback").every((h) => h.unnamed)).toBe(true);
    expect(search(db, layer, "%")).toEqual([]);
    expect(search(db, layer, "  ")).toEqual([]);
  });

  test("a folder, file or function the graph does not hold is no answer", () => {
    expect(tree(db, layer, "nope")).toBeNull();
    expect(file(db, layer, "src/nope.ts")).toBeNull();
    expect(functionView(db, layer, 999_999)).toBeNull();
    const module = db.query("SELECT id FROM symbols WHERE layer = ? AND kind = 'module' LIMIT 1").get(layer) as { id: number };
    expect(functionView(db, layer, module.id)).toBeNull();
  });
});

describe("tmb's own repo", () => {
  let clone: string;
  let store: Store;

  beforeAll(() => {
    clone = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-code-page-self-")));
    git(REPO, "clone", "-q", "--no-hardlinks", "--depth", "1", `file://${REPO}`, clone);
    const opened = openProjectStore(clone, { create: true });
    if (!opened.ok) throw opened.error;
    store = opened.store;
    // CI checks out a detached HEAD: name the clone's commit as a branch of its own.
    git(clone, "checkout", "-q", "-B", "graph-base");
    writeSetting(store, HUMAN, "base_branch", "graph-base");
  });

  afterAll(() => {
    store.close();
    rmSync(clone, { recursive: true, force: true });
  });

  test("walking the page's data reaches all of its functions, one level at a time", async () => {
    await indexProject(clone, store, { rebuild: false });
    const view = await openView(clone, store);
    try {
      const all = graphFunctionIds(view.db, view.layer);
      expect(all.size).toBeGreaterThan(3000);
      const walked = walk(view.db, view.layer);
      expect(new Set(walked.functions.keys())).toEqual(all);
      // The top level is a handful of folders and files, not thousands of functions.
      expect(tree(view.db, view.layer, ".")!.children.length).toBeLessThan(60);
    } finally {
      view.db.close();
    }
  }, 180_000);
});
