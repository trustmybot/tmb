// The page's example in C, for every candidate: `c = makeCart(); c.total()` where the type of `c`
// is not written. C has no methods, so the example is a call by name through a value whose type is
// not written (`__auto_type`, a GNU extension clang reads), to a function declared in a header and
// defined in another file. Two functions named `helper` have internal linkage (C11 6.2.2p3), so a
// call reaches the one in its own file only. A call through a function pointer field is decided at
// run time. The expected answers are written from the page and the C standard, not from a tool.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { CANDIDATES, toolsSet } from "./candidates.ts";
import { minimal } from "./minimal.ts";
import { C_RULES } from "./rules_c.ts";

setDefaultTimeout(120_000);

const EXPECTED: Record<string, string> = {
  "Cart/cart.c:9 malloc": "outside",
  "Cart/cart.c:11 helper": "linked Cart/cart.c:4",
  "main.c:8 make_cart": "linked Cart/cart.c:8",
  "main.c:9 cart_total": "linked Cart/cart.c:15",
  "main.c:10 total": "not known",
  "main.c:11 printf": "outside",
  "main.c:11 helper": "linked main.c:5",
};

/** Candidates that fail the example, and why; each is reported, not fixed. */
const KNOWN_FAILURES: Record<string, string> = {
  // The compiler alone sees one unit: a function defined in another unit is only its prototype.
  clang: "a call to a function defined in another unit reaches its prototype, which is no node",
  // scip-clang gives two functions with internal linkage and the same name one symbol.
  "scip-clang": "both `helper`s are one symbol, so each call links to both",
};

describe.skipIf(!toolsSet())("C minimal example", async () => {
  const got = toolsSet() ? await minimal(C_RULES, path.join(import.meta.dir, "fixtures", "minimal"), "/usr/bin/clang", ["-std=gnu11"]) : new Map();
  for (const cand of CANDIDATES) {
    const check = () => {
      const answers = got.get(cand)!;
      expect(Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, answers.get(k)]))).toEqual(EXPECTED);
    };
    if (cand in KNOWN_FAILURES) test.failing(`${cand} (fails: ${KNOWN_FAILURES[cand]})`, check);
    else test(cand, check);
  }
});
