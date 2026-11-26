// The benchmark's set (trustmybot/tmb#244): "Every repo is at a fixed commit, tmb's own included"
// (CODE_GRAPH.md, Benchmark). A repo measured at a moving ref would move its scores with no change
// to the graph.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { BENCH_REPOS, locate, TMB_PIN } from "./repos.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const FULL_SHA = /^[0-9a-f]{40}$/;

describe("every repo is at a fixed commit", () => {
  test("each repo of the set names a full commit, never a branch or HEAD", () => {
    for (const r of BENCH_REPOS) expect(r.pinned.commit).toMatch(FULL_SHA);
  });

  test("tmb is measured at its pin, read from its own history, not at HEAD", () => {
    const tmb = BENCH_REPOS.find((r) => r.repo === "tmb");
    expect(tmb?.pinned).toBe(TMB_PIN);
    const where = tmb === undefined ? { error: "no tmb" } : locate(tmb);
    // A shallow clone may lack the pinned commit: that is an error to report, never a fall back to HEAD.
    if ("error" in where) expect(where.error).toContain(TMB_PIN.commit);
    else expect(where.ref).toBe(TMB_PIN.commit);
  });
});
