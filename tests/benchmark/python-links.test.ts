// Python's links judged against a type checker (trustmybot/tmb#399), on a small fixture: the
// reference's links are pyright's declarations for each call, where pyright gives one, that are a
// node by "Kinds of symbol"; a call it gives no answer for is counted and not judged; and a link is
// right when it names a declaration pyright gives for that name (CODE_GRAPH.md, Benchmark). Every
// expectation is written from those rules, by hand.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { checkerAnswers, judgeLink, LINK_CAUSES, measurePython, pythonReference, referenceLinks } from "./python.ts";
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

const FILES = new Map([
  ["brew.py", BREW],
  ["cup.py", CUP],
]);

const hasPython = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;

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
    const links = referenceLinks(ref, answers, new Set(FILES.keys()));
    const got = links.calls.map((c) => `${c.file}:${c.line} ${c.names.join("/")} -> ${c.decls.map((d) => `${d.file}:${d.spans.map((s) => s.start).join(",")}`).join(" ")}`).sort();
    expect(got).toEqual(
      [
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
      ].sort(),
    );
    // `missing_name()` has no answer; `len([])` is outside; `fn()` is a parameter.
    expect(links.counts).toEqual({ sites: 13, misplaced: 0, noAnswer: 1, outside: 1, noNode: 1 });
  });

  test("each reference link names the kind of code its call is", async () => {
    const { ref, answers } = await answered();
    const causes = new Map(referenceLinks(ref, answers, new Set(FILES.keys())).calls.map((c) => [`${c.file}:${c.line} ${c.names[0]}`, c.cause]));
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
    for (const way of ["A", "B"] as const) {
      const { scores, detail } = await measurePython(repo, commit, way);
      expect(isRatio(scores.linksRight)).toBe(true);
      expect(isRatio(scores.linksFoundByReference)).toBe(true);
      if (isRatio(scores.linksRight)) expect(scores.linksRight.n).toBe(scores.linksRight.of);
      if (isRatio(scores.linksFoundByReference)) expect(scores.linksFoundByReference.of).toBe(10);
      expect(detail.some((d) => d.includes("1 no answer"))).toBe(true);
    }
  });
});
