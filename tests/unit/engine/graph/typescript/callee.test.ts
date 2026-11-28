// A call's callee is named by the callee expression itself (trustmybot/tmb#326). A prefix
// operator, `await`, `void`, `typeof`, `!` or `-`, applies to the whole call written after it:
// in the language's grammar a call binds tighter than any prefix operator, so `await f<T>()` is
// `await (f<T>())` and its callee is `f`. tree-sitter-typescript reads a call with type arguments
// after such an operator as a call of the operator's expression, `(await f)<T>()`; the callee's
// name must still be `f`. Every expectation is written from that rule, by hand.
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { extractFile } from "../../../../../src/engine/graph/extract.ts";
import { loadParsers, type Parsers } from "../../../../../src/engine/graph/loader.ts";
import type { ExtractedEdge, ExtractedSymbol } from "../../../../../src/engine/graph/languages/contract.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const PREFIXED = `import { schedule } from "./queue";

async function fetchPage<T>(url: string): Promise<T> {
  return url as T;
}

class Ledger<T> {
  constructor(public start: T) {}
}

const client = {
  post<T>(body: T): T {
    return body;
  },
};

export async function refresh() {
  const page = await fetchPage<string>("/home");
  await new Ledger<number>(1);
  await client.post<number>(2);
  await await fetchPage<string>("/twice");
  await schedule<number>(() => 3);
  void fetchPage<string>("/void");
  return !fetchPage<number>("/not");
}

export function* pages() {
  yield fetchPage<string>("/yield");
}

export function described() {
  const kind = typeof fetchPage<string>("/typeof");
  return -fetchPage<number>("/minus");
}

export function returned() {
  return fetchPage<string>("/return");
}
`;

let parsers: Parsers;
beforeAll(async () => {
  parsers = await loadParsers();
});

function calls(lang: "typescript" | "tsx", from: string): string[] {
  const { symbols, edges } = extractFile(parsers, `src/prefixed.${lang === "tsx" ? "tsx" : "ts"}`, lang, PREFIXED);
  const src = symbols.findIndex((s: ExtractedSymbol) => s.qualified_name === from && s.kind === "function");
  if (src < 0) throw new Error(`no function ${from}`);
  return edges.filter((e: ExtractedEdge) => e.src === src && e.call === 1).map((e) => e.dst_name);
}

describe("a call after a prefix operator is named by its callee", () => {
  for (const lang of ["typescript", "tsx"] as const) {
    test(`${lang}: after await, the callee's own name, for a function, a constructor and a method`, () => {
      expect(calls(lang, "refresh")).toEqual(["fetchPage", "Ledger", "post", "fetchPage", "schedule", "fetchPage", "fetchPage"]);
    });

    test(`${lang}: after yield, return, typeof and minus, the callee's own name`, () => {
      expect(calls(lang, "pages")).toEqual(["fetchPage"]);
      expect(calls(lang, "described")).toEqual(["fetchPage", "fetchPage"]);
      expect(calls(lang, "returned")).toEqual(["fetchPage"]);
    });

    test(`${lang}: a function passed to such a call is named by the callee`, () => {
      const { symbols } = extractFile(parsers, "src/prefixed.ts", lang, PREFIXED);
      expect(symbols.filter((s) => s.kind === "function" && s.qualified_name.startsWith("callback of")).map((s) => s.qualified_name)).toEqual([
        "callback of `schedule`",
      ]);
    });
  }
});
