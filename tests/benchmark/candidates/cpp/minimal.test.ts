// The page's example in C++, for every candidate: `auto c = makeCart(); c.total()`, where the
// type of `c` is not written, links to `Cart::total`, defined out of its class in another file.
// Around it: an overload picked by the argument's type ([over.match]), a call in a lambda, a
// construction by the class's name, a virtual call through the base ([class.virtual]: decided at
// run time; the base's function is pure, a declaration and no node), a call of a lambda held in a
// local, and calls into the standard library. The expected answers are written from the page and
// the C++ standard, not from a tool.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { CANDIDATES, toolsSet } from "../c/candidates.ts";
import { minimal } from "../c/minimal.ts";
import { CPP_RULES } from "./rules_cpp.ts";

setDefaultTimeout(180_000);

const EXPECTED: Record<string, string> = {
  "Cart/cart.h:14 size": "outside",
  "Cart/cart.h:15 push_back": "outside",
  "Cart/cart.h:16 push_back": "outside",
  "Cart/cart.cc:3 add": "linked Cart/cart.h:15",
  "main.cc:5 makeCart": "linked Cart/cart.cc:11",
  "main.cc:6 add": "linked Cart/cart.h:16",
  "main.cc:7 total": "linked Cart/cart.cc:5",
  "main.cc:8 make_unique": "outside",
  "main.cc:9 total": "linked Cart/cart.cc:5",
  "main.cc:9 twice": "not known",
  "main.cc:9 size": "not known",
};
/** `Cart()` constructs a Cart: a link to the constructor or to the class is right. */
const CONSTRUCTION = "Cart/cart.cc:11 Cart";
const CONSTRUCTION_RIGHT = ["linked Cart/cart.cc:3", "linked Cart/cart.h:10", "linked Cart/cart.cc:3 + linked Cart/cart.h:10"];

const KNOWN_FAILURES: Record<string, string> = {
  clang: "a call to a function defined in another unit reaches its declaration, which is no node",
  "scip-clang": "it writes no occurrence for a symbol outside the project, so no call is proven outside",
};

describe.skipIf(!toolsSet())("C++ minimal example", async () => {
  const got = toolsSet() ? await minimal(CPP_RULES, path.join(import.meta.dir, "fixtures", "minimal"), "/usr/bin/clang++", ["-std=c++17"]) : new Map();
  for (const cand of CANDIDATES) {
    const check = () => {
      const answers = got.get(cand)!;
      expect(Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, answers.get(k)]))).toEqual(EXPECTED);
      expect(CONSTRUCTION_RIGHT).toContain(answers.get(CONSTRUCTION));
    };
    if (cand in KNOWN_FAILURES) test.failing(`${cand} (fails: ${KNOWN_FAILURES[cand]})`, check);
    else test(cand, check);
  }
});
