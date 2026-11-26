// Each Java candidate on the page's example and on the language's edge cases (trustmybot/tmb#346).
// The expectations come from the JLS (expected.ts). Runs only where the tools are named by the
// environment run.ts reads; tmb itself installs none of them.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED } from "./expected.ts";
import { javaParser, readFile, type JNode } from "./nodes.ts";
import { CANDIDATES, compileTools, judge, runCandidate } from "./run.ts";

setDefaultTimeout(30_000);

/**
 * Where a candidate's answer differs from the language's rule, as found by this test; each is
 * reported in the research report. The expectation stays the rule's; the test holds that the
 * candidate still differs there, so a fixed tool shows up as a failure to update this list.
 */
const DIFFERS: Record<string, Record<string, string[]>> = {
  // JavaParser places `new Point(...)` at the record, not at its compact canonical constructor.
  javaparser: { edges: ["pkg/Shapes.java:61:Point"] },
  // scip-java writes no reference at an anonymous class's creation, so it gives no answer there.
  "scip-java": { edges: ["pkg/Shapes.java:52:Base"] },
};

const READY = ["TMB_JAVA_HOME", "TMB_JAVA_GRAMMAR", "TMB_JAVA_LIB", "TMB_JAVA_SCIP"].every((v) => process.env[v]);

describe.skipIf(!READY)("Java way B candidates", () => {
  for (const fixture of Object.keys(EXPECTED)) {
    for (const c of CANDIDATES) {
      test(`${c} on ${fixture}`, async () => {
        const work = mkdtempSync(join(tmpdir(), "tmb-java-"));
        const repo = join(work, "repo");
        cpSync(join(import.meta.dir, fixture), repo, { recursive: true });
        const files = [...new Bun.Glob("**/*.java").scanSync(repo)].sort();
        const list = join(work, "files.txt");
        await Bun.write(list, `${files.join("\n")}\n`);
        compileTools(work, process.env.TMB_JAVA_HOME as string, process.env.TMB_JAVA_LIB as string);
        const run = await runCandidate(c, repo, list, "", work, "t");
        const p = await javaParser(process.env.TMB_JAVA_GRAMMAR as string);
        const byFile = new Map<string, JNode[]>();
        const got: Record<string, string> = {};
        const calls = [];
        for (const f of files) {
          const r = readFile(p, f, await Bun.file(join(repo, f)).text());
          byFile.set(f, r.nodes);
          calls.push(...r.calls);
        }
        for (const call of calls) {
          const key = `${call.file}:${call.line}:${call.name}`;
          if (!(key in (EXPECTED[fixture] as Record<string, string>))) continue;
          const j = judge(run.answers.get(`${call.file}@${call.pos}`), byFile);
          got[key] = j.state === "linked" ? j.nodes.map((n) => `${n.name}@${n.start}`).join(",") : j.state === "outside" ? "outside" : "not known";
        }
        const want = { ...(EXPECTED[fixture] as Record<string, string>) };
        for (const key of DIFFERS[c]?.[fixture] ?? []) {
          expect(got[key]).not.toBe(want[key] as string);
          delete want[key];
          delete got[key];
        }
        expect(got).toEqual(want);
      }, 120_000);
    }
  }
});
