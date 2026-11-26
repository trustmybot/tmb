// Each candidate tool for way B (trustmybot/tmb#338) on the page's own example (CODE_GRAPH.md, "Two
// ways to make links", Example 1): `const c = makeCart(); c.total()`. The compiler knows
// `makeCart` returns a `Cart`, so the call links to `Cart.total`. The expected answers are the
// page's, written before any candidate ran. A candidate that is not installed is skipped, saying
// why: tmb installs nothing (ts7.ts).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCall, ToolNode } from "../../../../src/engine/graph/languages/contract.ts";
import { CANDIDATES } from "./candidates.ts";
import { ts7Package } from "./ts7.ts";

setDefaultTimeout(30_000);

// A comment of characters outside ASCII before the calls: a position counts UTF-16 units, as the
// graph's do, never bytes.
const CART = `export class Cart {
  items: number[] = [];
  total(): number {
    return this.items.reduce((a, b) => a + b, 0);
  }
}

export function makeCart() {
  return new Cart();
}
`;
const CHECKOUT = `import { makeCart } from "./cart";
// «ünïcödé» 😀
export function checkout() {
  const c = makeCart();
  return c.total();
}
`;
const files = new Map([
  ["src/cart.ts", CART],
  ["src/checkout.ts", CHECKOUT],
]);
const nodes: ToolNode[] = [
  { path: "src/cart.ts", name: "Cart", start: 1, end: 6 },
  { path: "src/cart.ts", name: "total", start: 3, end: 5 },
  { path: "src/cart.ts", name: "makeCart", start: 8, end: 10 },
  { path: "src/checkout.ts", name: "checkout", start: 3, end: 6 },
];
const at = (file: string, text: string, written: string, name: string): ToolCall => ({ path: file, pos: text.indexOf(written) + written.indexOf(name), name });
const calls: ToolCall[] = [
  at("src/checkout.ts", CHECKOUT, "makeCart()", "makeCart"),
  at("src/checkout.ts", CHECKOUT, "c.total()", "total"),
  at("src/cart.ts", CART, ".reduce(", "reduce"),
  at("src/cart.ts", CART, "new Cart()", "Cart"),
];

for (const candidate of CANDIDATES) {
  const missing = candidate.id.startsWith("ts7") ? ts7Package() : null;
  describe.skipIf(missing !== null && "unavailable" in missing)(`${candidate.label}`, () => {
    test("c.total() on what makeCart() returns links to Cart.total; the library's reduce is outside", () => {
      // A folder named in mixed case: a compiler may know a file by a lower-case path on a file system that ignores case.
      const dir = mkdtempSync(path.join(tmpdir(), "tmb-Candidate-"));
      try {
        const opened = candidate.tool.open(dir);
        if ("unavailable" in opened) throw new Error(opened.unavailable);
        const answers = opened.answer({ files, configs: new Map(), nodes, calls });
        expect(answers).toEqual([{ node: 2 }, { node: 1 }, { state: "outside" }, { node: 0 }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
