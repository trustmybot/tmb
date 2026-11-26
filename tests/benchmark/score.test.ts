// The benchmark's arithmetic (trustmybot/tmb#244), from the definitions of CODE_GRAPH.md's
// Benchmark section, on small hand-made inputs: what each score counts, that a stored score which
// falls fails, and that a way not built has no score rather than a zero.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  callsAccountedFor,
  ENFORCED,
  entry,
  falls,
  format,
  functionsFound,
  type GraphCall,
  linksFoundByReference,
  linksFoundByState,
  NOT_BUILT,
  type ReferenceCall,
  rises,
  SCORE_NAMES,
  type Stored,
  type WayScores,
} from "./score.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

describe("the page's example", () => {
  // "A file has 10 calls: 6 linked, 3 to an outside package, 1 not known. Links found is 6 of 7.
  // Calls accounted for is 10 of 10."
  test("10 calls, 6 linked, 3 outside, 1 not known: links found 6 of 7", () => {
    expect(linksFoundByState({ linked: 6, outside: 3, notKnown: 1 })).toEqual({ n: 6, of: 7 });
  });

  test("the same 10 calls, each with a state in the function the reference finds them in: accounted for 10 of 10", () => {
    const reference = new Map([["cart.ts:1-20", 10]]);
    const graph = new Map([["cart.ts:1-20", 10]]);
    expect(callsAccountedFor(reference, graph)).toEqual({ n: 10, of: 10 });
  });
});

describe("calls accounted for", () => {
  test("a call the graph holds under another function than the reference's is not accounted for", () => {
    const reference = new Map([
      ["a.py:1-5", 3],
      ["a.py:7-9", 2],
    ]);
    // One call of 7-9 counted for 1-5 instead.
    const graph = new Map([
      ["a.py:1-5", 4],
      ["a.py:7-9", 1],
    ]);
    expect(callsAccountedFor(reference, graph)).toEqual({ n: 4, of: 5 });
  });

  test("a call put outside the repo that the reference declares in it is not accounted for", () => {
    expect(callsAccountedFor(new Map([["a.ts:", 4]]), new Map([["a.ts:", 4]]), 1)).toEqual({ n: 3, of: 4 });
  });
});

describe("functions found", () => {
  test("of the reference's functions, the share the graph has, matched by file and lines; an extra one adds nothing", () => {
    const reference = new Map([
      ["a.py", ["1-3", "5-9", "6-6"]],
      ["b.py", ["2-4"]],
    ]);
    const graph = new Map([
      ["a.py", ["1-3", "5-9", "11-12"]],
      ["c.py", ["1-1"]],
    ]);
    expect(functionsFound(reference, graph)).toEqual({ n: 2, of: 4 });
  });
});

describe("links found against the reference", () => {
  const call = (line: number, name: string, dst: string, start: number, end: number, cause: string): ReferenceCall => ({
    file: "use.ts",
    lines: [line],
    names: [name],
    decls: [{ file: dst, spans: [{ start, end }] }],
    cause,
  });
  const link = (line: number, name: string, dst: string, start: number, end: number): GraphCall => ({ file: "use.ts", line, name, dst, start, end });

  test("a reference link counts as found when the graph links that call to a declaration the reference gives", () => {
    const reference = [call(3, "total", "cart.ts", 1, 4, "a name called directly"), call(4, "tax", "cart.ts", 6, 8, "a receiver whose type is not written")];
    const r = linksFoundByReference(reference, [link(3, "total", "cart.ts", 1, 4)]);
    expect({ n: r.n, of: r.of }).toEqual({ n: 1, of: 2 });
    expect(r.misses).toEqual({ "a receiver whose type is not written": 1 });
  });

  test("a link to another declaration than the reference's is no find", () => {
    const r = linksFoundByReference([call(3, "total", "cart.ts", 1, 4, "a name called directly")], [link(3, "total", "report.ts", 1, 4)]);
    expect({ n: r.n, of: r.of }).toEqual({ n: 0, of: 1 });
  });

  test("one link of the graph finds one call, not two calls of the same name on its line", () => {
    const twice = [call(3, "total", "cart.ts", 1, 4, "a name called directly"), call(3, "total", "cart.ts", 1, 4, "a name called directly")];
    const r = linksFoundByReference(twice, [link(3, "total", "cart.ts", 1, 4)]);
    expect({ n: r.n, of: r.of }).toEqual({ n: 1, of: 2 });
  });

  test("a call recorded on the callee's line or by the name an import declares it as is found", () => {
    const spread: ReferenceCall = { file: "use.ts", lines: [3, 5], names: ["sum", "total"], decls: [{ file: "cart.ts", spans: [{ start: 1, end: 4 }] }], cause: "x" };
    expect(linksFoundByReference([spread], [link(5, "total", "cart.ts", 2, 2)]).n).toBe(1);
  });
});

const scored = (n: number, of: number): WayScores => ({
  functionsFound: { n: of, of },
  linksRight: { n: of, of },
  linksFoundByState: { n, of },
  linksFoundByReference: { n, of },
  callsAccountedFor: { n: of, of },
  missesByCause: {},
});
const stored = (a: WayScores): Stored => ({ command: "test", entries: [entry({ repo: "r", language: "typescript", commit: "c", reference: "ref" }, a)] });

describe("a fall fails", () => {
  test("a score lower than the stored one is a fall, named by repo, way and score", () => {
    const f = falls(stored(scored(6, 7)), stored(scored(5, 7)));
    expect(f).toEqual([expect.stringContaining("r typescript way A linksFoundByReference")]);
  });

  // "Links found is scored against the reference": links found from the call states is shown, never enforced.
  test("links found from the call states may fall; links found against the reference may not", () => {
    const byState = scored(6, 7);
    byState.linksFoundByState = { n: 1, of: 7 };
    expect(falls(stored(scored(6, 7)), stored(byState))).toEqual([]);
    byState.linksFoundByState = { notScored: "not judged" };
    expect(falls(stored(scored(6, 7)), stored(byState))).toEqual([]);
    expect(ENFORCED).toEqual(["functionsFound", "linksRight", "linksFoundByReference", "callsAccountedFor"]);
  });

  test("every enforced score that falls is named", () => {
    const low: WayScores = { functionsFound: { n: 1, of: 2 }, linksRight: { n: 1, of: 2 }, linksFoundByState: { n: 1, of: 2 }, linksFoundByReference: { n: 1, of: 2 }, callsAccountedFor: { n: 1, of: 2 }, missesByCause: {} };
    const f = falls(stored(scored(2, 2)), stored(low)).join("\n");
    for (const name of ENFORCED) expect(f).toContain(`way A ${name}:`);
    expect(f).not.toContain("linksFoundByState");
  });

  test("the same share over other counts is no fall; a higher one is a rise", () => {
    expect(falls(stored(scored(6, 7)), stored(scored(12, 14)))).toEqual([]);
    expect(rises(stored(scored(6, 7)), stored(scored(12, 14)))).toEqual([]);
    expect(falls(stored(scored(6, 7)), stored(scored(7, 7)))).toEqual([]);
    expect(rises(stored(scored(6, 7)), stored(scored(7, 7)))).toHaveLength(2);
  });

  test("a stored score that is no longer scored, or a stored repo that is no longer measured, is a fall", () => {
    const gone = scored(6, 7);
    gone.linksFoundByReference = { notScored: "not judged" };
    expect(falls(stored(scored(6, 7)), stored(gone))).toEqual([expect.stringContaining("linksFoundByReference")]);
    expect(falls(stored(scored(6, 7)), { command: "test", entries: [] })).toEqual([expect.stringContaining("no longer measured")]);
  });
});

describe("way B is not built, not zero", () => {
  test("every score of way B says it is not built, and none is a number", () => {
    const e = entry({ repo: "r", language: "python", commit: "c", reference: "ref" }, scored(1, 2));
    for (const name of SCORE_NAMES) {
      expect(e.ways.B[name]).toEqual({ notScored: NOT_BUILT });
      expect(format(e.ways.B[name])).toBe(NOT_BUILT);
    }
    expect(e.ways.B.missesByCause).toEqual({ notScored: NOT_BUILT });
  });

  test("a way not built neither falls nor rises; built later, it only rises", () => {
    const before = stored(scored(1, 2));
    expect(falls(before, before)).toEqual([]);
    const later = stored(scored(1, 2));
    later.entries[0]!.ways.B = scored(0, 2);
    expect(falls(before, later)).toEqual([]);
  });

  test("a share of nothing reads as none, not as zero", () => {
    expect(format({ n: 0, of: 0 })).toBe("none");
    expect(format({ n: 6, of: 7 })).toBe("85.7% (6/7)");
  });
});
