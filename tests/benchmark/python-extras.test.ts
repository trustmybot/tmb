// The calls a second Python tool links where pyright does not (trustmybot/tmb#427), on a small
// fixture: a call is an extra when the other tool names a node of the graph by the reference's rules
// and pyright gives no answer or answers outside the repo; a call pyright places in the repo is none.
// Every expectation is written from that rule, by hand.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { installPinnedTools } from "../lib/pinned-tools.ts";
import { type ExtraCall, extraCalls, seededSample, withExtras } from "./python-extras.ts";
import { checkerAnswers, LINK_CAUSES, pythonReference } from "./python.ts";
import { judgeCannotRun, judgeDeclarations } from "./python_judge.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ASH = [
  "class Kettle:", // 1
  "    def boil(self):", // 2
  "        return 1", // 3
  "", // 4
  "def light():", // 5
  "    raise ImportError()", // 6: `ImportError` is outside the repo for both
  "    Kettle()", // 7: unreachable, so pyright gives no answer; Jedi reads the text and names the class
  "", // 8
  "def warm():", // 9
  "    k = Kettle()", // 10: both name the class: no extra
  "    k.boil()", // 11: both name the method: no extra
  "    len([])", // 12: both place it outside: no extra
  "",
].join("\n");
const FILES = new Map([["ash.py", ASH]]);

const hasPython = spawnSync("python3", ["-I", "-c", "pass"]).status === 0;
const judgeMissing = hasPython ? judgeCannotRun() : "no python3 on PATH";

describe("the calls Jedi links where pyright does not", () => {
  if (judgeMissing !== null) {
    console.warn(`skipped: Python's extra links: ${judgeMissing}`);
    test.skip(`Python's extra links (skipped: ${judgeMissing})`, () => {});
    return;
  }

  beforeAll(installPinnedTools);
  let repo: string;
  let commit: string;
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-benchmark-pyextras-")));
    for (const [file, text] of FILES) writeFileSync(path.join(repo, file), text);
    for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    }
    commit = resolveCommit(repo, "HEAD")!;
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("an extra is a call the other tool links to a node where pyright gives no answer; a call pyright places is none", async () => {
    const ref = pythonReference(FILES);
    const pyright = await checkerAnswers(repo, commit, FILES, ref, []);
    const jedi = await checkerAnswers(repo, commit, FILES, ref, [], { tool: judgeDeclarations });
    const extras = extraCalls(ref, pyright, jedi, new Set(FILES.keys()));
    expect(extras.map((e) => ({ at: `${e.file}:${e.line} ${e.names[0]}`, cause: e.cause, pyright: e.pyright, to: e.decls }))).toEqual([
      { at: "ash.py:7 Kettle", cause: LINK_CAUSES.construct, pyright: "no answer", to: [{ file: "ash.py", spans: [{ start: 1, end: 1 }] }] },
    ]);
    // pyright against itself has no extra.
    expect(extraCalls(ref, pyright, pyright, new Set(FILES.keys()))).toEqual([]);
  });
});

describe("links found from the call states with the extras", () => {
  const extra = (pyright: ExtraCall["pyright"]): ExtraCall => ({ file: "a.py", line: 1, pos: 0, names: ["f"], decls: [], cause: LINK_CAUSES.direct, pyright });

  test("a call pyright gave no answer for was not known and is now linked; one it placed outside was outside and is now linked", () => {
    expect(withExtras({ n: 10, of: 20 }, [])).toEqual({ n: 10, of: 20 });
    expect(withExtras({ n: 10, of: 20 }, [extra("no answer")])).toEqual({ n: 11, of: 20 });
    expect(withExtras({ n: 10, of: 20 }, [extra("outside the repo")])).toEqual({ n: 11, of: 21 });
  });

  test("a sample is the same for the same seed, and never larger than the calls", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const a = seededSample(items, 20, 427);
    expect(a).toEqual(seededSample(items, 20, 427));
    expect(new Set(a).size).toBe(20);
    expect(seededSample(items.slice(0, 5), 20, 427).length).toBe(5);
  });
});
