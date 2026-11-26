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

let fixture: string;
let commit: string;
let links: GraphLink[];

beforeAll(async () => {
  fixture = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-links-")));
  for (const [file, text] of Object.entries(FIXTURE)) {
    mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    writeFileSync(path.join(fixture, file), text);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: fixture, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  commit = resolveCommit(fixture, "HEAD")!;
  const db = openGraphDb(path.join(fixture, "scratch"));
  try {
    await buildLayer(db, fixture, commit, "base", { force: true });
    links = graphLinks(db);
  } finally {
    db.close();
  }
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
    // use(): renderA, renderB, make and `.map` written in it, and `render()` in its arrow.
    expect(calls.accounted).toBe(5);
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
    const call = (dst: string, start: number, end: number): GraphLink => ({ src: "use.ts", line: 5, name: "render", dst, start, end, kind: "calls" });
    expect(judge(call("a.ts", 1, 3), lookup).verdict).toBe("right");
    expect(judge(call("b.ts", 1, 3), lookup).verdict).toBe("wrong");
    const method: GraphLink = { src: "use.ts", line: 7, name: "make", dst: "factory.ts", start: 2, end: 2, kind: "calls" };
    expect(judge(method, lookup)).toMatchObject({ verdict: "wrong", reexport: true });
    expect(judge({ ...method, start: 4, end: 4 }, lookup)).toMatchObject({ verdict: "right", reexport: true });
    // A name the line does not hold is not judged.
    expect(judge({ ...method, name: "nothing" }, lookup).verdict).toBe("no reference");
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
