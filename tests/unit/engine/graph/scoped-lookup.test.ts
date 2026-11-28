// A name is looked up the way the language looks it up (trustmybot/tmb#246): from the call
// outward through the function's own names and parameters, the functions around it, the file,
// then what the file imports. The first place that has the name decides, and a name bound to
// no function of the repo there is not linked. A call on the object itself looks only in its
// class and the class's parents, and an import inside a function holds only there.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexProject, openView } from "../../../../src/engine/graph/fresh.ts";
import { openProjectStore, writeSetting } from "../../../../src/engine/index.ts";
import type { Actor, Store } from "../../../../src/engine/store/index.ts";
import { git } from "../../../lib/git.ts";

const HUMAN: Actor = { kind: "human" };

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let project: string;
let store: Store;

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "ts/utils.ts": lines(
    "export function buildSearchParams(q: string) { return q; }",
    "export function createContext(v: number) { return v; }",
    "export function startTransition(f: () => void) { f(); }",
    "export function secureHeaders(o: object) { return o; }",
    "export function helper() { return 0; }",
  ),
  "ts/base.ts": lines(
    "export class Base {",
    "  inherited() { return 1; }",
    "  overridden() { return 1; }",
    "}",
  ),
  // Cause 1: a call on `this` named like an import.
  "ts/client.ts": lines(
    "import { buildSearchParams, helper } from './utils';",
    "import { Base } from './base';",
    "type Fn = (q: string) => string;",
    "class Local {",
    "  sameFileParent() { return 2; }",
    "}",
    "export class Client extends Base {",
    "  private buildSearchParams: Fn = buildSearchParams;",
    "  run() {",
    "    this.buildSearchParams('a');",
    "    this.own();",
    "    this.inherited();",
    "    this.overridden();",
    "    this.helper();",
    "    return buildSearchParams('b');",
    "  }",
    "  own() { return 3; }",
    "  overridden() { return 4; }",
    "}",
    "export class Child extends Local {",
    "  go() { return this.sameFileParent(); }",
    "}",
    "export abstract class Shape {",
    "  abstract area(): number;",
    "  describe() { return this.area(); }",
    "}",
    "export class Square extends Shape {",
    "  area() { return 1; }",
    "}",
    "export const plain = {",
    "  run() { return this.helper(); },",
    "  helper() { return helper(); },",
    "};",
  ),
  // Cause 2: a parameter, or a name declared inside a function, that shadows an import.
  "ts/shadow.test.ts": lines(
    "import { createContext, startTransition, secureHeaders, helper } from './utils';",
    "function runner(createContext: typeof import('./utils').createContext) {",
    "  return createContext(1);",
    "}",
    "export function pending() {",
    "  const [busy, startTransition] = [false, (f: () => void) => f()];",
    "  startTransition(() => {});",
    "  return busy;",
    "}",
    "export function local() {",
    "  function helper() { return 9; }",
    "  return helper();",
    "}",
    "export function typed(options: Parameters<typeof secureHeaders>[0]) {",
    "  return secureHeaders(options);",
    "}",
    "export function imported() {",
    "  startTransition(() => {});",
    "  return createContext(2) + helper();",
    "}",
    "runner(createContext);",
  ),
  "py/__init__.py": "",
  "py/testing.py": lines(
    "class FlaskClient:",
    "    pass",
    "",
    "",
    "class FlaskCliRunner:",
    "    pass",
    "",
    "",
    "def helper():",
    "    return 1",
  ),
  "py/base.py": lines("class App:", "    def inherited(self):", "        return 1"),
  // Cause 3: an import inside one function leaks into another.
  "py/app.py": lines(
    "from .testing import helper",
    "from .base import App",
    "",
    "",
    "class Flask(App):",
    "    test_client_class = None",
    "",
    "    def test_client(self):",
    "        cls = self.test_client_class",
    "        if cls is None:",
    "            from .testing import FlaskClient as cls",
    "        return cls(self)",
    "",
    "    def test_cli_runner(self):",
    "        from .testing import FlaskCliRunner as cls",
    "        return cls(self)",
    "",
    "    def leaks(self):",
    "        return FlaskCliRunner(self)",
    "",
    "    def own(self):",
    "        self.inherited()",
    "        return self.test_cli_runner()",
    "",
    "",
    "def shadowed(helper):",
    "    return helper()",
    "",
    "",
    "def imported():",
    "    return helper()",
  ),
};

type Link = string | null;

beforeAll(async () => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-scoped-")));
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
  // These test the built-in rules, so the repo names them; the default is the language's tool (trustmybot/tmb#337).
  writeSetting(store, HUMAN, "graph_links", "built-in");
  await indexProject(project, store, { rebuild: false });
});

afterAll(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

/** What the call or instantiation of `name` on `line` of `file` links: `path:qualified_name`, or null. */
async function linkAt(file: string, line: number, name: string): Promise<Link> {
  const view = await openView(project, store);
  try {
    const rows = view.db
      .query(
        `SELECT d.path AS path, d.qualified_name AS qualified FROM edges e
         JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
         WHERE e.layer = ? AND s.path = ? AND e.line = ? AND e.dst_name = ? AND e.kind IN ('calls', 'instantiates')`,
      )
      .all(view.layer, file, line, name) as { path: string | null; qualified: string | null }[];
    if (rows.length !== 1) throw new Error(`${rows.length} references to ${name} at ${file}:${line}`);
    const [row] = rows;
    return row!.path === null ? null : `${row!.path}:${row!.qualified}`;
  } finally {
    view.db.close();
  }
}

test("a call on `this` is never linked to an import of the same name", async () => {
  // The class's own field, no function, is what `this.buildSearchParams` names.
  expect(await linkAt("ts/client.ts", 10, "buildSearchParams")).toBeNull();
  // No member of the class or its parent is named helper: the import is not looked at.
  expect(await linkAt("ts/client.ts", 14, "helper")).toBeNull();
  // The bare call still reaches the import.
  expect(await linkAt("ts/client.ts", 15, "buildSearchParams")).toBe("ts/utils.ts:buildSearchParams");
});

test("a call on `this` links a method of the class, else of its parent in another file or the same", async () => {
  expect(await linkAt("ts/client.ts", 11, "own")).toBe("ts/client.ts:Client.own");
  expect(await linkAt("ts/client.ts", 12, "inherited")).toBe("ts/base.ts:Base.inherited");
  expect(await linkAt("ts/client.ts", 13, "overridden")).toBe("ts/client.ts:Client.overridden");
  expect(await linkAt("ts/client.ts", 21, "sameFileParent")).toBe("ts/client.ts:Local.sameFileParent");
});

// An abstract method has only a declaration, so it is a node (trustmybot/tmb#367), and a call on
// the object itself links to it as to any method of its class.
test("a call on `this` to an abstract method links to it; one outside a class is not linked", async () => {
  expect(await linkAt("ts/client.ts", 25, "area")).toBe("ts/client.ts:Shape.area");
  expect(await linkAt("ts/client.ts", 31, "helper")).toBeNull();
});

test("a parameter or a variable that shadows an import is not linked to the import", async () => {
  expect(await linkAt("ts/shadow.test.ts", 3, "createContext")).toBeNull();
  expect(await linkAt("ts/shadow.test.ts", 7, "startTransition")).toBeNull();
});

test("a function declared inside a function is linked in place of the import it shadows", async () => {
  expect(await linkAt("ts/shadow.test.ts", 12, "helper")).toBe("ts/shadow.test.ts:helper");
});

test("an import named only in a parameter's type is not shadowed, and a real import call still links", async () => {
  expect(await linkAt("ts/shadow.test.ts", 15, "secureHeaders")).toBe("ts/utils.ts:secureHeaders");
  expect(await linkAt("ts/shadow.test.ts", 18, "startTransition")).toBe("ts/utils.ts:startTransition");
  expect(await linkAt("ts/shadow.test.ts", 19, "createContext")).toBe("ts/utils.ts:createContext");
  expect(await linkAt("ts/shadow.test.ts", 19, "helper")).toBe("ts/utils.ts:helper");
  expect(await linkAt("ts/shadow.test.ts", 21, "runner")).toBe("ts/shadow.test.ts:runner");
});

test("Python: an import inside a function holds there and leaks into no other function", async () => {
  // `cls` is a local variable here, and also imported in one branch: no one place proves it.
  expect(await linkAt("py/app.py", 12, "cls")).toBeNull();
  expect(await linkAt("py/app.py", 16, "FlaskCliRunner")).toBe("py/testing.py:FlaskCliRunner");
  expect(await linkAt("py/app.py", 19, "FlaskCliRunner")).toBeNull();
});

test("Python: a parameter that shadows an import is not linked; the import still links elsewhere", async () => {
  expect(await linkAt("py/app.py", 27, "helper")).toBeNull();
  expect(await linkAt("py/app.py", 31, "helper")).toBe("py/testing.py:helper");
});

test("Python: a call on `self` links a method of the class or of its parent", async () => {
  expect(await linkAt("py/app.py", 22, "inherited")).toBe("py/base.py:App.inherited");
  expect(await linkAt("py/app.py", 23, "test_cli_runner")).toBe("py/app.py:Flask.test_cli_runner");
});
