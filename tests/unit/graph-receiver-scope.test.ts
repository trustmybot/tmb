// A method call on a receiver links through the receiver's type, read where the language reads it
// (trustmybot/tmb#364): the declaration the receiver's name finds in its own scope, the function,
// the blocks and functions around it, then the file, and for `this.x` the class `this` is an
// instance of. Only a plain class name written as the type, or the class a `new` constructs when
// no type is written, is proof. A declaration whose written type is anything else, a generic, a
// union, `any`, makes the receiver's type not known; it never borrows the type of a same-named
// receiver elsewhere in the file.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexProject, openView } from "../../src/engine/graph/fresh.ts";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { compilerLookup, judge } from "../../src/engine/graph/languages/typescript/links.ts";
import { openProjectStore, writeSetting } from "../../src/engine/index.ts";
import type { Actor, Store } from "../../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let project: string;
let store: Store;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  // The issue's repro: `c` is typed in two functions; the second's type is no plain name.
  "src/cart.ts": lines(
    "export class Cart { total(): number { return 1; } }",
    "export class Basket { total(): number { return 2; } }",
    "export function one(c: Cart): number { return c.total(); }",
    "export function two(c: Readonly<Basket>): number { return c.total(); }",
  ),
  // The same rule with other names and shapes.
  "src/books.ts": lines(
    "type Wrapped<T> = T;",
    "export class Ledger { post(): number { return 1; } }",
    "export class Journal { post(): number { return 2; } }",
    "export function makeJournal(): Journal { return new Journal(); }",
    "export function constructed(): number {",
    "  const entry = new Ledger();",
    "  return entry.post(); // constructed",
    "}",
    "export function generic(): number {",
    "  const entry: Wrapped<Journal> = makeJournal();",
    "  return entry.post(); // generic",
    "}",
    "export function first(item: Ledger): number { return item.post(); }",
    "export function second(item: Journal): number { return item.post(); }",
    "export function nested(item: Ledger): number {",
    "  const inner = (item: Journal): number => item.post(); // inner",
    "  return inner(new Journal()) + item.post(); // outer",
    "}",
    "export function shadowsClass(Ledger: any): number { return Ledger.post(); }",
    "export class Desk {",
    "  constructor(private drawer: Ledger) {}",
    "  open(): number { return this.drawer.post(); } // desk",
    "}",
    "export class Table {",
    "  drawer = makeJournal();",
    "  open(): number { return this.drawer.post(); } // table",
    "}",
    "export class Chair {",
    "  drawer: Journal = makeJournal();",
    "  open(): number { return this.drawer.post(); } // chair",
    "}",
    "export class Stool {",
    "  open(): number { return this.drawer.post(); } // stool",
    "}",
    "const shared = new Ledger();",
    "export function fileLevel(): number { return shared.post(); }",
    "export function paramOverFile(shared: Journal): number { return shared.post(); }",
  ),
  // A class named as the type with type arguments is still that class; the written name is
  // looked up in the receiver's own scope, and an interface, an alias or a type parameter is no class.
  "src/wire.ts": lines(
    "interface Settings { region: string }",
    "export class Session<T> { send(): number { return 1; } }",
    "export interface Channel<T> { send(): number }",
    "type Line<T> = Session<T>;",
    "export function withArgs(s: Session<Settings>): number { return s.send(); } // with args",
    "export function viaInterface(s: Channel<Settings>): number { return s.send(); } // interface",
    "export function viaAlias(s: Line<Settings>): number { return s.send(); } // alias",
    "export function shadowed<Session extends { send(): number }>(s: Session): number { return s.send(); } // type parameter",
    "export function fromContext(list: Session<Settings>[]): void { list.forEach((s) => s.send()); } // context",
    "export class Hub {",
    "  line: Session<Settings> = new Session();",
    "  ping(): number { return this.line.send(); } // field",
    "}",
    "export function built(): number {",
    "  const s = new Session<Settings>();",
    "  return s.send(); // built",
    "}",
  ),
};

type Link = string | null;

beforeAll(async () => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-receiver-")));
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

/** The 1-based line of `file` that holds `marker`, which must be on exactly one line. */
function lineWith(file: string, marker: string): number {
  const all = FIXTURE[file]!.split("\n");
  const at = all.flatMap((l, i) => (l.includes(marker) ? [i + 1] : []));
  if (at.length !== 1) throw new Error(`${at.length} lines of ${file} hold ${marker}`);
  return at[0]!;
}

/** What the call of `name` on the line of `file` holding `marker` links: `path:qualified_name`, or null. */
async function linkAt(file: string, marker: string, name: string): Promise<Link> {
  const view = await openView(project, store);
  try {
    const rows = view.db
      .query(
        `SELECT d.path AS path, d.qualified_name AS qualified FROM edges e
         JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
         WHERE e.layer = ? AND s.path = ? AND e.line = ? AND e.dst_name = ? AND e.kind = 'calls'`,
      )
      .all(view.layer, file, lineWith(file, marker), name) as { path: string | null; qualified: string | null }[];
    if (rows.length !== 1) throw new Error(`${rows.length} calls of ${name} at ${file}: ${marker}`);
    const [row] = rows;
    return row!.path === null ? null : `${row!.path}:${row!.qualified}`;
  } finally {
    view.db.close();
  }
}

test("the issue's repro: a receiver typed as no plain name does not borrow another function's type", async () => {
  expect(await linkAt("src/cart.ts", "function one(", "total")).toBe("src/cart.ts:Cart.total");
  expect(await linkAt("src/cart.ts", "function two(", "total")).toBeNull();
});

test("a variable's written type that is no plain name makes its type not known; a `new` with no type gives the class", async () => {
  expect(await linkAt("src/books.ts", "// constructed", "post")).toBe("src/books.ts:Ledger.post");
  expect(await linkAt("src/books.ts", "// generic", "post")).toBeNull();
});

test("a receiver's type is read in its own function, the innermost binding first", async () => {
  expect(await linkAt("src/books.ts", "function first(", "post")).toBe("src/books.ts:Ledger.post");
  expect(await linkAt("src/books.ts", "function second(", "post")).toBe("src/books.ts:Journal.post");
  expect(await linkAt("src/books.ts", "// inner", "post")).toBe("src/books.ts:Journal.post");
  expect(await linkAt("src/books.ts", "// outer", "post")).toBe("src/books.ts:Ledger.post");
  expect(await linkAt("src/books.ts", "function fileLevel(", "post")).toBe("src/books.ts:Ledger.post");
  expect(await linkAt("src/books.ts", "function paramOverFile(", "post")).toBe("src/books.ts:Journal.post");
});

test("a parameter named like a class is that parameter, not the class", async () => {
  expect(await linkAt("src/books.ts", "function shadowsClass(", "post")).toBeNull();
});

test("`this.x` is read in the class `this` is an instance of, and a field with no written type is not known", async () => {
  expect(await linkAt("src/books.ts", "// desk", "post")).toBe("src/books.ts:Ledger.post");
  expect(await linkAt("src/books.ts", "// chair", "post")).toBe("src/books.ts:Journal.post");
  expect(await linkAt("src/books.ts", "// table", "post")).toBeNull();
  expect(await linkAt("src/books.ts", "// stool", "post")).toBeNull();
});

test("a class written as the type with type arguments is that class; an interface, an alias or a type parameter is not", async () => {
  expect(await linkAt("src/wire.ts", "// with args", "send")).toBe("src/wire.ts:Session.send");
  expect(await linkAt("src/wire.ts", "// field", "send")).toBe("src/wire.ts:Session.send");
  expect(await linkAt("src/wire.ts", "// built", "send")).toBe("src/wire.ts:Session.send");
  expect(await linkAt("src/wire.ts", "// interface", "send")).toBeNull();
  expect(await linkAt("src/wire.ts", "// alias", "send")).toBeNull();
  expect(await linkAt("src/wire.ts", "// type parameter", "send")).toBeNull();
  expect(await linkAt("src/wire.ts", "// context", "send")).toBeNull();
});

test("every link the fixture's calls make agrees with the compiler", async () => {
  const lookup = compilerLookup(project, resolveCommit(project, "HEAD")!);
  const view = await openView(project, store);
  try {
    const made = view.db
      .query(
        `SELECT s.path AS src, e.line AS line, e.pos AS pos, e.dst_name AS name, d.path AS dst, d.start_line AS start, d.end_line AS end, e.kind AS kind
           FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
          WHERE e.layer = ? AND e.kind = 'calls' AND e.dst_name IN ('total', 'post', 'send')`,
      )
      .all(view.layer) as { src: string; line: number; pos: number | null; name: string; dst: string; start: number; end: number; kind: string }[];
    expect(made.length).toBeGreaterThan(0);
    for (const l of made) expect({ at: `${l.src}:${l.line}`, verdict: judge(l, lookup).verdict }).toEqual({ at: `${l.src}:${l.line}`, verdict: "right" });
  } finally {
    view.db.close();
  }
});
