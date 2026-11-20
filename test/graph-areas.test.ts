// Areas: the logical parts of a project (trustmybot/tmb#146). "tests" is there from the start,
// the planner writes the others by path patterns, cards name a file's areas, search and scope
// keep to an area or leave one out, and a rebuild keeps the areas and re-checks each one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { areasOf, globMatcher, TESTS_AREA } from "../src/engine/graph/areas.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { graphAreaRemove, graphAreas, graphAreaUpsert, graphFind, graphScope, graphSymbol } from "../src/engine/handlers/graph.ts";
import { HandlerError } from "../src/engine/handlers/errors.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "claude-code" } as Actor;
const WORKER: Actor = { kind: "agent", role: "worker", host: "claude-code" } as Actor;

let project: string;
let store: Store;
const context = () => ({ projectDir: project });

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function write(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
}

function commit(message: string): void {
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", message);
}

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "src/billing/invoice.ts": "export function invoiceTotal(lines: number[]) { return lines.length; }\n",
  "src/billing/refund.ts": 'import { invoiceTotal } from "./invoice";\nexport function refund() { return invoiceTotal([]); }\n',
  "src/login/session.ts": "export function openSession() { return 'invoice'; }\n",
  "src/login/oauth/google.ts": 'import { openSession } from "../session";\nexport function googleLogin() { return openSession(); }\n',
  "src/util/strings.ts": "export function pad(s: string) { return s; }\n",
  "README.md": "# shop\n",
  // The test layouts of TypeScript, Python and Go.
  "src/billing/invoice.test.ts": 'import { invoiceTotal } from "./invoice";\ninvoiceTotal([]);\n',
  "__tests__/login.ts": 'import { openSession } from "../src/login/session";\nopenSession();\n',
  "py/shop/tax.py": "def tax():\n    return 1\n",
  "py/tests/test_tax.py": "from shop.tax import tax\n",
  "py/shop/tax_test.py": "def test_tax():\n    pass\n",
  "go/cart/cart.go": "package cart\n\nfunc Total() int { return 1 }\n",
  "go/cart/cart_test.go": "package cart\n\nfunc TestTotal() {}\n",
};

beforeEach(async () => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-areas-")));
  git(project, "init", "-q", "-b", "main");
  write(FIXTURE);
  commit("first");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  writeSetting(store, HUMAN, "base_branch", "main");
  await indexProject(project, store, { rebuild: false });
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

async function refusal(call: Promise<unknown>): Promise<HandlerError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("areas", () => {
  test("a fresh project has a tests area that holds its test files in the TypeScript, Python and Go layouts", async () => {
    const { areas, unplaced } = await graphAreas(store, PLANNER, {}, context());
    expect(areas.map((a) => a.name)).toEqual([TESTS_AREA]);
    expect(areas[0]).toMatchObject({ builtin: true, status: "ok", files: 5 });
    const view = await openView(project, store);
    try {
      const of = areasOf(view.db, ["src/billing/invoice.test.ts", "__tests__/login.ts", "py/tests/test_tax.py", "py/shop/tax_test.py", "go/cart/cart_test.go", "go/cart/cart.go"]);
      for (const file of ["src/billing/invoice.test.ts", "__tests__/login.ts", "py/tests/test_tax.py", "py/shop/tax_test.py", "go/cart/cart_test.go"]) expect(of.get(file)).toEqual([TESTS_AREA]);
      expect(of.get("go/cart/cart.go")).toEqual([]);
    } finally {
      view.db.close();
    }
    // Every product file is still in no area, listed with the count.
    expect(unplaced.count).toBe(9);
    expect(unplaced.files).toContain("src/util/strings.ts");
  });

  test("the planner writes an area by patterns; a pattern that matches no file is refused with the reason", async () => {
    const { area } = await graphAreaUpsert(store, PLANNER, { name: "billing", purpose: "Invoices and refunds.", include: ["src/billing"] }, context());
    expect(area).toMatchObject({ name: "billing", files: 3, status: "ok", parent: null });
    const missing = await refusal(graphAreaUpsert(store, PLANNER, { name: "payments", purpose: "Card payments.", include: ["src/payments/**"] }, context()));
    expect(missing.code).toBe("refused");
    expect(missing.message).toContain("src/payments/**");
    const empty = await refusal(graphAreaUpsert(store, PLANNER, { name: "nothing", purpose: "x", include: ["src/billing"], exclude: ["src/**"] }, context()));
    expect(empty.message).toContain("would hold no file");
    // Only the planner writes an area.
    expect((await refusal(graphAreaUpsert(store, WORKER, { name: "login", purpose: "x", include: ["src/login"] }, context()))).code).toBe("refused");
    // One level of nesting.
    await graphAreaUpsert(store, PLANNER, { name: "login", purpose: "Sign-in.", include: ["src/login"] }, context());
    await graphAreaUpsert(store, PLANNER, { name: "oauth", purpose: "Sign-in through Google.", include: ["src/login/oauth"], parent: "login" }, context());
    const deeper = await refusal(graphAreaUpsert(store, PLANNER, { name: "google", purpose: "x", include: ["src/login/oauth/google.ts"], parent: "oauth" }, context()));
    expect(deeper.message).toContain("one level deep");
  });

  test("a file's card and each of its functions' cards name its areas, the main one first", async () => {
    await graphAreaUpsert(store, PLANNER, { name: "login", purpose: "Sign-in.", include: ["src/login"] }, context());
    await graphAreaUpsert(store, PLANNER, { name: "oauth", purpose: "Sign-in through Google.", include: ["src/login/oauth/**"], parent: "login" }, context());
    await graphAreaUpsert(store, PLANNER, { name: "billing", purpose: "Invoices and refunds.", include: ["src/billing/**"] }, context());
    const fn = await graphSymbol(store, PLANNER, { name: "googleLogin" }, context());
    expect(fn.cards[0]!.areas).toEqual(["oauth", "login"]);
    const file = await graphSymbol(store, PLANNER, { name: "src/login/oauth/google.ts" }, context());
    expect(file.cards[0]!.areas).toEqual(["oauth", "login"]);
    // A test file in billing's folder: the area whose pattern is the most literal comes first.
    const test = await graphSymbol(store, PLANNER, { name: "src/billing/invoice.test.ts" }, context());
    expect(test.cards[0]!.areas).toEqual(["billing", TESTS_AREA]);
    const hits = await graphFind(store, PLANNER, { query: "invoiceTotal" }, context());
    expect(hits.hits[0]).toMatchObject({ kind: "symbol", path: "src/billing/invoice.ts", areas: ["billing"] });
  });

  test("search and scope keep to an area, or leave one out", async () => {
    await graphAreaUpsert(store, PLANNER, { name: "billing", purpose: "Invoices and refunds.", include: ["src/billing"] }, context());
    await graphAreaUpsert(store, PLANNER, { name: "login", purpose: "Sign-in.", include: ["src/login"] }, context());
    // "invoice" is in billing's names and in a login string.
    const all = await graphFind(store, PLANNER, { query: "invoice" }, context());
    expect(all.hits.some((h) => h.path.startsWith("src/billing/"))).toBe(true);
    const onlyLogin = await graphFind(store, PLANNER, { query: "invoice", area: "login" }, context());
    expect(onlyLogin.hits.every((h) => h.kind !== "dir" && h.path.startsWith("src/login/"))).toBe(true);
    const noTests = await graphFind(store, PLANNER, { query: "invoice", skip_areas: [TESTS_AREA] }, context());
    expect(noTests.hits.some((h) => h.path === "src/billing/invoice.test.ts")).toBe(false);

    const scope = await graphScope(store, PLANNER, { objective: "", anchors: ["invoiceTotal"] }, context());
    expect(scope.tests.map((t) => t.path)).toContain("src/billing/invoice.test.ts");
    expect(scope.files.find((f) => f.path === "src/billing/invoice.ts")?.areas).toEqual(["billing"]);
    const lean = await graphScope(store, PLANNER, { objective: "", anchors: ["invoiceTotal"], skip_areas: [TESTS_AREA] }, context());
    expect(lean.tests).toEqual([]);
    expect(lean.files.map((f) => f.path)).toContain("src/billing/invoice.ts");

    const unknown = await refusal(graphFind(store, PLANNER, { query: "invoice", area: "shipping" }, context()));
    expect(unknown.code).toBe("not_found");
    expect(unknown.message).toContain("billing");
  });

  test("a rebuild keeps the areas; one whose files are gone is broken, one that grew by more than a quarter is for review", async () => {
    await graphAreaUpsert(store, PLANNER, { name: "billing", purpose: "Invoices and refunds.", include: ["src/billing/*.ts"], exclude: ["**/*.test.ts"] }, context());
    await graphAreaUpsert(store, PLANNER, { name: "login", purpose: "Sign-in.", include: ["src/login"] }, context());
    rmSync(path.join(project, "src/billing"), { recursive: true });
    write({ "src/login/reset.ts": "export function reset() {}\n", "src/login/mfa.ts": "export function mfa() {}\n" });
    commit("drop billing, grow login");
    await indexProject(project, store, { rebuild: true });
    const { areas } = await graphAreas(store, PLANNER, {}, context());
    const named = (name: string) => areas.find((a) => a.name === name)!;
    expect(named("billing")).toMatchObject({ status: "broken", files: 0 });
    expect(named("billing").statusReason).toContain("matches no file");
    expect(named("login")).toMatchObject({ status: "review", files: 4, filesWhenWritten: 2 });
    expect(named(TESTS_AREA).status).toBe("ok");
    // Writing it again clears the mark.
    const { area } = await graphAreaUpsert(store, PLANNER, { name: "login", purpose: "Sign-in.", include: ["src/login"] }, context());
    expect(area).toMatchObject({ status: "ok", filesWhenWritten: 4 });
  });

  test("the main area is decided the same way every time: the most literal pattern, then the name that sorts first", async () => {
    // Both name the file by a pattern with as many characters before its first wildcard.
    await graphAreaUpsert(store, PLANNER, { name: "money", purpose: "x", include: ["src/billing/*.ts"] }, context());
    await graphAreaUpsert(store, PLANNER, { name: "invoices", purpose: "x", include: ["src/billing/inv*"] }, context());
    await graphAreaUpsert(store, PLANNER, { name: "billing", purpose: "x", include: ["src/billing/invoice.ts"] }, context());
    const card = await graphSymbol(store, PLANNER, { name: "src/billing/invoice.ts" }, context());
    // "src/billing/invoice.ts" is the most literal; "src/billing/inv*" and "src/billing/*.ts" differ by length; equal ones sort by name.
    expect(card.cards[0]!.areas).toEqual(["billing", "invoices", "money"]);
    await graphAreaUpsert(store, PLANNER, { name: "cash", purpose: "x", include: ["src/billing/*.ts"] }, context());
    expect((await graphSymbol(store, PLANNER, { name: "src/billing/refund.ts" }, context())).cards[0]!.areas).toEqual(["cash", "money"]);
  });

  test("the planner removes an area; tests stays, and a parent goes after its nested areas", async () => {
    await graphAreaUpsert(store, PLANNER, { name: "login", purpose: "Sign-in.", include: ["src/login"] }, context());
    await graphAreaUpsert(store, PLANNER, { name: "oauth", purpose: "Google.", include: ["src/login/oauth"], parent: "login" }, context());
    expect((await refusal(graphAreaRemove(store, PLANNER, { name: TESTS_AREA }, context()))).code).toBe("refused");
    expect((await refusal(graphAreaRemove(store, PLANNER, { name: "login" }, context()))).message).toContain("oauth");
    expect((await refusal(graphAreaRemove(store, WORKER, { name: "oauth" }, context()))).code).toBe("refused");
    expect((await refusal(graphAreaRemove(store, PLANNER, { name: "billing" }, context()))).code).toBe("not_found");
    expect(await graphAreaRemove(store, PLANNER, { name: "oauth" }, context())).toMatchObject({ removed: "oauth" });
    await graphAreaRemove(store, PLANNER, { name: "login" }, context());
    expect((await graphAreas(store, PLANNER, {}, context())).areas.map((a) => a.name)).toEqual([TESTS_AREA]);
  });

  test("the files in no area are listed with their count", async () => {
    await graphAreaUpsert(store, PLANNER, { name: "shop", purpose: "Everything under src.", include: ["src", "py", "go"] }, context());
    const { unplaced } = await graphAreas(store, PLANNER, { unplaced: 10 }, context());
    expect(unplaced).toEqual({ count: 2, files: [".gitignore", "README.md"] });
    expect((await graphAreas(store, PLANNER, { unplaced: 0 }, context())).unplaced).toEqual({ count: 2, files: [] });
  });

  test("a glob pattern: ** crosses folders, * stays in one, a folder holds its contents", () => {
    expect(globMatcher("src/**/*.ts")("src/a/b/c.ts")).toBe(true);
    expect(globMatcher("src/**/*.ts")("src/c.ts")).toBe(true);
    expect(globMatcher("src/*.ts")("src/a/c.ts")).toBe(false);
    expect(globMatcher("src/billing")("src/billing/x/y.ts")).toBe(true);
    expect(globMatcher("src/billing")("src/billing-old/y.ts")).toBe(false);
    expect(globMatcher("./src/billing/")("src/billing/y.ts")).toBe(true);
  });
});
