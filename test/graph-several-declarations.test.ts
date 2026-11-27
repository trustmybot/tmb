// A call that can go to more than one declaration (trustmybot/tmb#344, CODE_GRAPH.md "Two ways to
// make links"): it links to each one that is a node, and is linked when at least one is. This holds
// only where the language's rule proves each one:
// - a member of a union or an intersection type is each member type's own member, so a call of it
//   can go to each (the compiler gives one symbol per member type);
// - an overload set is one function: its signatures have no body, so its one definition is the node;
// - a merged declaration (a class with an interface and a namespace of its name, a function with a
//   namespace) is one name: a call of it goes to the declaration that runs, the class or the function.
// Several declarations that merely share a name, such as a function declared twice in one scope,
// stay unlinked: only one of them runs, and which is not proven here.
// The built-in rules (way A) have no type for a value of a union, so they leave those calls unlinked.
// Each expectation is read off the rule, not off the graph's output.
import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../src/engine/graph/build.ts";
import { openGraphDb } from "../src/engine/graph/db.ts";
import { checkLayer, commitTexts, compilerProgram } from "../src/engine/graph/languages/typescript/links.ts";
import { installPinnedTools } from "../tests/lib/pinned-tools.ts";

setDefaultTimeout(30_000);

// Way B loads the TypeScript compiler from tmb's tools folder; the setup installs tmb's pinned copy.
beforeAll(installPinnedTools);

let project: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(files: Record<string, string>): string {
  for (const [file, text] of Object.entries({ ".gitignore": ".tmb/\nnode_modules/\n", ...files })) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  return git(project, "rev-parse", "HEAD");
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-several-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]) => [...l, ""].join("\n");

const FILES = {
  // Two classes of the repo, one with an overload set.
  "src/shapes.ts": lines(
    "export class Circle {",
    "  area(): number {",
    "    return 3;",
    "  }",
    "  scale(by: string): Circle;",
    "  scale(by: number): Circle;",
    "  scale(by: unknown): Circle {",
    "    return this;",
    "  }",
    "}",
    "export class Square {",
    "  area(): number {",
    "    return 4;",
    "  }",
    "  scale(by: number): Square {",
    "    return this;",
    "  }",
    "  toString(): string {",
    '    return "square";',
    "  }",
    "}",
  ),
  // A class merged with an interface and a namespace of its name; a function merged with a namespace.
  "src/cart.ts": lines(
    "export class Cart {",
    "  total(): number {",
    "    return 1;",
    "  }",
    "}",
    "export interface Cart {",
    "  total(): number;",
    "}",
    "export namespace Cart {",
    "  export const currency = 'EUR';",
    "}",
    "export class Basket {",
    "  total(): number {",
    "    return 2;",
    "  }",
    "}",
    "export function format(c: Cart): string {",
    "  return String(c.total());",
    "}",
    "export namespace format {",
    "  export const separator = ',';",
    "}",
  ),
  "src/use.ts": lines(
    'import { Circle, Square } from "./shapes";',
    'import { Basket, Cart, format } from "./cart";',
    "export function areaOf(shape: Circle | Square): number {",
    "  return shape.area();",
    "}",
    "export function both(shape: Circle & Square): number {",
    "  return shape.area();",
    "}",
    "export function grow(shape: Circle | Square): Circle | Square {",
    "  return shape.scale(2);",
    "}",
    "export function growCircle(circle: Circle): Circle {",
    '  return circle.scale("twice");',
    "}",
    "export function label(shape: Square | Date): string {",
    "  return shape.toString();",
    "}",
    "export function make(): Cart {",
    "  return new Cart();",
    "}",
    "export function shown(c: Cart): string {",
    "  return format(c);",
    "}",
    "export function sum(bag: Cart | Basket): number {",
    "  return bag.total();",
    "}",
  ),
  // A function declared twice in one scope: only the second runs, so the two merely share a name.
  "src/legacy.js": lines("function pick() {", "  return 1;", "}", "function pick() {", "  return 2;", "}", "export function choose() {", "  return pick();", "}"),
};

type Row = { src: string; name: string; pos: number; dst: string | null; state: string | null; way: string | null };

function rows(db: Database, layer: string): Row[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name AS name, e.pos, d.path || ':' || d.qualified_name AS dst, e.call_state AS state, e.way
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.kind IN ('calls', 'instantiates')`,
    )
    .all(layer) as Row[];
}

/** The one call of `name` that `src` makes: its state, and every node it links, sorted. */
function callOf(all: Row[], src: string, name: string): { state: string | null; links: string[] } {
  const mine = all.filter((r) => r.src === src && r.name === name);
  const positions = new Set(mine.map((r) => r.pos));
  if (positions.size !== 1) throw new Error(`${positions.size} calls of ${name} in ${src}`);
  // A call is in exactly one state, however many links it has.
  const states = mine.filter((r) => r.state !== null);
  if (states.length !== 1) throw new Error(`the call of ${name} in ${src} has ${states.length} states`);
  return { state: states[0]!.state, links: mine.flatMap((r) => (r.dst === null ? [] : [r.dst])).sort() };
}

async function build(way: "built-in" | "language-tool") {
  const sha = commit(FILES);
  const db = openGraphDb(project, null);
  await buildLayer(db, project, sha, "g", { force: true, links: way });
  return { db, sha, all: rows(db, "g") };
}

describe("way B: a call that can go to more than one declaration", () => {
  test("a call on a value of a union of two classes of the repo links to each class's method", async () => {
    const { db, all } = await build("language-tool");
    expect(callOf(all, "src/use.ts:areaOf", "area")).toEqual({ state: "linked", links: ["src/shapes.ts:Circle.area", "src/shapes.ts:Square.area"] });
    expect(all.filter((r) => r.src === "src/use.ts:areaOf" && r.name === "area").every((r) => r.way === "language-tool")).toBe(true);
    db.close();
  });

  test("a call on a value of an intersection links to each member type's method", async () => {
    const { db, all } = await build("language-tool");
    expect(callOf(all, "src/use.ts:both", "area")).toEqual({ state: "linked", links: ["src/shapes.ts:Circle.area", "src/shapes.ts:Square.area"] });
    db.close();
  });

  test("an overload set is its one definition; on a union it links to each class's", async () => {
    const { db, all } = await build("language-tool");
    expect(callOf(all, "src/use.ts:growCircle", "scale")).toEqual({ state: "linked", links: ["src/shapes.ts:Circle.scale"] });
    expect(callOf(all, "src/use.ts:grow", "scale")).toEqual({ state: "linked", links: ["src/shapes.ts:Circle.scale", "src/shapes.ts:Square.scale"] });
    db.close();
  });

  test("a declaration outside the repo is left out; the call links to the node and is linked", async () => {
    const { db, all } = await build("language-tool");
    expect(callOf(all, "src/use.ts:label", "toString")).toEqual({ state: "linked", links: ["src/shapes.ts:Square.toString"] });
    db.close();
  });

  test("a merged declaration links to the declaration that runs: the class, the function, the class's method", async () => {
    const { db, all } = await build("language-tool");
    expect(callOf(all, "src/use.ts:make", "Cart")).toEqual({ state: "linked", links: ["src/cart.ts:Cart"] });
    expect(callOf(all, "src/use.ts:shown", "format")).toEqual({ state: "linked", links: ["src/cart.ts:format"] });
    expect(callOf(all, "src/cart.ts:format", "total")).toEqual({ state: "linked", links: ["src/cart.ts:Cart.total"] });
    expect(callOf(all, "src/use.ts:sum", "total")).toEqual({ state: "linked", links: ["src/cart.ts:Basket.total", "src/cart.ts:Cart.total"] });
    db.close();
  });

  test("a function declared twice in one scope merely shares its name: the call is not known", async () => {
    const { db, all } = await build("language-tool");
    expect(callOf(all, "src/legacy.js:choose", "pick")).toEqual({ state: "not_known", links: [] });
    db.close();
  });

  test("the judge finds every link right, and every call is counted once", async () => {
    const { db, sha } = await build("language-tool");
    const texts = commitTexts(project, sha);
    const { links, calls } = checkLayer(db, compilerProgram(project, sha, texts), texts, "g");
    expect(links.wrong).toEqual([]);
    expect(links.right).toBe(links.links);
    expect(calls.differ).toEqual([]);
    expect(calls.accounted).toBe(calls.compiler);
    db.close();
  });
});

describe("way A: the built-in rules have no type for a value of a union", () => {
  test("the calls on a union are not linked, and the twice-declared function is not linked", async () => {
    const { db, all } = await build("built-in");
    expect(callOf(all, "src/use.ts:areaOf", "area").links).toEqual([]);
    expect(callOf(all, "src/use.ts:grow", "scale").links).toEqual([]);
    expect(callOf(all, "src/use.ts:sum", "total").links).toEqual([]);
    expect(callOf(all, "src/legacy.js:choose", "pick")).toEqual({ state: "not_known", links: [] });
    db.close();
  });
});
