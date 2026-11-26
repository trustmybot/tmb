// The benchmark's links right on a small fixture (trustmybot/tmb#343): every link is judged, in the
// same file or across files, and a call is matched to the compiler's by its position, the place
// where the name it calls is written (CODE_GRAPH.md, Benchmark and "Two ways to make links").
// Every expectation is written from the rule, by hand.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BASE_LAYER } from "../../src/engine/graph/db.ts";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { compilerProgram } from "../../src/engine/graph/languages/typescript/links.ts";
import { BUILT_IN } from "../../src/engine/graph/ways.ts";
import { withGraph } from "./graph.ts";
import { linksRight } from "./typescript.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

// One file, so every link is in the same file. Line 4 holds two calls of `rate`: the nested
// function's own, which reaches the `rate` declared on line 4, and `price`'s, which reaches line 1.
const SAME = [
  "export function rate() { return 1; }", // 1
  "export function price() {", // 2
  "  function inner() {", // 3
  "    function rate() { return 2; } return rate(); } return rate() + inner();", // 4
  "}", // 5
  "",
].join("\n");

let repo: string;
let commit: string;
beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-benchmark-right-")));
  writeFileSync(path.join(repo, "same.ts"), SAME);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  commit = resolveCommit(repo, "HEAD")!;
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

type Row = { id: number; pos: number; dst: number; start: number };

/** The links of `rate` on line 4, in the order the calls are written, with the line their target starts on. */
function rateLinks(db: Database): Row[] {
  return db
    .query(
      `SELECT e.rowid AS id, e.pos AS pos, e.dst_id AS dst, d.start_line AS start
         FROM edges e JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.kind = 'calls' AND e.dst_name = 'rate' AND e.line = 4 ORDER BY e.pos`,
    )
    .all(BASE_LAYER) as Row[];
}

describe("links right judges every link, in the same file too, by position", () => {
  test("each same-file link that names the compiler's declaration for its call is right", async () => {
    const program = compilerProgram(repo, commit);
    const got = await withGraph(repo, commit, { links: BUILT_IN }, (db) => linksRight(db, program.lookup));
    // `rate()` in inner, `rate()` in price, and `inner()`: three calls, each to a function of the file.
    expect(got.wrong).toEqual([]);
    expect({ links: got.links, right: got.right }).toEqual({ links: 3, right: 3 });
  });

  test("a same-file link to another declaration than the compiler's, for the call at its position, is wrong", async () => {
    const program = compilerProgram(repo, commit);
    const got = await withGraph(repo, commit, { links: BUILT_IN }, (db) => {
      const [nested, outer] = rateLinks(db);
      expect([nested?.start, outer?.start]).toEqual([4, 1]);
      // Swap the targets of the two `rate` calls on line 4. Both names are on the line, so only
      // the position tells which call each link is for.
      const swap = db.prepare("UPDATE edges SET dst_id = ? WHERE rowid = ?");
      swap.run(outer!.dst, nested!.id);
      swap.run(nested!.dst, outer!.id);
      return linksRight(db, program.lookup);
    });
    expect({ links: got.links, right: got.right }).toEqual({ links: 3, right: 1 });
    expect(got.wrong).toEqual([expect.stringMatching(/^same\.ts:4 calls `rate` -> same\.ts:1-1;/), expect.stringMatching(/^same\.ts:4 calls `rate` -> same\.ts:4-4;/)]);
  });
});
