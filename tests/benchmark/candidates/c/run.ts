// Runs the C or C++ A/B on one repo: the compiler's reference, then each candidate, then the four
// scores and a table of every call, for the hand checks.
//
//   bun tests/benchmark/candidates/c/run.ts --lang c|cpp --root <repo> --ref-cdb <compile_commands.json>
//       [--cdb <compile_commands.json>|none] --out <folder> [--candidates clang,clangd-apple,clangd,scip-clang]
//
// The tools come from the environment, never from the repo: TMB_LIBCLANG (libclang's library),
// TMB_CINDEX (the folder holding clang's Python bindings), TMB_CLANGD_APPLE, TMB_CLANGD, TMB_SCIP_CLANG,
// and the grammars TMB_GRAMMAR_C and TMB_GRAMMAR_CPP.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CPP_RULES } from "../cpp/rules_cpp.ts";
import { CANDIDATES, env, runCandidate, type Candidate } from "./candidates.ts";
import { keyOf, pct, readRepo, referenceResolved, runReference, score, scoreFunctions, type Answers, type GraphNode, type Reference } from "./lib.ts";
import { C_RULES } from "./rules_c.ts";

const { values: a } = parseArgs({
  options: {
    lang: { type: "string" },
    root: { type: "string" },
    "ref-cdb": { type: "string" },
    cdb: { type: "string" },
    out: { type: "string" },
    candidates: { type: "string", default: "clang,clangd-apple,clangd,scip-clang" },
    "index-timeout-s": { type: "string", default: "1800" },
  },
});
const rules = a.lang === "cpp" ? CPP_RULES : C_RULES;
const root = path.resolve(a.root!);
const out = path.resolve(a.out!);
mkdirSync(out, { recursive: true });
const cdb = a.cdb === undefined || a.cdb === "none" ? null : path.resolve(a.cdb);

const t0 = performance.now();
const graph = await readRepo(root, rules);
console.log(`graph: ${graph.nodes.length} nodes, ${graph.calls.length} calls, ${graph.parseErrors.length} files with a parse error (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

const tr = performance.now();
const ref = runReference({ python: process.env.TMB_PYTHON ?? "python3", libclang: env("TMB_LIBCLANG"), cindexDir: env("TMB_CINDEX"), root, cdb: a["ref-cdb"] === "none" ? null : path.resolve(a["ref-cdb"]!), language: rules.language, out: path.join(out, "reference.json") });
console.log(`reference: ${((performance.now() - tr) / 1000).toFixed(1)} s`);
const refResolved = referenceResolved(graph, ref);
const fns = scoreFunctions(graph, ref);
writeFileSync(path.join(out, "functions.json"), JSON.stringify({ ratio: fns.ratio, missing: fns.missing, extra: fns.extra }, null, 1));
const refStates = { linked: 0, outside: 0, notKnown: 0 };
for (const r of refResolved.values()) refStates[r.state]++;
console.log(`reference calls ${ref.calls.length}: ${JSON.stringify(refStates)}; functions found ${pct(fns.ratio)}`);

const refCdb = a["ref-cdb"] === "none" ? null : path.resolve(a["ref-cdb"]!);
let ownRef: Reference | null = null;
const clangRef = (): Reference => {
  if (cdb === refCdb) return ref;
  ownRef ??= runReference({ python: process.env.TMB_PYTHON ?? "python3", libclang: env("TMB_LIBCLANG"), cindexDir: env("TMB_CINDEX"), root, cdb, language: rules.language, out: path.join(out, "clang-units.json") });
  return ownRef;
};
const results: Record<string, unknown> = {};
const all = new Map<string, Answers>();
for (const cand of a.candidates!.split(",") as Candidate[]) {
  if (!CANDIDATES.includes(cand)) throw new Error(`unknown candidate ${cand}`);
  const tc = performance.now();
  // clang alone answers from the units as the candidates' database gives them, which may differ from the reference's.
  const run = await runCandidate(cand, { root, cdb, out, graph, ref: cand === "clang" ? clangRef() : ref, language: rules.language, indexTimeoutMs: Number(a["index-timeout-s"]) * 1000 });
  if ("notRun" in run) {
    results[cand] = run;
    console.log(`${cand}: not run: ${run.notRun}`);
    continue;
  }
  all.set(cand, run.answers);
  const s = score(graph, ref, refResolved, run.answers);
  const { perCall: _, ...shown } = s;
  results[cand] = { ...shown, totalMs: Math.round(performance.now() - tc), timing: run.timing };
  console.log(
    `${cand}: answered ${s.answered}; states ${JSON.stringify(s.states)}; links right ${s.linksRight.right} right, ${s.linksRight.wrong} wrong, ${s.linksRight.notJudged} not judged; links found by state ${pct(s.linksFoundByState)}; by reference ${pct(s.linksFoundByReference)}; calls accounted ${pct(s.callsAccountedFor)}; ${JSON.stringify(run.timing)}`,
  );
}
writeFileSync(path.join(out, "results.json"), JSON.stringify({ root, cdb, refStates, functionsFound: fns.ratio, graph: { nodes: graph.nodes.length, calls: graph.calls.length, parseErrors: graph.parseErrors }, results }, null, 1));

// One row per call of the graph: the reference's state and links, and each candidate's.
const label = (n: GraphNode) => `${n.file}:${n.start}-${n.end}`;
const rows: string[] = [];
const perCand = new Map([...all].map(([c, ans]) => [c, score(graph, ref, refResolved, ans).perCall]));
for (const c of graph.calls) {
  const key = keyOf(c);
  const want = refResolved.get(key);
  const row: Record<string, unknown> = { key, name: c.name, owner: c.owner ? label(c.owner) : null, ref: want ? { state: want.state, links: want.links.map(label), decls: want.call.decls.map((d) => d.usr), dynamic: want.call.dynamic } : null };
  for (const [cand, per] of perCand) {
    const r = per.get(key)!;
    row[cand] = { state: r.state, links: r.links.map(label), answer: all.get(cand)!.get(key) ?? null };
  }
  rows.push(JSON.stringify(row));
}
writeFileSync(path.join(out, "calls.jsonl"), rows.join("\n") + "\n");
console.log(`wrote ${out}`);
