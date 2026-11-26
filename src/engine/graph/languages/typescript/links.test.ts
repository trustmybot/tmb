// Every cross-file link the code graph makes for a call or a construction in TypeScript and
// JavaScript agrees with the TypeScript compiler (trustmybot/tmb#242), on a fixture, on tmb's own
// repo and on hono pinned. A link the graph did not make is no failure; one that disagrees is.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinnedHono } from "../../../../../tests/lib/pinned-repo.ts";
import { buildLayer } from "../../build.ts";
import { BUILT_IN, LANGUAGE_TOOL, type LinkWay } from "../../ways.ts";
import { openGraphDb } from "../../db.ts";
import { resolveCommit } from "../../git-source.ts";
import { type CallReport, checkLinks, checkRepo, compilerCalls, compilerLookup, type GraphLink, graphLinks, judge, type LinkReport } from "./links.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);
// A whole repo's graph and the compiler's program over it: about 4s for tmb, 5s for hono.
const REPO_TIMEOUT = 180_000;

const REPO = path.resolve(import.meta.dir, "../../../../..");

const FIXTURE: Record<string, string> = {
  "a.ts": "export function render() {\n  return 1;\n}\n",
  "b.ts": "export function render() {\n  return 2;\n}\n",
  "factory.ts": "export class Factory {\n  make = () => 1;\n}\nexport const make = () => 2;\n",
  "index.ts": "export * from './factory';\n",
  "outside.ts": "export const count = parseInt('7', 10);\n",
  "use.ts": [
    "import { render as renderA } from './a';",
    "import { render as renderB } from './b';",
    "import { make } from './index';",
    "export function use() {",
    "  renderA();",
    "  renderB();",
    "  make();",
    "  return [renderA, renderB].map((render) => render());",
    "}",
    "",
  ].join("\n"),
};

/** A git repo in a scratch folder holding `files` in one commit, and that commit. */
function makeRepo(files: Record<string, string>): { dir: string; commit: string } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-links-")));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  return { dir, commit: resolveCommit(dir, "HEAD")! };
}

/** The cross-file links of the repo's graph, built the way asked. */
async function linksOf(dir: string, commit: string, way: LinkWay): Promise<GraphLink[]> {
  const db = openGraphDb(path.join(dir, "scratch"));
  try {
    await buildLayer(db, dir, commit, "base", { force: true, links: way });
    return graphLinks(db);
  } finally {
    db.close();
  }
}

let fixture: string;
let commit: string;
let links: GraphLink[];

beforeAll(async () => {
  ({ dir: fixture, commit } = makeRepo(FIXTURE));
  links = await linksOf(fixture, commit, BUILT_IN);
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

const at = (line: number, name: string) => links.filter((l) => l.src === "use.ts" && l.line === line && l.name === name).map((l) => `${l.dst}:${l.start}`);

describe("the graph's links agree with the compiler on a fixture", () => {
  test("two imports of one name under two aliases each link their own file", () => {
    expect(at(5, "render")).toEqual(["a.ts:1"]);
    expect(at(6, "render")).toEqual(["b.ts:1"]);
    expect(at(8, "render").sort()).toEqual(["a.ts:1", "b.ts:1"]);
  });

  test("an imported name links the function, never a class's method of that name", () => {
    expect(at(7, "make")).toEqual(["factory.ts:4"]);
  });

  test("every call is accounted for, in the function it is written in", async () => {
    const { calls } = await checkRepo(fixture);
    expectCallsAccounted(calls);
    // use(): renderA, renderB, make and `.map` written in it, and `render()` in its arrow; and
    // `parseInt` at the top of outside.ts, a global, outside the repo.
    expect(calls.accounted).toBe(6);
    expect(calls.outside).toBe(1);
  });

  test("a call written in a type is no call, and one in a class body outside its methods counts for the file", () => {
    const text = ['let d: import("m").T;', "class C {", "  n = f();", "  m() {", "    return g(new C());", "  }", "}", ""].join("\n");
    expect([...compilerCalls("x.ts", text)]).toEqual([
      ["", 1],
      ["4-6", 2],
    ]);
  });

  test("every link is right, and one through `export *` counts as a re-export", async () => {
    const report = await checkLinks(fixture);
    expect(report.wrong).toEqual([]);
    expect(report.right).toBe(report.links);
    expect(report.links).toBeGreaterThanOrEqual(5);
    expect(report.reexports.right).toBe(1);
  });

  test("a link to another file or another declaration than the compiler's is wrong", () => {
    const lookup = compilerLookup(fixture, commit);
    const use = FIXTURE["use.ts"]!;
    const call = (dst: string, start: number, end: number): GraphLink => ({ src: "use.ts", line: 5, pos: use.indexOf("renderA();"), name: "render", dst, start, end, kind: "calls" });
    expect(judge(call("a.ts", 1, 3), lookup).verdict).toBe("right");
    expect(judge(call("b.ts", 1, 3), lookup).verdict).toBe("wrong");
    const method: GraphLink = { src: "use.ts", line: 7, pos: use.indexOf("make();"), name: "make", dst: "factory.ts", start: 2, end: 2, kind: "calls" };
    expect(judge(method, lookup)).toMatchObject({ verdict: "wrong", reexport: true });
    expect(judge({ ...method, start: 4, end: 4 }, lookup)).toMatchObject({ verdict: "right", reexport: true });
    // A name the line does not hold is not judged.
    expect(judge({ ...method, name: "nothing" }, lookup).verdict).toBe("no reference");
    // A use that is no call, `renderA` passed as a value, has no position: it is judged on its line.
    const value: GraphLink = { src: "use.ts", line: 8, pos: null, name: "render", dst: "a.ts", start: 1, end: 3, kind: "calls" };
    expect(judge(value, lookup).verdict).toBe("right");
  });

  test("a link into the repo where the compiler names only a declaration outside the repo is wrong", () => {
    const lookup = compilerLookup(fixture, commit);
    const outside: GraphLink = { src: "outside.ts", line: 1, pos: FIXTURE["outside.ts"]!.indexOf("parseInt"), name: "parseInt", dst: "a.ts", start: 1, end: 3, kind: "calls" };
    expect(judge(outside, lookup).verdict).toBe("wrong");
  });
});

// "Two ways to make links": a call is identified by its position in the file, where the name it
// calls is written, so two calls of one name on one line each get their own answer. Links right
// judges a call's link by the compiler's answer for that call alone.
describe("links right judges a call by its position", () => {
  const SAME_LINE: Record<string, string> = {
    "store.ts": "export class Store {\n  get() {\n    return 1;\n  }\n}\n",
    "cache.ts": "export class Cache {\n  get() {\n    return 2;\n  }\n}\n",
    "use.ts": ["import { Store } from './store';", "import { Cache } from './cache';", "export function use(a: Store, b: Cache) {", "  a.get(); b.get();", "}", ""].join("\n"),
  };
  const USE_LINE = 4;
  const text = SAME_LINE["use.ts"]!;
  // Where each `get` is written: after `a.` and after `b.`.
  const posA = text.indexOf("a.get") + "a.".length;
  const posB = text.indexOf("b.get") + "b.".length;
  // Store.get and Cache.get, each at lines 2 to 4 of its file.
  const toStore = (pos: number): GraphLink => ({ src: "use.ts", line: USE_LINE, pos, name: "get", dst: "store.ts", start: 2, end: 4, kind: "calls" });
  const toCache = (pos: number): GraphLink => ({ ...toStore(pos), dst: "cache.ts" });

  let repo: { dir: string; commit: string };
  beforeAll(() => {
    repo = makeRepo(SAME_LINE);
  });
  afterAll(() => {
    rmSync(repo.dir, { recursive: true, force: true });
  });

  test("each call of a name on a line is judged by its own declaration", () => {
    const lookup = compilerLookup(repo.dir, repo.commit);
    expect(judge(toStore(posA), lookup).verdict).toBe("right");
    expect(judge(toCache(posB), lookup).verdict).toBe("right");
    // The other call's declaration, on the same line, does not make a link right.
    expect(judge(toCache(posA), lookup).verdict).toBe("wrong");
    expect(judge(toStore(posB), lookup).verdict).toBe("wrong");
  });

  test("the graph records each call where its name is written, and each link is judged right", async () => {
    const made = (await linksOf(repo.dir, repo.commit, LANGUAGE_TOOL)).filter((l) => l.src === "use.ts" && l.name === "get");
    expect(made.map((l) => `${l.pos} ${l.dst}`).sort()).toEqual([`${posA} store.ts`, `${posB} cache.ts`].sort());
    const lookup = compilerLookup(repo.dir, repo.commit);
    for (const l of made) expect(judge(l, lookup).verdict).toBe("right");
    // Swapped, each is wrong.
    for (const l of made) expect(judge({ ...l, dst: l.dst === "store.ts" ? "cache.ts" : "store.ts" }, lookup).verdict).toBe("wrong");
  });
});

function report(repo: string, r: LinkReport, c?: CallReport): void {
  console.log(
    `links vs compiler, ${repo}: ${r.links} links, ${r.right} right, ${r.wrong.length} wrong, not judged ${JSON.stringify(r.notJudged)}; ` +
      `through a re-export ${r.reexports.right} right, ${r.reexports.wrong} wrong; graph ${r.ms.graph}ms, compiler ${r.ms.compiler}ms`,
  );
  if (c !== undefined) {
    console.log(
      `calls vs compiler, ${repo}: ${c.accounted} of ${c.compiler} accounted for, ${c.linked} linked, ${c.outside} outside, ${c.notKnown} not known; ` +
        `links found ${(c.linksFound * 100).toFixed(1)}%; ${c.differ.length} functions counted otherwise, ${c.outsideWrong.length} outside calls the compiler finds in the repo`,
    );
  }
}

// The call states of trustmybot/tmb#252: each function's linked, outside and not known calls add
// up to the calls the compiler finds written in it, and no call put outside the repo is one the
// compiler finds declared in it.
function expectCallsAccounted(c: CallReport): void {
  expect(c.differ).toEqual([]);
  expect(c.outsideWrong).toEqual([]);
  expect(c.accounted).toBe(c.compiler);
  expect(c.linked + c.outside + c.notKnown).toBe(c.accounted);
}

describe("the link check on tmb's own repo", () => {
  test(
    "every cross-file call and construction link the graph makes in TypeScript and JavaScript is the compiler's",
    async () => {
      const { links: r, calls } = await checkRepo(REPO);
      report("tmb", r, calls);
      expectCallsAccounted(calls);
      expect(r.wrong).toEqual([]);
      expect(r.right).toBeGreaterThan(3000);
      expect(r.reexports.right).toBeGreaterThan(100);
    },
    REPO_TIMEOUT,
  );
});

// The same check on the pinned public repo of trustmybot/tmb#247. CI fetches it before
// `bun test`; locally the test runs when the cache folder or TMB_PINNED_HONO holds it, and is
// skipped, saying why, when not.
describe("the link check on hono, pinned", () => {
  const pinned = pinnedHono();
  const name = "every cross-file call and construction link the graph makes in hono at 75ff8e3 is the compiler's";
  if ("skip" in pinned) {
    console.warn(`skipped: ${name}: ${pinned.skip}`);
    test.skip(`${name} (skipped: ${pinned.skip})`, () => {});
  } else {
    test(
      name,
      async () => {
        if ("error" in pinned) throw new Error(pinned.error);
        const { links: r, calls } = await checkRepo(pinned.folder);
        report("hono 75ff8e3", r, calls);
        expectCallsAccounted(calls);
        expect(r.wrong).toEqual([]);
        expect(r.right).toBeGreaterThan(5000);
        expect(r.reexports.right).toBeGreaterThan(500);
      },
      REPO_TIMEOUT,
    );
  }
});
