// Every symbol in the code graph has a container, in every language, and the index and the
// agents' lookups hold every function (trustmybot/tmb#140): lookups still name the nearest named
// function, and nothing is skipped in silence. The TypeScript and JavaScript function tests are
// in src/engine/graph/languages/typescript/, beside their rules.
import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFile } from "../src/engine/graph/extract.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { loadParsers, type Parsers } from "../src/engine/graph/loader.ts";
import { find, lookupSymbol } from "../src/engine/graph/lookups.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let parsers: Parsers;
beforeAll(async () => {
  parsers = await loadParsers();
});

describe("every symbol has a container", () => {
  test("other languages' symbols are contained too", () => {
    const py = extractFile(parsers, "tools/a.py", "python", "class A:\n    def run(self):\n        return 1\n\ndef top():\n    return 2\n").symbols;
    expect(py.find((s) => s.qualified_name === "A.run")?.parent).toBe(py.findIndex((s) => s.qualified_name === "A"));
    expect(py.find((s) => s.qualified_name === "top")?.parent).toBe(0);
    const sql = extractFile(null, "db/a.sql", "sql", "CREATE TABLE t (id INTEGER);\nCREATE TRIGGER t_added AFTER INSERT ON t BEGIN SELECT 1; END;\n").symbols;
    expect(sql.find((s) => s.kind === "sql_trigger")?.parent).toBe(0);
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
      const orphans = view.db.query("SELECT count(*) AS n FROM symbols WHERE layer = ? AND kind <> 'file' AND parent_id IS NULL").get(view.layer);
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
