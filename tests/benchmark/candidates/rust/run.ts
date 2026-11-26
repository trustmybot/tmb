// The A/B for Rust's way B (trustmybot/tmb#346). Builds one set of nodes and calls from
// tree-sitter-rust for every .rs file git tracks at the repo's commit, takes each candidate's
// answers, links each call by CODE_GRAPH.md's place rule, and scores with tests/benchmark/score.ts.
//
//   bun run.ts <repo> <rustc-out-dir> [<name>=<scip file> ...] [--json out.json]
//
// The judge is rustc itself, through the rustc-calls driver: for each call it gives the
// declaration it resolved and, where the receiver's type picks one, the implementation that runs.
// A link is right when one of those is in the linked node.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { at, readRustAnalyzer, readRustc, type Answer, type Answers, type Decl } from "./answers.ts";
import { parseRust, type RustCall, type RustFile, type RustNode } from "./nodes.ts";
import { callsAccountedFor, format, functionsFound, linksFoundByReference, linksFoundByState, type GraphCall, type ReferenceCall } from "../../score.ts";

type State = "linked" | "outside" | "notKnown";
type Judged = { file: string; call: RustCall; state: State; links: RustNode[]; answer?: Answer };

/** The nodes a declaration fits by place: same file, same name, its line inside the node; the one that starts on that line wins. */
export function fit(decl: Decl, nodes: readonly RustNode[]): RustNode[] {
  if ("outside" in decl) return [];
  const fits = nodes.filter((n) => n.kind !== "unnamed" && n.name === decl.name && n.start <= decl.line && decl.line <= n.end);
  if (fits.length <= 1) return fits;
  const sameLine = fits.filter((n) => n.start === decl.line);
  if (sameLine.length === 1) return sameLine;
  // A node's first line is its first attribute; the tool gives its name's line.
  const nameLine = fits.filter((n) => n.nameLine === decl.line);
  return nameLine.length === 1 ? nameLine : [];
}

/** A call's state from a tool's answer (CODE_GRAPH.md, "Way B also gives the call states"). */
export function stateOf(answer: Answer | undefined, nodesOf: (file: string) => readonly RustNode[]): { state: State; links: RustNode[] } {
  if (!answer || answer.decls.length === 0) return { state: "notKnown", links: [] };
  const links = answer.decls.flatMap((d) => ("outside" in d ? [] : fit(d, nodesOf(d.file))));
  if (links.length > 0) return { state: "linked", links: [...new Set(links)] };
  if (answer.decls.every((d) => "outside" in d)) return { state: "outside", links: [] };
  return { state: "notKnown", links: [] };
}

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const positional = args.filter((_, i) => jsonAt < 0 || (i !== jsonAt && i !== jsonAt + 1));
const [repo, rustcOut, ...scips] = positional as [string, string, ...string[]];

const t0 = performance.now();
const files = execFileSync("git", ["-C", repo, "ls-files", "*.rs"], { encoding: "utf8" }).split("\n").filter((f) => f !== "");
const parsed = new Map<string, RustFile>();
for (const f of files) parsed.set(f, await parseRust(f, readFileSync(join(repo, f), "utf8")));
const parseMs = performance.now() - t0;
const nodesOf = (file: string) => parsed.get(file)?.nodes ?? [];
const fileOfNode = new Map<RustNode, string>();
for (const [file, f] of parsed) for (const n of f.nodes) fileOfNode.set(n, file);

const rustc = readRustc(repo, rustcOut);
const candidates: { name: string; answers: Answers }[] = [{ name: "rustc", answers: rustc.answers }];
const raDefs: Record<string, ReturnType<typeof readRustAnalyzer>["defs"]> = {};
for (const s of scips) {
  const [name, file] = s.split("=") as [string, string];
  const ra = readRustAnalyzer(repo, file);
  raDefs[name] = ra.defs;
  console.log(`${name}: ${ra.documents} documents, ${ra.definedTwice} symbols defined at more than one place`);
  candidates.push({ name, answers: ra.answers });
}

// ---- functions found: the graph's nodes against the compiler's list, by file and lines ----
const FN_KINDS = new Set(["fn", "assoc_fn", "closure", "struct", "enum", "union", "trait"]);
const refFns = new Map<string, string[]>();
for (const [file, defs] of rustc.defs) {
  refFns.set(
    file,
    defs.filter((d) => FN_KINDS.has(d.kind)).map((d) => `${d.ident.line}-${d.whole.end}`),
  );
}
const graphFns = new Map<string, string[]>();
for (const [file, f] of parsed) graphFns.set(file, f.nodes.map((n) => `${n.kind === "unnamed" ? n.start : n.nameLine}-${n.end}`));
const fnScore = functionsFound(refFns, graphFns);
const compiledFiles = new Set(refFns.keys());
const notCompiled = files.filter((f) => !compiledFiles.has(f) && (parsed.get(f)?.nodes.length ?? 0) > 0);
const graphFnsCompiled = new Map([...graphFns].filter(([f]) => compiledFiles.has(f)));
const fnBack = functionsFound(graphFnsCompiled, refFns); // nodes of compiled files the compiler lists

// ---- the reference: every call rustc finds written in the repo ----
const judge = rustc.judge;
const ownerOf = (file: string, line: number, col: number): string => {
  // The innermost node around a position, as the graph's owner rule gives it.
  let best: RustNode | undefined;
  for (const n of nodesOf(file)) if (n.kind !== "type" && n.start <= line && line <= n.end && (!best || n.end - n.start <= best.end - best.start)) best = n;
  return best ? `${file}#${best.id}` : `${file}#file`;
};
const posOf = (line: number, col: number) => line * 100_000 + col;
const inRepoDecls = (a: Answer) => a.decls.filter((d): d is Exclude<Decl, { outside: string }> => !("outside" in d));

const graphCallAt = new Map<string, RustCall>();
for (const [file, f] of parsed) for (const c of f.calls) graphCallAt.set(at(file, c.line, c.col), c);

function causeOf(key: string): string {
  const rec = rustc.calls.get(key)!;
  const g = graphCallAt.get(key);
  const kinds = inRepoDecls(judge.get(key)!).map((d) => d.kind);
  if (!g) return "not parsed as a call (macro input)";
  if (g.inMacro) return "in a macro's input";
  if (kinds.every((k) => k === "ctor_fn")) return rec.decl?.path.includes("::") && rec.decl.kind === "ctor_fn" ? "constructor (tuple struct or variant)" : "constructor";
  return rec.how === "method" ? "method call" : "path call";
}

const reference: ReferenceCall[] = [];
for (const [key, ans] of judge) {
  const rec = rustc.calls.get(key)!;
  const decls = inRepoDecls(ans);
  if (decls.length === 0) continue;
  reference.push({
    file: rec.at.file,
    line: rec.at.line,
    pos: posOf(rec.at.line, rec.at.col),
    names: [rec.name],
    decls: decls.map((d) => ({ file: d.file, spans: [{ start: d.line, end: d.line }] })),
    cause: causeOf(key),
  });
}
const refByOwner = new Map<string, number>();
for (const rec of rustc.calls.values()) {
  const o = ownerOf(rec.at.file, rec.at.line, rec.at.col);
  refByOwner.set(o, (refByOwner.get(o) ?? 0) + 1);
}

// ---- each candidate ----
type Result = Record<string, string | number | Record<string, number>>;
const results: Record<string, Result> = {};
const perCall: Record<string, Record<string, { state: State; links: string[] }>> = {};
for (const withMacro of [false, true]) {
  for (const cand of candidates) {
    const judged: Judged[] = [];
    for (const [file, f] of parsed) {
      for (const call of f.calls) {
        if (call.inMacro && !withMacro) continue;
        const answer = cand.answers.get(at(file, call.line, call.col));
        judged.push({ file, call, answer, ...stateOf(answer, nodesOf) });
      }
    }
    const states = { linked: 0, outside: 0, notKnown: 0 };
    for (const j of judged) states[j.state]++;
    // Links right, judged against rustc.
    let right = 0;
    let wrong = 0;
    let unjudged = 0;
    const wrongs: string[] = [];
    for (const j of judged) {
      if (j.state !== "linked") continue;
      for (const n of j.links) {
        const ref = judge.get(at(j.file, j.call.line, j.call.col));
        if (!ref || ref.decls.length === 0) {
          unjudged++;
          continue;
        }
        const ok = inRepoDecls(ref).some((d) => d.file === fileOfNode.get(n) && n.start <= d.line && d.line <= n.end);
        if (ok) right++;
        else {
          wrong++;
          wrongs.push(`${j.file}:${j.call.line}:${j.call.col} ${j.call.name} -> ${n.qualified}`);
        }
      }
    }
    const graphCalls: GraphCall[] = [];
    for (const j of judged) {
      for (const n of j.links) {
        const dst = fileOfNode.get(n)!;
        graphCalls.push({ file: j.file, line: j.call.line, pos: posOf(j.call.line, j.call.col), name: j.call.name, dst, start: n.start, end: n.end });
      }
    }
    const byRef = linksFoundByReference(reference, graphCalls);
    const graphByOwner = new Map<string, number>();
    let outsideWrong = 0;
    for (const j of judged) {
      const key = at(j.file, j.call.line, j.call.col);
      if (!rustc.calls.has(key)) continue; // a call the compiler does not list is no call it accounts for
      const o = ownerOf(j.file, j.call.line, j.call.col);
      graphByOwner.set(o, (graphByOwner.get(o) ?? 0) + 1);
      if (j.state === "outside" && inRepoDecls(judge.get(key)!).length > 0) outsideWrong++;
    }
    const surplus = judged.filter((j) => !rustc.calls.has(at(j.file, j.call.line, j.call.col)) && compiledFiles.has(j.file)).length;
    const name = `${cand.name}${withMacro ? " +macro input" : ""}`;
    results[name] = {
      functionsFound: format(fnScore),
      linksRight: `${right} right, ${wrong} wrong, ${unjudged} not judged`,
      linksFoundByState: format(linksFoundByState(states)),
      linksFoundByReference: format(byRef),
      callsAccountedFor: format(callsAccountedFor(refByOwner, graphByOwner, outsideWrong)),
      states: `${states.linked} / ${states.outside} / ${states.notKnown}`,
      callsInGraph: judged.length,
      surplusCalls: surplus,
      outsideWrong,
      misses: byRef.misses,
    };
    if (wrongs.length > 0) results[name]!.wrongLinks = Object.fromEntries(wrongs.slice(0, 40).map((w, i) => [w, i]));
    perCall[name] = {};
    for (const j of judged) perCall[name]![at(j.file, j.call.line, j.call.col)] = { state: j.state, links: j.links.map((n) => `${fileOfNode.get(n)}:${n.qualified}@${n.start}`) };
  }
}

console.log(`repo ${repo}: ${files.length} .rs files, ${[...parsed.values()].filter((f) => f.hasError).length} with a parse error; parse ${parseMs.toFixed(0)} ms`);
console.log(`nodes ${[...parsed.values()].reduce((a, f) => a + f.nodes.length, 0)}; calls parsed ${[...parsed.values()].reduce((a, f) => a + f.calls.filter((c) => !c.inMacro).length, 0)}, in macro input ${[...parsed.values()].reduce((a, f) => a + f.calls.filter((c) => c.inMacro).length, 0)}`);
console.log(`rustc: ${rustc.calls.size} calls written in the repo, ${reference.length} to a declaration in the repo; ${rustc.conflicts} answered differently by two compilations; ${compiledFiles.size} files compiled, ${notCompiled.length} files with nodes not compiled`);
console.log(`functions found: ${format(fnScore)}; nodes of compiled files the compiler lists: ${format(fnBack)}`);
for (const [name, defs] of Object.entries(raDefs)) {
  const own = new Map<string, string[]>();
  for (const [f, ds] of defs) own.set(f, ds.map((d) => `${d.line}-${d.endLine}`));
  const refCallables = new Map([...rustc.defs].map(([f, ds]) => [f, ds.filter((d) => d.kind === "fn" || d.kind === "assoc_fn").map((d) => `${d.ident.line}-${d.whole.end}`)]));
  console.log(`${name}'s own list of functions against the compiler's (named callables): ${format(functionsFound(refCallables, own))}`);
}
console.log(JSON.stringify(results, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ results, perCall, notCompiled, judge: Object.fromEntries(judge), calls: Object.fromEntries(rustc.calls) }));
