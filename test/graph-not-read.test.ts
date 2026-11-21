// The graph names what it does not read (trustmybot/tmb#234): code in a language tmb has no
// module for is counted by language, files left out by rule are counted by rule, and a lookup
// that finds nothing says so instead of reading as "there is nothing".
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GRAPH_SCHEMA_VERSION, openGraphDb } from "../src/engine/graph/db.ts";
import { leftOutRule } from "../src/engine/graph/extract.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { unreadLanguageOf } from "../src/engine/graph/languages/unread.ts";
import { notReadLines, notReadSummary } from "../src/engine/graph/not-read.ts";
import { graphFind, graphScope, graphSymbol } from "../src/engine/handlers/graph.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "claude-code" } as Actor;

setDefaultTimeout(30_000);

let project: string;
let store: Store;
const context = () => ({ projectDir: project });

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "src/index.ts": "export function serve() { return 1; }\n",
  "build/script.ts": "export function buildSite() { return 2; }\n",
  "command.go": "package cobra\n\nfunc ExecuteC() error { return nil }\n",
  "args.go": "package cobra\n\nfunc NoArgs() error { return nil }\n",
  "lib/thing.rs": "pub fn thing() {}\n",
  "dist/app.js": "export function bundled() {}\n",
  "dist/app.js.map": "{}\n",
  "package-lock.json": "{}\n",
  "README.md": "# demo\n",
};

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-not-read-")));
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

test("languages by Linguist's programming endings; the first-listed language wins a shared ending", () => {
  expect(unreadLanguageOf("cmd/root.go")).toBe("Go");
  expect(unreadLanguageOf("src/main.rs")).toBe("Rust");
  expect(unreadLanguageOf("include/x.h")).toBe("C");
  expect(unreadLanguageOf("App.vue")).toBe("Vue");
  expect(unreadLanguageOf("src/a.ts")).toBeNull();
  expect(unreadLanguageOf("README.md")).toBeNull();
});

test("Linguist's vendor rules: dist/ and vendor/ are left out, build/ is not", () => {
  expect(leftOutRule("dist/app.js")).toBe("dist/");
  expect(leftOutRule("web/node_modules/x/index.js")).toBe("node_modules/");
  expect(leftOutRule("vendor/lib.go")).toBe("vendor/");
  expect(leftOutRule("build/script.ts")).toBeNull();
});

test("the index names the languages it does not read and the files it left out, with counts", async () => {
  const stats = await indexProject(project, store, { rebuild: false });
  expect(stats.notRead).toEqual({
    languages: [
      { name: "Go", files: 2 },
      { name: "Rust", files: 1 },
    ],
    leftOut: [
      { rule: "dist/", files: 2 },
      { rule: "lockfiles", files: 1 },
    ],
  });
  expect(notReadSummary(stats.notRead)).toBe("not read: Go 2 files, Rust 1 file; left out: dist/ 2 files, lockfiles 1 file");
  // Unread languages are not "not parsed": that stays for files tmb reads and could not.
  expect(stats.notParsed).toBe(0);
});

test("a tracked build/ folder is in the graph", async () => {
  await indexProject(project, store, { rebuild: false });
  const view = await openView(project, store);
  try {
    expect(view.db.query("SELECT count(*) AS n FROM symbols WHERE layer = ? AND qualified_name = 'buildSite'").get(view.layer)).toEqual({ n: 1 });
  } finally {
    view.db.close();
  }
});

test("a lookup that finds nothing names the languages the graph does not read", async () => {
  const found = await graphFind(store, PLANNER, { query: "ExecuteC" }, context());
  expect(found.hits.some((h) => h.kind === "symbol")).toBe(false);
  expect(found.hits).toEqual([]);
  expect(found.unreadLanguages).toEqual([{ name: "Go", files: 2 }, { name: "Rust", files: 1 }]);

  const symbol = await graphSymbol(store, PLANNER, { name: "ExecuteC" }, context());
  expect(symbol.cards).toEqual([]);
  expect(symbol.unreadLanguages?.map((l) => l.name)).toEqual(["Go", "Rust"]);
  expect(notReadLines(symbol)).toEqual(["The code graph does not read Go (2 files), Rust (1 file); what is there is not searched."]);

  const scoped = await graphScope(store, PLANNER, { objective: "zzzqqq" }, context());
  expect([scoped.files, scoped.tests]).toEqual([[], []]);
  expect(scoped.unreadLanguages?.length).toBe(2);

  // A lookup that finds something says nothing about it.
  const served = await graphSymbol(store, PLANNER, { name: "serve" }, context());
  expect(served.cards.length).toBe(1);
  expect(served.unreadLanguages).toBeUndefined();
});

test("a lookup of a file in an unread language says the file is there and its language is not read", async () => {
  const answer = await graphSymbol(store, PLANNER, { name: "command.go" }, context());
  expect(answer.cards).toEqual([]);
  expect(answer.unreadFile).toEqual({ path: "command.go", language: "Go" });
  expect(notReadLines(answer)).toEqual(["command.go is in the graph, but the code graph does not read Go, so it has no symbols."]);
});

test("a graph of schema 4 takes the new column and is rebuilt with the counts on the next read", async () => {
  await indexProject(project, store, { rebuild: false });
  const old = openGraphDb(project);
  old.run("ALTER TABLE layers DROP COLUMN not_read");
  old.run("UPDATE layers SET extractor = extractor - 1");
  old.run("PRAGMA user_version = 4");
  old.close();
  const view = await openView(project, store);
  try {
    expect(view.db.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
    const row = view.db.query("SELECT not_read FROM layers WHERE layer = 'base'").get() as { not_read: string };
    expect(JSON.parse(row.not_read).languages[0]).toEqual({ name: "Go", files: 2 });
  } finally {
    view.db.close();
  }
});
