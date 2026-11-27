// Python's links judged against a type checker (trustmybot/tmb#399), on a small fixture: the
// reference's links are pyright's declarations for each call, where pyright gives one, that are a
// node by "Kinds of symbol"; a call it gives no answer for is counted and not judged; and a link is
// right when it names a declaration pyright gives for that name (CODE_GRAPH.md, Benchmark). Way B's
// links are pyright's, so a second judge that is not pyright, Jedi (trustmybot/tmb#427), judges
// them by the same rule. Every expectation is written from those rules, by hand.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { installPinnedTools, JEDI } from "../lib/pinned-tools.ts";
import { checkerAnswers, JUDGED_BY, judgeLink, LINK_CAUSES, measurePython, pythonReference, referenceLinks } from "./python.ts";
import { judgeCannotRun, judgeDeclarations } from "./python_judge.ts";
import { isRatio } from "./score.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const BREW = [
  "class Kettle:", // 1
  "    def boil(self):", // 2
  "        return self.pour()", // 3: a method on the object itself
  "    def pour(self):", // 4
  "        return steep(1)", // 5
  "", // 6
  "def steep(n):", // 7
  "    return n", // 8
  "", // 9
  "brewer = steep", // 10: file-level data that holds a function
  "", // 11
  "def serve(fn, k: Kettle):", // 12
  "    pot = Kettle()", // 13: a construction links to the class
  "    pot.boil()", // 14
  "    def stir():", // 15: a function inside a function is a function, a node by Kinds of symbol
  "        return 0", // 16
  "    stir()", // 17
  "    len([])", // 18: a built-in, outside the repo
  "    missing_name()", // 19: declared nowhere, so no answer
  "    fn()", // 20: a parameter, which is no node
  "    brewer(2)", // 21: links to the variable
  "    k.pour()", // 22
  "    (lambda: 1)()", // 23: a callee that is no name, so no place to ask
  "",
].join("\n");

const CUP = [
  "from brew import steep as infuse, Kettle", // 1
  "", // 2
  "def sip():", // 3
  "    infuse(3)", // 4: a name imported under a new name
  "    Kettle().boil()", // 5
  "",
].join("\n");

// Calls the judge must answer on proof alone: what the code declares or assigns, never a guess.
const MILL = [
  "class Wheel:", // 1
  "    def turn(self):", // 2
  "        return 1", // 3
  "", // 4
  "class Waterwheel(Wheel):", // 5
  "    def __init__(self, depth):", // 6
  "        self.depth = depth", // 7
  "", // 8
  "def grind(w):", // 9
  "    return w.turn()", // 10: a parameter with no type: no answer, though its one caller passes a Waterwheel
  "", // 11
  "def run():", // 12
  "    ww = Waterwheel(3)", // 13: a construction links to the class, not to its __init__
  "    ww.turn()", // 14: an inherited method links to the base's
  "    grind(ww)", // 15
  "    hopper = []", // 16
  "    hopper.append(Wheel())", // 17: `append` is outside the repo
  "    hopper[0].turn()", // 18: an item of a list whose items no annotation gives: no answer
  "",
].join("\n");

// A class method of an enum: Jedi names, for `Tint.parse`, a place in the built-ins whose text there is
// another name. That place declares no `parse`, so it is no answer.
const DYE = [
  "from enum import Enum", // 1
  "", // 2
  "class Tint(Enum):", // 3
  '    RED = "red"', // 4
  "", // 5
  "    @classmethod", // 6
  '    def parse(cls, word: str) -> "Tint":', // 7
  "        return cls(word)", // 8
  "", // 9
  "def paint():", // 10
  '    return Tint.parse("red")', // 11
  "",
].join("\n");

const FILES = new Map([
  ["brew.py", BREW],
  ["cup.py", CUP],
  ["mill.py", MILL],
  ["dye.py", DYE],
]);
/** The files whose reference links every tool that resolves on proof gives alike. */
const ALIKE = new Set(["brew.py", "cup.py", "mill.py"]);

const hasPython = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;
/** Why the second judge cannot run here, or null: Jedi needs a newer Python than the reference does. */
const judgeMissing = hasPython ? judgeCannotRun() : "no python3 on PATH";

/** The reference links of the fixture, by the page's rules: the same for any tool that resolves on proof. */
const FIXTURE_LINKS = [
  "brew.py:3 pour -> brew.py:4",
  "brew.py:5 steep -> brew.py:7",
  "brew.py:13 Kettle -> brew.py:1",
  "brew.py:14 boil -> brew.py:2",
  "brew.py:17 stir -> brew.py:15",
  "brew.py:21 brewer -> brew.py:10",
  "brew.py:22 pour -> brew.py:4",
  "cup.py:4 infuse/steep -> brew.py:7",
  "cup.py:5 Kettle -> brew.py:1",
  "cup.py:5 boil -> brew.py:2",
  "mill.py:13 Waterwheel -> mill.py:5",
  "mill.py:14 turn -> mill.py:2",
  "mill.py:15 grind -> mill.py:9",
  "mill.py:17 Wheel -> mill.py:1",
].sort();
// `missing_name()`, `w.turn()` and `hopper[0].turn()` have no answer; `len([])` and
// `hopper.append()` are outside; `fn()` is a parameter.
const FIXTURE_COUNTS = { sites: 20, misplaced: 0, noAnswer: 3, outside: 2, noNode: 1 };

// The reference and way B load pyright from tmb's tools folder; the setup installs tmb's pinned copy.
beforeAll(installPinnedTools);

let repo: string;
let commit: string;
beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-benchmark-pylinks-")));
  for (const [file, text] of FILES) writeFileSync(path.join(repo, file), text);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  commit = resolveCommit(repo, "HEAD")!;
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Each reference link as `file:line names -> file:line`, sorted. */
const linkLines = (calls: ReturnType<typeof referenceLinks>["calls"]) => calls.map((c) => `${c.file}:${c.line} ${c.names.join("/")} -> ${c.decls.map((d) => `${d.file}:${d.spans.map((s) => s.start).join(",")}`).join(" ")}`).sort();

/** The offset where `name` is written on a line of a file, its `nth` time on that line. */
function offsetOf(text: string, line: number, name: string, nth = 0): number {
  const lines = text.split("\n");
  let at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  let col = -1;
  for (let i = 0; i <= nth; i++) col = lines[line - 1]!.indexOf(name, col + 1);
  return at + col;
}

describe("pyright as Python's reference for links", () => {
  if (!hasPython) {
    console.warn("skipped: Python's link reference: no python3 on PATH");
    test.skip("Python's link reference (skipped: no python3 on PATH)", () => {});
    return;
  }

  const answered = async () => {
    const ref = pythonReference(FILES);
    const answers = await checkerAnswers(repo, commit, FILES, ref, []);
    return { ref, answers };
  };

  test("a call's reference link is each declaration pyright gives that is a node; a call it gives none for is counted, not judged", async () => {
    const { ref, answers } = await answered();
    const links = referenceLinks(ref, answers, ALIKE);
    expect(linkLines(links.calls)).toEqual(FIXTURE_LINKS);
    expect(links.counts).toEqual(FIXTURE_COUNTS);
  });

  test("each reference link names the kind of code its call is", async () => {
    const { ref, answers } = await answered();
    const causes = new Map(referenceLinks(ref, answers, ALIKE).calls.map((c) => [`${c.file}:${c.line} ${c.names[0]}`, c.cause]));
    expect(causes.get("brew.py:3 pour")).toBe(LINK_CAUSES.self);
    expect(causes.get("brew.py:5 steep")).toBe(LINK_CAUSES.direct);
    expect(causes.get("brew.py:13 Kettle")).toBe(LINK_CAUSES.construct);
    expect(causes.get("brew.py:14 boil")).toBe(LINK_CAUSES.attribute);
    expect(causes.get("brew.py:21 brewer")).toBe(LINK_CAUSES.data);
    expect(causes.get("cup.py:5 boil")).toBe(LINK_CAUSES.chain);
  });

  test("a link is right when it names a declaration pyright gives, wrong when it names another or one outside, and not judged when pyright gives none", async () => {
    const ref = pythonReference(FILES);
    const asked = [
      { file: "brew.py", pos: offsetOf(BREW, 14, "boil") },
      { file: "brew.py", pos: offsetOf(BREW, 18, "len") },
      { file: "brew.py", pos: offsetOf(BREW, 19, "missing_name") },
      { file: "cup.py", pos: offsetOf(CUP, 4, "infuse") },
      { file: "brew.py", pos: offsetOf(BREW, 21, "brewer") },
    ];
    const answers = await checkerAnswers(repo, commit, FILES, ref, asked);
    const nodes = new Map([
      [
        "brew.py",
        [
          { name: "Kettle", start: 1, end: 5 },
          { name: "boil", start: 2, end: 3 },
          { name: "pour", start: 4, end: 5 },
          { name: "steep", start: 7, end: 8 },
          { name: "brewer", start: 10, end: 10 },
          { name: "serve", start: 12, end: 23 },
        ],
      ],
    ]);
    const link = (at: (typeof asked)[number], dstName: string, start: number, end: number) => ({ file: at.file, pos: at.pos, dst: "brew.py", dstName, start, end });
    expect(judgeLink(link(asked[0]!, "boil", 2, 3), answers, nodes)).toBe("right");
    expect(judgeLink(link(asked[0]!, "pour", 4, 5), answers, nodes)).toBe("wrong");
    // The type around the method holds its line, and is not the method.
    expect(judgeLink(link(asked[0]!, "Kettle", 1, 5), answers, nodes)).toBe("wrong");
    expect(judgeLink(link(asked[1]!, "steep", 7, 8), answers, nodes)).toBe("wrong");
    expect(judgeLink(link(asked[2]!, "steep", 7, 8), answers, nodes)).toBe("not judged");
    expect(judgeLink(link(asked[3]!, "steep", 7, 8), answers, nodes)).toBe("right");
    // A call through file-level data links to the variable, not to the function it holds.
    expect(judgeLink(link(asked[4]!, "brewer", 10, 10), answers, nodes)).toBe("right");
    expect(judgeLink(link(asked[4]!, "steep", 7, 8), answers, nodes)).toBe("wrong");
  });

  test("both ways make no wrong link on the fixture, and links right and links found are scored", async () => {
    if (judgeMissing !== null) console.warn(`way B not measured: ${judgeMissing}`);
    for (const way of judgeMissing === null ? (["A", "B"] as const) : (["A"] as const)) {
      const { scores, detail } = await measurePython(repo, commit, way);
      expect(isRatio(scores.linksRight)).toBe(true);
      expect(isRatio(scores.linksFoundByReference)).toBe(true);
      if (isRatio(scores.linksRight)) expect(scores.linksRight.n).toBe(scores.linksRight.of);
      // dye.py adds one reference link, `Tint.parse` to the class method.
      if (isRatio(scores.linksFoundByReference)) expect(scores.linksFoundByReference.of).toBe(FIXTURE_LINKS.length + 1);
      expect(detail.some((d) => d.includes(`${FIXTURE_COUNTS.noAnswer} no answer`))).toBe(true);
    }
  });
});

describe("Jedi as the second judge of Python's links", () => {
  if (judgeMissing !== null) {
    console.warn(`skipped: Python's second judge: ${judgeMissing}`);
    test.skip(`Python's second judge (skipped: ${judgeMissing})`, () => {});
    return;
  }

  test("Jedi gives the fixture's reference links by the same rule, and no answer where only a guess would give one", async () => {
    const ref = pythonReference(FILES);
    const answers = await checkerAnswers(repo, commit, FILES, ref, [], { tool: judgeDeclarations });
    const links = referenceLinks(ref, answers, ALIKE);
    expect(linkLines(links.calls)).toEqual(FIXTURE_LINKS);
    expect(links.counts).toEqual(FIXTURE_COUNTS);
  });

  test("a link is right when it names a declaration Jedi gives, wrong when it names another, and not judged when Jedi gives none", async () => {
    const ref = pythonReference(FILES);
    const asked = [
      { file: "mill.py", pos: offsetOf(MILL, 13, "Waterwheel") },
      { file: "mill.py", pos: offsetOf(MILL, 14, "turn") },
      { file: "mill.py", pos: offsetOf(MILL, 10, "turn") },
      { file: "mill.py", pos: offsetOf(MILL, 17, "append") },
    ];
    const answers = await checkerAnswers(repo, commit, FILES, ref, asked, { tool: judgeDeclarations, sites: false });
    const nodes = new Map([
      [
        "mill.py",
        [
          { name: "Wheel", start: 1, end: 3 },
          { name: "turn", start: 2, end: 3 },
          { name: "Waterwheel", start: 5, end: 7 },
          { name: "__init__", start: 6, end: 7 },
          { name: "grind", start: 9, end: 10 },
          { name: "run", start: 12, end: 18 },
        ],
      ],
    ]);
    const link = (at: (typeof asked)[number], dstName: string, start: number, end: number) => ({ file: at.file, pos: at.pos, dst: "mill.py", dstName, start, end });
    // A construction links to the class; its __init__ is another node.
    expect(judgeLink(link(asked[0]!, "Waterwheel", 5, 7), answers, nodes)).toBe("right");
    expect(judgeLink(link(asked[0]!, "__init__", 6, 7), answers, nodes)).toBe("wrong");
    // An inherited method is the base's.
    expect(judgeLink(link(asked[1]!, "turn", 2, 3), answers, nodes)).toBe("right");
    expect(judgeLink(link(asked[1]!, "Waterwheel", 5, 7), answers, nodes)).toBe("wrong");
    // A parameter with no type: Jedi does not take its type from the calls, so it gives no answer.
    expect(judgeLink(link(asked[2]!, "turn", 2, 3), answers, nodes)).toBe("not judged");
    // Jedi places `append` outside the repo, so a link of it to the repo is wrong.
    expect(judgeLink(link(asked[3]!, "grind", 9, 10), answers, nodes)).toBe("wrong");
  });

  test("a place Jedi names whose text is not the name declares nothing, so a call it gives only that for is not judged", async () => {
    const ref = pythonReference(FILES);
    const at = { file: "dye.py", pos: offsetOf(DYE, 11, "parse") };
    const nodes = new Map([
      [
        "dye.py",
        [
          { name: "Tint", start: 3, end: 8 },
          { name: "parse", start: 6, end: 8 },
          { name: "paint", start: 10, end: 11 },
        ],
      ],
    ]);
    const link = { ...at, dst: "dye.py", dstName: "parse", start: 6, end: 8 };
    // pyright, the reference, declares the class method.
    expect(judgeLink(link, await checkerAnswers(repo, commit, FILES, ref, [at], { sites: false }), nodes)).toBe("right");
    expect(judgeLink(link, await checkerAnswers(repo, commit, FILES, ref, [at], { tool: judgeDeclarations, sites: false }), nodes)).toBe("not judged");
  });

  test("way B's links right is judged by Jedi, not by pyright, which made them", async () => {
    const { scores, detail, reference } = await measurePython(repo, commit, "B");
    expect(isRatio(scores.linksRight) && scores.linksRight.note).toBe(JUDGED_BY);
    // Way B links each of the fixture's reference links but `stir()`: a function inside a function
    // is no node of Python's graph yet (CODE_GRAPH.md, Languages: trustmybot/tmb#141). It links
    // `Tint.parse` in dye.py too, which Jedi does not judge. Jedi answers for every other link.
    const wayBLinks = FIXTURE_LINKS.length - 1;
    if (isRatio(scores.linksRight)) expect(scores.linksRight).toMatchObject({ n: wayBLinks, of: wayBLinks });
    expect(detail.some((d) => d.startsWith(`links right, by Jedi ${JEDI.version}: ${wayBLinks + 1} links, ${wayBLinks} right, 0 wrong, 1 not judged`))).toBe(true);
    expect(reference).toContain("Jedi");
  });
});
