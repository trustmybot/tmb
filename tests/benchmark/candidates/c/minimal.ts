// Runs every candidate on a small fixture and gives each call's state and links, for the
// minimal examples (minimal.test.ts here and in ../cpp).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CANDIDATES, env, runCandidate, writeCdb, type Candidate } from "./candidates.ts";
import { keyOf, readRepo, repoFiles, resolve, runReference, type Rules } from "./lib.ts";

/** What a call gives, as a test reads it: `linked <file>:<start>`, `outside` or `not known`. */
export type Outcome = string;

export async function minimal(rules: Rules, root: string, compiler: string, flags: string[]): Promise<Map<Candidate, Map<string, Outcome>>> {
  const work = mkdtempSync(path.join(tmpdir(), `minimal-${rules.language}-`));
  const files = repoFiles(root, rules);
  const cdb = writeCdb(root, files.filter((f) => !f.endsWith(".h")), compiler, flags, path.join(work, "cdb", "compile_commands.json"));
  const graph = await readRepo(root, rules, files);
  const ref = runReference({ python: process.env.TMB_PYTHON ?? "python3", libclang: env("TMB_LIBCLANG"), cindexDir: env("TMB_CINDEX"), root, cdb, language: rules.language, out: path.join(work, "reference.json") });
  const out = new Map<Candidate, Map<string, Outcome>>();
  for (const cand of CANDIDATES) {
    const dir = path.join(work, cand);
    mkdirSync(dir, { recursive: true });
    const run = await runCandidate(cand, { root, cdb, out: dir, graph, ref, language: rules.language, indexTimeoutMs: 60_000 });
    if ("notRun" in run) throw new Error(`${cand}: ${run.notRun}`);
    const got = new Map<string, Outcome>();
    for (const c of graph.calls) {
      const r = resolve(graph, c, run.answers.get(keyOf(c)));
      const what = r.state === "linked" ? r.links.map((n) => `linked ${n.file}:${n.start}`).sort().join(" + ") : r.state === "outside" ? "outside" : "not known";
      got.set(`${c.file}:${c.line} ${c.name}`, what);
    }
    out.set(cand, got);
  }
  return out;
}
