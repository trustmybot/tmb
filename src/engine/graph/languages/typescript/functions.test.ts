// Every function of TypeScript, TSX and JavaScript in the code graph (trustmybot/tmb#140): each
// is one node, unnamed ones included, with a link to what contains it, matched one to one
// against a second, independent parser on a fixture and on tmb's own repo.
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type ExtractedSymbol, extractFile, inSymbolScope } from "../../extract.ts";
import { loadParsers, type Parsers } from "../../loader.ts";
import { pinnedHono } from "../../../../../tests/lib/pinned-repo.ts";
import { parseErrors, parseRepaired } from "./repair.ts";
import { compilerFunctions, coveredLanguage, graphFunctions, surplus } from "./coverage.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const REPO = path.resolve(import.meta.dir, "../../../../..");

let parsers: Parsers;
beforeAll(async () => {
  parsers = await loadParsers();
});

// One case of each kind of function the measurement of 2026-11-20 counted, and the shapes
// around them: a signature without a body is no function.
const KINDS = `import { run } from "./lib";

export function topLevel(a: number): number {
  function innerNamed() {
    return a;
  }
  const innerArrow = () => innerNamed();
  return [a].map((x) => x + innerArrow()).length;
}

export const topArrow = async (s: string) => s.trim();

export class Shop {
  private total = 0;
  onChange = (n: number) => {
    this.total = n;
  };
  constructor(start: number) {
    this.total = start;
  }
  get value(): number {
    return this.total;
  }
  set value(n: number) {
    this.total = n;
  }
  *items() {
    yield this.total;
  }
  load(): void {
    run(() => this.total);
  }
}

export const handlers = {
  save(id: string) {
    return id;
  },
  remove: (id: string) => id,
  ["computed"]: function () {
    return 1;
  },
};

export function makeCounter() {
  let n = 0;
  return () => ++n;
}

export function overloaded(a: string): string;
export function overloaded(a: number): number;
export function overloaded(a: unknown): unknown {
  return a;
}

declare function declaredOnly(): void;

export abstract class Base {
  abstract shape(): string;
  describe() {
    return this.shape();
  }
}

(function () {
  return 0;
})();

test("lists open tasks", () => {
  expect(topLevel(1)).toBe(1);
});
`;

const JSX = `export function List(props: { items: string[]; onPick: (s: string) => void }) {
  return (
    <ul>
      {props.items.map((item) => (
        <li key={item} onClick={() => props.onPick(item)}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export default function () {
  return <List items={[]} onPick={function (s) { console.log(s); }} />;
}
`;

const JS = `const express = require("express");
module.exports.start = function start(port) {
  const app = express();
  app.get("/", (req, res) => res.send("ok"));
  app.listen(port, function () {
    console.log("listening");
  });
};
exports.helper = () => 1;
`;

// Generic call signatures, each `<` on its own line, as hono's factory helper writes them
// (trustmybot/tmb#247): tree-sitter-typescript reads the `<` as type arguments of the line
// before, and lost every function after it.
const CALL_SIGNATURES = `export interface CreateHandlers<E> {
  <I>(handler1: I): [I]

  // two handlers
  <
    I,
    I2 = I,
  >(handler1: I, handler2: I2): [I, I2]
}

export interface UseState {
  value: number
  <T>(initial: T): [T, (t: T) => void]
  <T = undefined>(): [T | undefined, (t: T) => void]
}

export class Factory<E> {
  #options?: E
  constructor(init?: E) {
    this.#options = init
  }
  createApp = (options?: E): E | undefined => options ?? this.#options
  createHandlers: CreateHandlers<E> = (...handlers: any) => {
    return handlers.filter((handler: unknown) => handler !== undefined)
  }
}

export const createFactory = <E,>(init?: E): Factory<E> => new Factory<E>(init)
`;

// Decorated classes and members (trustmybot/tmb#317). A symbol's lines start at its first
// decorator and end at its last line ("Kinds of symbol" in CODE_GRAPH.md), as the compiler's do.
const DECORATED = `function cache(): any { return () => {}; }
function inject(): any { return () => {}; }
@cache()
export class Store {
  @cache()
  // a comment between two decorators
  @cache()
  load(): number {
    return 1;
  }
  @cache()
  get size(): number { return 0; }
  @cache()
  static make(): Store { return new Store(1); }
  @cache() async fetch(): Promise<number> { return 1; }
  @cache()
  label = "";
  constructor(@inject() n: number) {}
}
@cache()
class Plain {
  @cache()
  run() {}
}
export { Plain };
`;

// The same shapes in JavaScript, which has no types and no parameter decorators.
const DECORATED_JS = `function cache() { return () => {}; }
@cache()
export class Store {
  @cache()
  // a comment between two decorators
  @cache()
  load() {
    return 1;
  }
  @cache()
  get size() { return 0; }
  @cache()
  static make() { return new Store(); }
  @cache() async fetch() { return 1; }
  @cache()
  label = "";
}
`;

// Methods that have only a declaration ("A function with a declaration and a definition is one
// node" in CODE_GRAPH.md, trustmybot/tmb#367): an interface's, an abstract one, one of an ambient
// class. Each is a method node named through its type; overload signatures of one name in one type
// are one node, from the first to the last; a signature beside a body of its name is no node, the
// body is. An alias written as an object type lists its methods as an interface does; a signature
// in an object type with no name of its own, as a parameter's, is no node.
const BODILESS = `export interface Ledger {
  post(entry: string): void;
  balance(): number;
  balance(asOf: Date): number;
  readonly size: number;
  get open(): boolean;
  set open(v: boolean);
  (raw: string): void;
  new (seed: number): Ledger;
}

export abstract class Shape {
  abstract area(): number;
  abstract get sides(): number;
  scale(by: number): Shape;
  scale(by: string): Shape;
  scale(by: unknown): Shape {
    return this;
  }
}

declare class Remote {
  constructor(url: string);
  fetch(path: string): Promise<string>;
}

type Bag = { take(): number };
export function useBag(bag: { give(): number }): Bag {
  return { take: () => bag.give() };
}
`;

// A named type that lists its methods holds them, whatever keyword declares it: an alias written
// directly as an object type too. A class and an interface of one name that both list a method
// give one node, the class's. A method of an object type inside another type has no type of its own.
const LISTED = `export type Till = {
  open(): void;
  count(n: number): number;
  count(n: string): number;
  readonly id: string;
};
export type Pair = [{ left(): void }];
export interface Clock {
  tick(): void;
  reset(): void;
}
export class Clock {
  tick(): void {}
}
`;

function symbols(relPath: string, text: string): ExtractedSymbol[] {
  const lang = coveredLanguage(relPath);
  if (lang === null) throw new Error(relPath);
  return extractFile(parsers, relPath, lang, text).symbols;
}

const fn = (all: ExtractedSymbol[], name: string): ExtractedSymbol => {
  const hit = all.find((s) => s.qualified_name === name && (s.kind === "function" || s.kind === "method"));
  if (!hit) throw new Error(`no function ${name} in ${all.map((s) => s.qualified_name).join(", ")}`);
  return hit;
};

describe("every function is a node", () => {
  for (const [file, text] of [
    ["src/kinds.ts", KINDS],
    ["src/list.tsx", JSX],
    ["web/server.js", JS],
    ["src/factory.ts", CALL_SIGNATURES],
    ["src/decorated.ts", DECORATED],
    ["src/decorated.tsx", DECORATED],
    ["web/decorated.js", DECORATED_JS],
    ["src/ledger.ts", BODILESS],
    ["src/till.ts", LISTED],
  ] as const) {
    test(`${file} matches the TypeScript compiler one to one`, () => {
      const want = compilerFunctions(file, text);
      const have = graphFunctions(parsers, file, text);
      expect({ missing: surplus(want, have), extra: surplus(have, want) }).toEqual({ missing: [], extra: [] });
      expect(want.length).toBeGreaterThan(3);
    });
  }

  test("each kind of function has its node and its name", () => {
    const all = symbols("src/kinds.ts", KINDS);
    // A named function at the top of a file, and a `const f = () => …` there.
    expect(fn(all, "topLevel").unnamed).toBeUndefined();
    expect(fn(all, "topArrow").kind).toBe("function");
    // Class methods, a constructor, getters and setters, a generator and a class field.
    for (const name of ["Shop.constructor", "Shop.items", "Shop.load", "Shop.onChange", "Base.describe"]) expect(fn(all, name).kind).toBe("method");
    expect(all.filter((s) => s.qualified_name === "Shop.value").length).toBe(2);
    // A named function and a `const f = () => …` inside another function.
    expect(fn(all, "innerNamed").reach).toBe("nested");
    expect(fn(all, "innerArrow").reach).toBe("nested");
    // A callback, named by where it is used; for a test, with the test's name.
    expect(fn(all, "callback of `map`").unnamed).toBe(1);
    expect(fn(all, "callback of `run`").unnamed).toBe(1);
    expect(fn(all, "callback of `test` 'lists open tasks'").unnamed).toBe(1);
    // An object's methods and properties take their key.
    for (const name of ["save", "remove", "computed"]) expect(fn(all, name).reach).toBe("member");
    // A returned function and an immediately called one are named by their line.
    expect(fn(all, "function at line 47").unnamed).toBe(1);
    expect(fn(all, "function at line 65").unnamed).toBe(1);
    // An overload signature is no function: the body is. A method with only a declaration is one.
    expect(all.filter((s) => s.qualified_name === "overloaded").length).toBe(1);
    expect(fn(all, "Base.shape").kind).toBe("method");
  });

  test("a method with only a declaration is a node named through its type; its overloads are one", () => {
    const all = symbols("src/ledger.ts", BODILESS);
    const lines = (name: string) => all.filter((s) => s.kind === "method" && s.qualified_name === name).map((s) => [s.start_line, s.end_line]);
    expect(lines("Ledger.post")).toEqual([[2, 2]]);
    expect(lines("Ledger.balance")).toEqual([[3, 4]]);
    expect(lines("Ledger.open")).toEqual([[6, 6], [7, 7]]);
    expect(lines("Shape.area")).toEqual([[13, 13]]);
    expect(lines("Shape.sides")).toEqual([[14, 14]]);
    expect(lines("Shape.scale")).toEqual([[17, 19]]);
    expect(lines("Remote.constructor")).toEqual([[23, 23]]);
    expect(lines("Remote.fetch")).toEqual([[24, 24]]);
    expect(lines("Bag.take")).toEqual([[27, 27]]);
    // A property, a call signature and a construct signature are no methods; nor is a method of a type with no name.
    expect(all.some((s) => ["Ledger.size", "take", "give", "useBag.give"].includes(s.qualified_name) && s.kind === "method")).toBe(false);
    // Each is held by its type.
    const ledger = all.findIndex((s) => s.kind === "interface" && s.qualified_name === "Ledger");
    const shape = all.findIndex((s) => s.kind === "class" && s.qualified_name === "Shape");
    expect(fn(all, "Ledger.post").parent).toBe(ledger);
    expect(fn(all, "Shape.area").parent).toBe(shape);
  });

  test("the compiler's list holds a method with only a declaration, its overloads once", () => {
    const want = compilerFunctions("src/ledger.ts", BODILESS);
    for (const lines of ["2-2", "3-4", "6-6", "7-7", "13-13", "14-14", "17-19", "23-23", "24-24", "27-27"]) expect(want).toContain(lines);
    expect(want).not.toContain("15-15");
    expect(want.filter((l) => l === "28-28")).toEqual([]);
  });

  test("an alias written as an object type holds its methods; a class and an interface of one name give the class's", () => {
    const all = symbols("src/till.ts", LISTED);
    const lines = (name: string) => all.filter((s) => s.kind === "method" && s.qualified_name === name).map((s) => [s.start_line, s.end_line]);
    expect(lines("Till.open")).toEqual([[2, 2]]);
    expect(lines("Till.count")).toEqual([[3, 4]]);
    expect(all.some((s) => s.kind === "method" && (s.qualified_name.endsWith("left") || s.qualified_name === "Till.id"))).toBe(false);
    expect(lines("Clock.tick")).toEqual([[13, 13]]);
    expect(lines("Clock.reset")).toEqual([[10, 10]]);
    const till = all.findIndex((s) => s.kind === "type" && s.qualified_name === "Till");
    expect(fn(all, "Till.open").parent).toBe(till);
    const want = compilerFunctions("src/till.ts", LISTED);
    for (const l of ["2-2", "3-4", "10-10", "13-13"]) expect(want).toContain(l);
    for (const l of ["7-7", "9-9"]) expect(want).not.toContain(l);
  });

  test("functions inside JSX are nodes, named by the attribute or call they are passed to", () => {
    const all = symbols("src/list.tsx", JSX);
    expect(fn(all, "callback of `map`").unnamed).toBe(1);
    expect(fn(all, "callback of `onClick`").unnamed).toBe(1);
    expect(fn(all, "callback of `onPick`").unnamed).toBe(1);
    expect(fn(all, "default export").unnamed).toBe(1);
  });

  test("a generic call signature on its own line hides no function after it", () => {
    const all = symbols("src/factory.ts", CALL_SIGNATURES);
    for (const name of ["Factory.constructor", "Factory.createApp", "Factory.createHandlers"]) expect(fn(all, name).kind).toBe("method");
    expect(fn(all, "createFactory").kind).toBe("function");
    expect(fn(all, "callback of `filter`").unnamed).toBe(1);
    const iface = all.find((s) => s.kind === "interface" && s.qualified_name === "CreateHandlers");
    expect([iface?.start_line, iface?.end_line]).toEqual([1, 9]);
  });

  test("a decorated symbol's lines start at its first decorator and end at its last line", () => {
    for (const [file, text] of [
      ["src/decorated.ts", DECORATED],
      ["web/decorated.js", DECORATED_JS],
    ] as const) {
      const all = symbols(file, text);
      const at = (kind: string, name: string) => {
        const s = all.find((x) => x.kind === kind && x.qualified_name === name);
        return [s?.start_line, s?.end_line];
      };
      const o = file.endsWith(".js") ? -1 : 0; // the JavaScript fixture has one helper fewer above
      expect(at("class", "Store")).toEqual([3 + o, file.endsWith(".js") ? 17 : 19]);
      expect(at("method", "Store.load")).toEqual([5 + o, 10 + o]);
      expect(at("method", "Store.size")).toEqual([11 + o, 12 + o]);
      expect(at("method", "Store.make")).toEqual([13 + o, 14 + o]);
      expect(at("method", "Store.fetch")).toEqual([15 + o, 15 + o]);
    }
    const ts = symbols("src/decorated.ts", DECORATED);
    const lines = (kind: string, name: string) => ts.filter((x) => x.kind === kind && x.qualified_name === name).map((s) => [s.start_line, s.end_line]);
    // A parameter's decorator is inside its constructor: the constructor starts at its own line.
    expect(lines("method", "Store.constructor")).toEqual([[18, 18]]);
    expect(lines("class", "Plain")).toEqual([[20, 24]]);
    expect(lines("method", "Plain.run")).toEqual([[22, 23]]);
  });

  test("the repair keeps every line and column, and touches a file it cannot improve not at all", () => {
    const parser = parsers.get("typescript")!;
    const repaired = parseRepaired(parser, CALL_SIGNATURES)!;
    expect(repaired.src.length).toBe(CALL_SIGNATURES.length);
    expect(repaired.src.split("\n").length).toBe(CALL_SIGNATURES.split("\n").length);
    expect(repaired.tree.rootNode.hasError).toBe(false);
    repaired.tree.delete();
    for (const text of [KINDS, "const a = b\n  < c\n", "if (x) {\n  <T>(y: T) => y\n}\n"]) {
      const plain = parsers.get("typescript")!.parse(text)!;
      const kept = parseRepaired(parser, text)!;
      expect(kept.src === text || parseErrors(kept.tree.rootNode) < parseErrors(plain.rootNode)).toBe(true);
      plain.delete();
      kept.tree.delete();
    }
  });

  test("a function assigned to a property takes the property's name", () => {
    const all = symbols("web/server.js", JS);
    expect(fn(all, "start").reach).toBe("member");
    expect(fn(all, "helper").reach).toBe("member");
    expect(fn(all, "callback of `get` '/'").unnamed).toBe(1);
    expect(fn(all, "callback of `listen`").unnamed).toBe(1);
  });
});

describe("every symbol has a container", () => {
  test("a nested function's container is its parent function, a method's its class, the rest the file", () => {
    const all = symbols("src/kinds.ts", KINDS);
    const index = (s: ExtractedSymbol) => all.indexOf(s);
    expect(all[0]!.kind).toBe("module");
    expect(all[0]!.parent).toBeUndefined();
    for (const s of all.slice(1)) expect(s.parent).toBeNumber();
    expect(fn(all, "innerNamed").parent).toBe(index(fn(all, "topLevel")));
    expect(fn(all, "innerArrow").parent).toBe(index(fn(all, "topLevel")));
    expect(fn(all, "callback of `map`").parent).toBe(index(fn(all, "topLevel")));
    const shop = all.findIndex((s) => s.kind === "class" && s.qualified_name === "Shop");
    expect(fn(all, "Shop.load").parent).toBe(shop);
    expect(fn(all, "callback of `run`").parent).toBe(index(fn(all, "Shop.load")));
    expect(fn(all, "topLevel").parent).toBe(0);
    expect(fn(all, "save").parent).toBe(0);
  });

  test("an unnamed function's owner is the nearest named function around it", () => {
    const all = symbols("src/kinds.ts", KINDS);
    expect(fn(all, "callback of `map`").owner).toBe(all.indexOf(fn(all, "topLevel")));
    expect(fn(all, "callback of `test` 'lists open tasks'").owner).toBe(0);
  });

  test("a call made inside an unnamed function starts at that function", () => {
    const { symbols: all, edges } = extractFile(parsers, "src/kinds.ts", "typescript", KINDS);
    const callback = all.indexOf(fn(all, "callback of `map`"));
    expect(edges.filter((e) => e.src === callback && e.kind === "calls").map((e) => e.dst_name)).toEqual(["innerArrow"]);
  });

});

/** Each function of a repo's TypeScript and JavaScript the graph misses or adds, and how many the compiler finds. */
function repoCoverage(repo: string): { total: number; misses: string[] } {
  const files = spawnSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })
    .stdout.split("\n")
    .filter((file) => file !== "" && inSymbolScope(file) && coveredLanguage(file) !== null);
  let total = 0;
  const misses: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(path.join(repo, file), "utf8");
    } catch {
      continue; // deleted in the working folder, not yet committed
    }
    const want = compilerFunctions(file, text);
    const have = graphFunctions(parsers, file, text);
    total += want.length;
    for (const lines of surplus(want, have)) misses.push(`missing ${file}:${lines}`);
    for (const lines of surplus(have, want)) misses.push(`extra ${file}:${lines}`);
  }
  return { total, misses };
}

describe("the coverage test on tmb's own repo", () => {
  test("every TypeScript and JavaScript function of the repo is one node of the graph, and no node is more", () => {
    const { total, misses } = repoCoverage(REPO);
    expect(misses).toEqual([]);
    expect(total).toBeGreaterThan(3000);
  });
});

// The same check on one pinned public repo (trustmybot/tmb#247), so a form tmb's own code does
// not use is still caught. CI fetches it before `bun test`; locally the test runs when the
// cache folder or TMB_PINNED_HONO holds it, and is skipped, saying why, when not.
describe("the coverage test on hono, pinned", () => {
  const pinned = pinnedHono();
  const name = "every TypeScript and JavaScript function of hono at 75ff8e3 is one node of the graph, and no node is more";
  if ("skip" in pinned) {
    console.warn(`skipped: ${name}: ${pinned.skip}`);
    test.skip(`${name} (skipped: ${pinned.skip})`, () => {});
  } else {
    test(name, () => {
      if ("error" in pinned) throw new Error(pinned.error);
      const { total, misses } = repoCoverage(pinned.folder);
      expect(misses).toEqual([]);
      expect(total).toBeGreaterThan(10_000);
    });
  }
});
