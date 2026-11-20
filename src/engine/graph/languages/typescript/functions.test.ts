// Every function of TypeScript, TSX and JavaScript in the code graph (trustmybot/tmb#140): each
// is one node, unnamed ones included, with a link to what contains it, matched one to one
// against a second, independent parser on a fixture and on tmb's own repo.
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type ExtractedSymbol, extractFile, inSymbolScope } from "../../extract.ts";
import { loadParsers, type Parsers } from "../../loader.ts";
import { compilerFunctions, coveredLanguage, graphFunctions, surplus } from "./coverage.ts";

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
    // A signature without a body is not a function.
    expect(all.filter((s) => s.qualified_name === "overloaded").length).toBe(1);
    expect(all.some((s) => s.qualified_name === "declaredOnly" || s.qualified_name === "Base.shape")).toBe(false);
  });

  test("functions inside JSX are nodes, named by the attribute or call they are passed to", () => {
    const all = symbols("src/list.tsx", JSX);
    expect(fn(all, "callback of `map`").unnamed).toBe(1);
    expect(fn(all, "callback of `onClick`").unnamed).toBe(1);
    expect(fn(all, "callback of `onPick`").unnamed).toBe(1);
    expect(fn(all, "default export").unnamed).toBe(1);
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

describe("the coverage test on tmb's own repo", () => {
  test("every TypeScript and JavaScript function of the repo is one node of the graph, and no node is more", () => {
    const files = spawnSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
      .stdout.split("\n")
      .filter((file) => file !== "" && inSymbolScope(file) && coveredLanguage(file) !== null);
    let total = 0;
    const misses: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(REPO, file), "utf8");
      } catch {
        continue; // deleted in the working folder, not yet committed
      }
      const want = compilerFunctions(file, text);
      const have = graphFunctions(parsers, file, text);
      total += want.length;
      for (const lines of surplus(want, have)) misses.push(`missing ${file}:${lines}`);
      for (const lines of surplus(have, want)) misses.push(`extra ${file}:${lines}`);
    }
    expect(misses).toEqual([]);
    expect(total).toBeGreaterThan(3000);
  });
});
