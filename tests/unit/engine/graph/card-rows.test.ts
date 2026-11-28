// A code graph answer lists each caller and callee once, with the lines of its calls (trustmybot/tmb#235):
// a test file of many `it(...)` callbacks is one caller, not one per call, and the cap counts distinct rows.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexProject, openView } from "../../../../src/engine/graph/fresh.ts";
import { CARD_LIST_MAX, lookupSymbol, ROW_LINES_MAX } from "../../../../src/engine/graph/lookups.ts";
import { openProjectStore, writeSetting } from "../../../../src/engine/index.ts";
import type { Actor, Store } from "../../../../src/engine/store/index.ts";
import { git } from "../../../lib/git.ts";

const HUMAN: Actor = { kind: "human" };

setDefaultTimeout(30_000);

let project: string;
let store: Store;

const CALLBACKS = 40;
const CALLERS = 60;

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "src/compose.ts": "export function compose(a: number) { return a; }\nexport function wrap(a: number) { return a; }\nexport function helper(a: number) { return a; }\n",
  // 40 unnamed callbacks, each reported as its file: one caller with 40 lines.
  "test/compose.test.ts": [
    'import { compose } from "../src/compose.ts";',
    "declare function it(name: string, fn: () => void): void;",
    ...Array.from({ length: CALLBACKS }, (_, i) => `it("case ${i}", () => { compose(${i}); });`),
    "",
  ].join("\n"),
  // 60 distinct named callers.
  "src/callers.ts": [
    'import { wrap } from "./compose.ts";',
    ...Array.from({ length: CALLERS }, (_, i) => `export function caller${i}() { return wrap(${i}); }`),
    "",
  ].join("\n"),
  // One function calling the same callee five times: one callee row with five lines.
  "src/repeat.ts": [
    'import { helper } from "./compose.ts";',
    "export function repeat() {",
    ...Array.from({ length: 5 }, (_, i) => `  helper(${i});`),
    "}",
    "",
  ].join("\n"),
};

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-card-rows-")));
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

test("40 callbacks in one test file give one caller row with 40 lines, shortened with a count", async () => {
  await indexProject(project, store, { rebuild: false });
  const view = await openView(project, store);
  try {
    const [card] = lookupSymbol(view.db, view.layer, "compose").cards;
    const fromTests = card!.callers.filter((c) => c.path === "test/compose.test.ts");
    expect(card!.callers).toHaveLength(1);
    expect(fromTests).toHaveLength(1);
    expect(card!.more.callers).toBe(0);
    // The callbacks are on lines 3 to 42 of the test file.
    expect(fromTests[0]!.lines).toEqual(Array.from({ length: ROW_LINES_MAX }, (_, i) => i + 3));
    expect(fromTests[0]!.moreLines).toBe(CALLBACKS - ROW_LINES_MAX);

    const [repeat] = lookupSymbol(view.db, view.layer, "repeat").cards;
    const helpers = repeat!.callees.filter((c) => c.name === "helper");
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).toMatchObject({ lines: [3, 4, 5, 6, 7], moreLines: 0, target: { qualifiedName: "helper", path: "src/compose.ts" } });
  } finally {
    view.db.close();
  }
});

test("60 distinct callers give 50 rows and 10 more", async () => {
  await indexProject(project, store, { rebuild: false });
  const view = await openView(project, store);
  try {
    const [card] = lookupSymbol(view.db, view.layer, "wrap").cards;
    expect(card!.callers).toHaveLength(CARD_LIST_MAX);
    expect(new Set(card!.callers.map((c) => c.qualifiedName)).size).toBe(CARD_LIST_MAX);
    expect(card!.callers.every((c) => c.lines.length === 1 && c.moreLines === 0)).toBe(true);
    expect(card!.more.callers).toBe(10);
  } finally {
    view.db.close();
  }
});
