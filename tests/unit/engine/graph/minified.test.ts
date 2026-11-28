// A minified bundle is kept as a file but not parsed, whatever its name (trustmybot/tmb#232):
// GitHub Linguist's test, lines that average more than 110 characters.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexProject, openView } from "../../../../src/engine/graph/fresh.ts";
import { isMinifiedScript } from "../../../../src/engine/graph/languages/typescript/index.ts";
import { find } from "../../../../src/engine/graph/lookups.ts";
import { openProjectStore, writeSetting } from "../../../../src/engine/index.ts";
import type { Actor, Store } from "../../../../src/engine/store/index.ts";
import { git } from "../../../lib/git.ts";

const HUMAN: Actor = { kind: "human" };

setDefaultTimeout(30_000);

let project: string;
let store: Store;

// One line of many small functions, as a bundler writes it.
const BUNDLE = Array.from({ length: 200 }, (_, i) => `function facet${i}(t){return t+${i}}`).join(";");

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "src/facets.ts": "export function facetResults() { return 1; }\n",
  "static/editor-6.0.1.bundle.js": `${BUNDLE}\n`,
  "static/long-but-readable.js": `${Array.from({ length: 20 }, (_, i) => `export function step${i}() { return ${i}; }`).join("\n")}\n`,
};

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-minified-")));
  git(project, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(FIXTURE)) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
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

test("Linguist's rule: lines that average more than 110 characters are minified", () => {
  expect(isMinifiedScript(BUNDLE)).toBe(true);
  expect(isMinifiedScript(FIXTURE["static/long-but-readable.js"]!)).toBe(false);
  expect(isMinifiedScript("")).toBe(false);
});

test("a minified bundle with no .min. in its name stays a file, marked, with no symbol to crowd search", async () => {
  const stats = await indexProject(project, store, { rebuild: false });
  expect(stats.notParsed).toBe(1);
  const view = await openView(project, store);
  try {
    const row = view.db.query("SELECT lang, parse_error FROM files WHERE layer = ? AND path = ?").get(view.layer, "static/editor-6.0.1.bundle.js");
    expect(row).toEqual({ lang: "javascript", parse_error: "minified; not parsed" });
    expect(view.db.query("SELECT count(*) AS n FROM symbols WHERE layer = ? AND path = ?").get(view.layer, "static/editor-6.0.1.bundle.js")).toEqual({ n: 0 });
    // A readable file of the same language is parsed as before.
    expect(view.db.query("SELECT count(*) AS n FROM symbols WHERE layer = ? AND path = ? AND kind = 'function'").get(view.layer, "static/long-but-readable.js")).toEqual({ n: 20 });
    const hits = find(view.db, view.layer, "facet", 5);
    expect(hits[0]).toMatchObject({ kind: "symbol", qualifiedName: "facetResults" });
    expect(hits.some((h) => h.kind === "symbol" && h.path === "static/editor-6.0.1.bundle.js")).toBe(false);
  } finally {
    view.db.close();
  }
});
