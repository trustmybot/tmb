// Imports through path aliases and package names resolve to their files (trustmybot/tmb#147):
// by a tsconfig's `paths` and `baseUrl`, the nearest config above the importing file, and the
// name of a package of the repo. An installed package stays unresolved and is not a miss.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GRAPH_SCHEMA_VERSION, openGraphDb } from "../src/engine/graph/db.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { ImportConfig, parseJsonc } from "../src/engine/graph/import-config.ts";
import { lookupSymbol } from "../src/engine/graph/lookups.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };

let project: string;
let store: Store;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "package.json": JSON.stringify({ name: "shop", private: true, workspaces: ["packages/*", "apps/*"] }),
  // The web app: a `paths` alias, and a baseUrl, set in a base config it extends.
  "apps/web/tsconfig.base.json": `{
    // comments and trailing commas, as tsconfig files are written
    "compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["./*"], "@ui": ["./components/ui/index.ts"], }, },
  }`,
  "apps/web/tsconfig.json": `{ "extends": "./tsconfig.base.json" }`,
  "apps/web/package.json": JSON.stringify({ name: "@shop/web" }),
  "apps/web/src/lib/money.ts": "export function cents(n: number) { return n * 100; }\n",
  "apps/web/src/components/ui/index.ts": "export function Button() { return 'b'; }\n",
  "apps/web/src/state/cart.ts": "export function cartTotal() { return 1; }\n",
  "apps/web/src/pages/checkout.ts": [
    'import { cents } from "@/lib/money";',
    'import { Button } from "@ui";',
    'import { cartTotal } from "state/cart";',
    'import { formatPrice } from "@shop/format";',
    'import { slug } from "@shop/format/slug";',
    'import React from "react";',
    'import { missing } from "@/lib/gone";',
    "export function checkout() { Button(); slug(); React.render(); return formatPrice(cents(cartTotal())); }",
    "",
  ].join("\n"),
  // A workspace package, its entry named by package.json.
  "packages/format/package.json": JSON.stringify({ name: "@shop/format", main: "dist/index.js", exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" }, "./slug": "./src/slug.ts" } }),
  "packages/format/src/index.ts": "export function formatPrice(n: number) { return `$${n}`; }\n",
  "packages/format/src/slug.ts": "export function slug() { return 's'; }\n",
};

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-imports-")));
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

test("every import of a file in the repo is linked: a paths alias, a baseUrl, a workspace package and its subpath", async () => {
  const stats = await indexProject(project, store, { rebuild: false });
  const view = await openView(project, store);
  try {
    const [checkout] = lookupSymbol(view.db, view.layer, "checkout").cards;
    const target = (name: string) => checkout!.callees.find((c) => c.name === name)?.target?.path ?? null;
    expect(target("cents")).toBe("apps/web/src/lib/money.ts");
    expect(target("Button")).toBe("apps/web/src/components/ui/index.ts");
    expect(target("cartTotal")).toBe("apps/web/src/state/cart.ts");
    expect(target("formatPrice")).toBe("packages/format/src/index.ts");
    expect(target("slug")).toBe("packages/format/src/slug.ts");
  } finally {
    view.db.close();
  }
  // `@/lib/gone` names the repo's own code and links no file; `react` is installed, not a miss.
  expect(stats.unresolvedImports).toBe(1);
});

test("a tsconfig is parsed with its comments and trailing commas, and a broken one is skipped", () => {
  expect(parseJsonc('{ // a\n "a": "x//y", /* b */ "c": [1,], }')).toEqual({ a: "x//y", c: [1] });
  expect(parseJsonc("{ nope")).toBeNull();
});

test("the nearest config above a file governs it, and an alias it does not define is not followed", () => {
  const files = new Set(["web/src/a.ts", "api/src/a.ts"]);
  const config = new ImportConfig(
    new Map([
      ["web/tsconfig.json", '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }'],
      ["api/tsconfig.json", '{ "compilerOptions": { "baseUrl": "." } }'],
    ]),
  );
  expect(config.resolve("web/src/b.ts", "~/a", files)).toEqual({ file: "web/src/a.ts", local: true });
  expect(config.resolve("api/src/b.ts", "~/a", files)).toEqual({ file: null, local: false });
  expect(config.resolve("api/src/b.ts", "src/a", files)).toEqual({ file: "api/src/a.ts", local: true });
});

test("two packages of one name are neither linked", () => {
  const config = new ImportConfig(
    new Map([
      ["a/package.json", '{ "name": "dup", "main": "index.ts" }'],
      ["b/package.json", '{ "name": "dup", "main": "index.ts" }'],
    ]),
  );
  expect(config.resolve("c/x.ts", "dup", new Set(["a/index.ts", "b/index.ts"]))).toEqual({ file: null, local: false });
});

test("a graph made by the tmb before this count takes the new column and is rebuilt on the next read", async () => {
  await indexProject(project, store, { rebuild: false });
  const old = openGraphDb(project);
  old.run("ALTER TABLE layers DROP COLUMN unresolved_imports");
  old.run("UPDATE layers SET extractor = 2");
  old.run("PRAGMA user_version = 2");
  old.close();
  const view = await openView(project, store);
  try {
    expect(view.db.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
    expect(view.db.query("SELECT unresolved_imports FROM layers WHERE layer = 'base'").get()).toEqual({ unresolved_imports: 1 });
  } finally {
    view.db.close();
  }
});
