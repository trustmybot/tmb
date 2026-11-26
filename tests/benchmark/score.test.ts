// The benchmark's arithmetic (trustmybot/tmb#244), from the definitions of CODE_GRAPH.md's
// Benchmark section, on small hand-made inputs: what each score counts, that a stored score which
// falls fails, and that a way not built has no score rather than a zero.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  callsAccountedFor,
  ENFORCED,
  entry,
  acceptFallIssue,
  acceptFalls,
  carryAccepted,
  falls,
  format,
  functionsFound,
  type GraphCall,
  linksFoundByReference,
  linksFoundByState,
  notBuilt,
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
  /** A call's position, when a test does not say: its line's, the same for the call and its link. */
  const POS_PER_LINE = 100;
  const call = (line: number, name: string, dst: string, start: number, end: number, cause: string, pos = line * POS_PER_LINE): ReferenceCall => ({
    file: "use.ts",
    line,
    pos,
    names: [name],
    decls: [{ file: dst, spans: [{ start, end }] }],
    cause,
  });
  const link = (line: number, name: string, dst: string, start: number, end: number, pos = line * POS_PER_LINE): GraphCall => ({ file: "use.ts", line, pos, name, dst, start, end });

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

  test("a call recorded by the name an import declares it as is found", () => {
    const renamed: ReferenceCall = { file: "use.ts", line: 3, pos: 3 * POS_PER_LINE, names: ["sum", "total"], decls: [{ file: "cart.ts", spans: [{ start: 1, end: 4 }] }], cause: "x" };
    expect(linksFoundByReference([renamed], [link(3, "total", "cart.ts", 2, 2)]).n).toBe(1);
  });

  test("a call is identified by its position: a link on its line at another position is no find", () => {
    const r = linksFoundByReference([call(3, "total", "cart.ts", 1, 4, "x", 304)], [link(3, "total", "cart.ts", 1, 4, 320)]);
    expect(r.n).toBe(0);
  });

  test("two calls of one name on one line are each found only by the link at their own position", () => {
    const two = [call(3, "open", "kettle.ts", 1, 4, "x", 309), call(3, "open", "lamp.ts", 1, 4, "x", 323)];
    expect(linksFoundByReference(two, [link(3, "open", "kettle.ts", 1, 4, 309), link(3, "open", "lamp.ts", 1, 4, 323)]).n).toBe(2);
    expect(linksFoundByReference(two, [link(3, "open", "lamp.ts", 1, 4, 309), link(3, "open", "kettle.ts", 1, 4, 323)]).n).toBe(0);
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
const NOT_BUILT = "not built (a reason)";
const stored = (a: WayScores): Stored => ({ command: "test", entries: [entry({ repo: "r", language: "typescript", commit: "c", reference: "ref" }, { A: a, B: notBuilt(NOT_BUILT) })] });

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

// A language's reference has a version, stored with the scores. When the reference changes, its
// version is raised, and the run is a new baseline for that language when no score misses more
// than before: a score's misses are `of - n`, for links right the wrong links. With the same
// version, a lower share is a fall, as above.
describe("a new reference version is a new baseline when no miss rose", () => {
  const versioned = (a: WayScores, typescript: number): Stored => ({ ...stored(a), referenceVersions: { typescript } });
  const missing = (n: number, of: number, right = { n: of, of }): WayScores => ({ ...scored(n, of), linksRight: right });

  test("the version changed and no score misses more: the run is accepted, though a share is lower", () => {
    // 6 of 7 misses 1; 5 of 6 misses 1, a lower share over a smaller reference.
    expect(falls(versioned(scored(6, 7), 1), versioned(scored(5, 6), 2))).toEqual([]);
    expect(falls(versioned(scored(6, 7), 1), versioned(scored(9, 9), 2))).toEqual([]);
  });

  test("the version changed and a score misses more: the run is refused, naming the score", () => {
    expect(falls(versioned(scored(6, 7), 1), versioned(scored(5, 7), 2))).toEqual([expect.stringContaining("r typescript way A linksFoundByReference")]);
    // Links right misses its wrong links: none before, one now.
    expect(falls(versioned(missing(6, 7), 1), versioned(missing(6, 7, { n: 3, of: 4 }), 2))).toEqual([expect.stringContaining("way A linksRight")]);
  });

  test("the same version: a lower share is a fall, as strict as without versions", () => {
    expect(falls(versioned(scored(6, 7), 2), versioned(scored(5, 6), 2))).toEqual([expect.stringContaining("way A linksFoundByReference")]);
    expect(falls(versioned(scored(6, 7), 2), versioned(scored(12, 14), 2))).toEqual([]);
  });

  test("stored scores with no version are at the first version", () => {
    expect(falls(stored(scored(6, 7)), versioned(scored(5, 6), 1))).toEqual([expect.stringContaining("way A linksFoundByReference")]);
    expect(falls(stored(scored(6, 7)), versioned(scored(5, 6), 2))).toEqual([]);
  });

  test("a version raised for one language leaves the other's scores as strict", () => {
    const both = (ts: number, py: WayScores, version: number): Stored => ({
      command: "test",
      referenceVersions: { typescript: version, python: 1 },
      entries: [entry({ repo: "t", language: "typescript", commit: "c", reference: "ref" }, { A: scored(ts, 7), B: notBuilt(NOT_BUILT) }), entry({ repo: "p", language: "python", commit: "c", reference: "ref" }, { A: py, B: notBuilt(NOT_BUILT) })],
    });
    expect(falls(both(6, scored(6, 7), 1), both(6, scored(5, 6), 2))).toEqual([expect.stringContaining("p python way A linksFoundByReference")]);
  });
});

describe("way B is not built, not zero", () => {
  test("every score of way B says it is not built, and none is a number", () => {
    const e = entry({ repo: "r", language: "python", commit: "c", reference: "ref" }, { A: scored(1, 2), B: notBuilt(NOT_BUILT) });
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
    expect(format({ n: 6, of: 7, note: "a note" })).toBe("85.7% (6/7), a note");
  });
});

// "A fix that removes links that were wrong can lower links found. Then the new score is recorded
// with the issue that removed them, and links right must still be 100%." `--write --accept-fall
// <issue>` records it; scores.json is never edited by hand.
describe("a fall in links found is accepted with the issue that caused it", () => {
  const rightAt = (n: number, of: number, right: { n: number; of: number }): WayScores => ({ ...scored(n, of), linksRight: right });

  test("the fallen score is stored with the issue and the score it fell from", () => {
    const accepted = acceptFalls(stored(scored(6, 7)), stored(scored(5, 7)), 42);
    if (!("stored" in accepted)) throw new Error(accepted.refused.join("\n"));
    const a = accepted.stored.entries[0]?.ways.A;
    expect(a?.linksFoundByReference).toEqual({ n: 5, of: 7, fallAccepted: { issue: 42, was: { n: 6, of: 7 } } });
    expect(accepted.accepted).toEqual([expect.stringContaining("r typescript way A linksFoundByReference")]);
  });

  test("the check then passes on the recorded score", () => {
    const accepted = acceptFalls(stored(scored(6, 7)), stored(scored(5, 7)), 42);
    if (!("stored" in accepted)) throw new Error(accepted.refused.join("\n"));
    expect(falls(accepted.stored, stored(scored(5, 7)))).toEqual([]);
    expect(falls(accepted.stored, stored(scored(4, 7)))).toEqual([expect.stringContaining("linksFoundByReference")]);
  });

  test("refused unless links right is 100% for that way and repo", () => {
    const wrong = acceptFalls(stored(rightAt(6, 7, { n: 6, of: 7 })), stored(rightAt(5, 7, { n: 6, of: 7 })), 42);
    expect(wrong).toEqual({ refused: [expect.stringContaining("r typescript way A linksRight")] });
    const unjudged = rightAt(5, 7, { n: 0, of: 0 });
    expect(acceptFalls(stored(scored(6, 7)), stored(unjudged), 42)).toEqual({ refused: expect.arrayContaining([expect.stringContaining("linksRight is none, not 100%")]) });
  });

  test("only links found can be accepted: a fall in another score is refused", () => {
    for (const name of ["functionsFound", "linksRight", "callsAccountedFor"] as const) {
      const low = scored(7, 7);
      low[name] = { n: 6, of: 7 };
      const r = acceptFalls(stored(scored(7, 7)), stored(low), 42);
      expect(r).toEqual({ refused: expect.arrayContaining([expect.stringContaining(`way A ${name}`)]) });
    }
    expect(acceptFalls(stored(scored(6, 7)), { command: "test", entries: [] }, 42)).toEqual({ refused: [expect.stringContaining("no longer measured")] });
  });

  test("a score that did not fall is stored as measured", () => {
    const rose = scored(7, 7);
    const accepted = acceptFalls(stored(scored(6, 7)), stored(rose), 42);
    if (!("stored" in accepted)) throw new Error(accepted.refused.join("\n"));
    expect(accepted.stored.entries[0]?.ways.A.linksFoundByReference).toEqual({ n: 7, of: 7 });
    expect(accepted.accepted).toEqual([]);
  });

  test("a later write keeps the record while the score is unchanged, and drops it once the score moves", () => {
    const accepted = acceptFalls(stored(scored(6, 7)), stored(scored(5, 7)), 42);
    if (!("stored" in accepted)) throw new Error(accepted.refused.join("\n"));
    const same = carryAccepted(accepted.stored, stored(scored(5, 7)));
    expect(same.entries[0]?.ways.A.linksFoundByReference).toEqual({ n: 5, of: 7, fallAccepted: { issue: 42, was: { n: 6, of: 7 } } });
    const moved = carryAccepted(accepted.stored, stored(scored(6, 7)));
    expect(moved.entries[0]?.ways.A.linksFoundByReference).toEqual({ n: 6, of: 7 });
  });

  test("--accept-fall takes the issue number and is given with --write", () => {
    expect(acceptFallIssue(["--write"])).toBeNull();
    expect(acceptFallIssue(["--write", "--accept-fall", "364"])).toBe(364);
    expect(acceptFallIssue(["--write", "--accept-fall"])).toEqual({ error: expect.stringContaining("issue number") });
    expect(acceptFallIssue(["--write", "--accept-fall", "#364"])).toEqual({ error: expect.stringContaining("issue number") });
    expect(acceptFallIssue(["--check", "--accept-fall", "364"])).toEqual({ error: expect.stringContaining("--write") });
  });

  test("the printed score names the issue", () => {
    expect(format({ n: 5, of: 7, fallAccepted: { issue: 42, was: { n: 6, of: 7 } } })).toContain("#42");
  });
});
