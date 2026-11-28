// The graph names what it does not read (trustmybot/tmb#234): code in a language tmb has no
// module for is counted by language, files left out by rule are counted by rule, and a lookup
// that finds nothing says so instead of reading as "there is nothing".
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GRAPH_SCHEMA_VERSION, openGraphDb } from "../../../../src/engine/graph/db.ts";
import { fileLanguages, leftOutRule } from "../../../../src/engine/graph/extract.ts";
import { indexProject, openView } from "../../../../src/engine/graph/fresh.ts";
import { unreadLanguage, unreadLanguageOf } from "../../../../src/engine/graph/languages/unread.ts";
import { notReadLines, notReadSummary } from "../../../../src/engine/graph/not-read.ts";
import { graphFind, graphScope, graphSymbol } from "../../../../src/engine/handlers/graph.ts";
import { openProjectStore, writeSetting } from "../../../../src/engine/index.ts";
import type { Actor, Store } from "../../../../src/engine/store/index.ts";
import { git } from "../../../lib/git.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "claude-code" } as Actor;

setDefaultTimeout(30_000);

let project: string;
let store: Store;
const context = () => ({ projectDir: project });

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "src/index.ts": "export function serve() { return 1; }\n",
  "build/script.ts": "export function buildSite() { return 2; }\n",
  "Command.kt": "class Command { fun executeC(): Int = 0 }\n",
  "Args.kt": "class Args { fun noArgs(): Int = 0 }\n",
  "lib/thing.rb": "def thing; end\n",
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

test("a file is counted under the language Linguist names for it when it is code no module reads (trustmybot/tmb#154)", () => {
  const unread = (file: string, text = "") => unreadLanguage(fileLanguages(file, () => text), file);
  expect(unread("cmd/Root.kt")).toBe("Kotlin");
  expect(unread("src/main.rb")).toBe("Ruby");
  expect(unread("lib/x.m", "@interface Gauge : NSObject\n@end\n")).toBe("Objective-C");
  // Vue is markup to Linguist, but holds script.
  expect(unread("App.vue")).toBe("Vue");
  expect(unread("src/a.ts")).toBeNull();
  // C and C++ are read (trustmybot/tmb#355).
  expect(unread("include/x.h", "int x(void);\n")).toBeNull();
  expect(unread("src/x.cc")).toBeNull();
  expect(unread("README.md", "# demo\n")).toBeNull();
  // Linguist's rules leave a `.pl` file with neither Perl's nor Prolog's marks undecided: Perl's module reads it.
  expect(unread("logic/facts.pl", "x.\n")).toBeNull();
  // Undecided between languages no module reads: one of them.
  expect(unread("lib/facts.ecl", "x\n")).toBe("one of ECL, ECLiPSe");
});

test("by its name alone, a path is in the first of its languages that the layer counted", () => {
  const counted = new Set(["Kotlin", "Objective-C"]);
  expect(unreadLanguageOf("cmd/Root.kt", counted)).toBe("Kotlin");
  expect(unreadLanguageOf("lib/x.m", counted)).toBe("Objective-C");
  expect(unreadLanguageOf("src/main.rb", counted)).toBeNull();
  expect(unreadLanguageOf("README.md", counted)).toBeNull();
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
      { name: "Kotlin", files: 2 },
      { name: "Ruby", files: 1 },
    ],
    leftOut: [
      { rule: "dist/", files: 2 },
      { rule: "lockfiles", files: 1 },
    ],
  });
  expect(notReadSummary(stats.notRead)).toBe("not read: Kotlin 2 files, Ruby 1 file; left out: dist/ 2 files, lockfiles 1 file");
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
  const found = await graphFind(store, PLANNER, { query: "executeC" }, context());
  expect(found.hits.some((h) => h.kind === "symbol")).toBe(false);
  expect(found.hits).toEqual([]);
  expect(found.unreadLanguages).toEqual([{ name: "Kotlin", files: 2 }, { name: "Ruby", files: 1 }]);

  const symbol = await graphSymbol(store, PLANNER, { name: "executeC" }, context());
  expect(symbol.cards).toEqual([]);
  expect(symbol.unreadLanguages?.map((l) => l.name)).toEqual(["Kotlin", "Ruby"]);
  expect(notReadLines(symbol)).toEqual(["The code graph does not read Kotlin (2 files), Ruby (1 file); what is there is not searched."]);

  const scoped = await graphScope(store, PLANNER, { objective: "zzzqqq" }, context());
  expect([scoped.files, scoped.tests]).toEqual([[], []]);
  expect(scoped.unreadLanguages?.length).toBe(2);

  // A lookup that finds something says nothing about it.
  const served = await graphSymbol(store, PLANNER, { name: "serve" }, context());
  expect(served.cards.length).toBe(1);
  expect(served.unreadLanguages).toBeUndefined();
});

test("a lookup of a file in an unread language says the file is there and its language is not read", async () => {
  const answer = await graphSymbol(store, PLANNER, { name: "Command.kt" }, context());
  expect(answer.cards).toEqual([]);
  expect(answer.unreadFile).toEqual({ path: "Command.kt", language: "Kotlin" });
  expect(notReadLines(answer)).toEqual(["Command.kt is in the graph, but the code graph does not read Kotlin, so it has no symbols."]);
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
    expect(JSON.parse(row.not_read).languages[0]).toEqual({ name: "Kotlin", files: 2 });
  } finally {
    view.db.close();
  }
});
