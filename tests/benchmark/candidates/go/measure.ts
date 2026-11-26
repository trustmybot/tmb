// The A/B of way B's tool for Go (trustmybot/tmb#346): scores each candidate on one repo.
//
//   bun tests/benchmark/candidates/go/measure.ts <repo dir> <out.json> [--without-modules] [--only=gotypes,gopls,scip-go]
//
// Environment (nothing is installed by the harness; each tool is the one named here):
//   TMB_CANDIDATE_GO_GRAMMAR  tree-sitter-go.wasm, from the tree-sitter-go npm package
//   GOTYPES_BIN               the built gotypes/main.go
//   GOPLS_BIN, SCIP_GO_BIN    the candidates' binaries
//   TMB_GO_SCRATCH            a folder for the file list and the SCIP index
//   TMB_GO_EMPTY_MODCACHE     with --without-modules: an empty folder used as GOMODCACHE
// The go command and its caches come from the environment (GOROOT, GOMODCACHE, GOCACHE, PATH).
//
// The nodes and calls are the tree-sitter grammar's (nodes.ts), the same for every candidate. The
// reference is go/types with the modules downloaded: Go has no tool independent of it, so a link
// is judged against it, and disagreements are judged by hand (handcheck.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { callsAccountedFor, format, functionsFound, type GraphCall, linksFoundByReference, linksFoundByState, type ReferenceCall } from "../../score.ts";
import { type Answer, type Answers, callKey, goplsAnswers, gotypesAnswers, runGotypes, scipAnswers, type GotypesCall } from "./answers.ts";
import { CALLABLE, type GoCall, type GoNode, goParser, parseFile } from "./nodes.ts";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};

/** The candidates, by name. */
const CANDIDATES = ["gotypes", "gopls", "scip-go"] as const;
type Candidate = (typeof CANDIDATES)[number];

/** The kinds of declaration go/types gives that the graph has a node for, by "Kinds of symbol". */
const NODE_DECLS = ["func", "method", "pkgvar"];
const IFACE_DECL = "ifacemethod";

export type State = "linked" | "outside" | "notKnown" | "conversion";
export type Row = { file: string; line: number; pos: number; name: string; owner: number; answer: Answer; state: State; node?: { file: string; qualified: string; kind: string; start: number; end: number } };

/**
 * The page's rule for way B (CODE_GRAPH.md, "Two ways to make links"): the declaration is matched
 * to a node by place, same file, same name, overlapping lines, and when two fit, the one that
 * starts on the same line wins. Linked when it fits a node, outside when it is outside the repo,
 * not known otherwise. A callee the candidate says is a type, or that fits a type node, makes the
 * call a conversion (Go spec, "Conversions"), which is no call.
 */
export function state(call: GoCall, a: Answer, byFile: Map<string, GoNode[]>): Row {
  const row: Row = { file: call.file, line: call.line, pos: call.pos, name: call.name, owner: call.owner, answer: a, state: "notKnown" };
  if (a.kind !== "none" && a.isType) return { ...row, state: "conversion" };
  if (a.kind === "outside") return { ...row, state: "outside" };
  if (a.kind === "none") return row;
  const fits = (byFile.get(a.file) ?? []).filter((n) => n.kind !== "unnamed" && n.name === call.name && n.start <= a.line && n.end >= a.line);
  const node = fits.find((n) => n.start === a.line) ?? fits[0];
  if (!node) return row;
  // A type is declared by its name, on its first line. A declaration inside a type's lines that
  // fits no other node, such as an interface's method of the type's own name, is not the type.
  if (node.kind === "type") return a.line === node.start ? { ...row, state: "conversion" } : row;
  return { ...row, state: "linked", node: { file: node.file, qualified: node.qualified, kind: node.kind, start: node.start, end: node.end } };
}

type Verdict = "right" | "wrong" | "notJudged";

/** A link judged against go/types: right when its declaration is in the linked node. */
export function judge(row: Row, ref: GotypesCall | undefined): Verdict {
  if (!row.node || !ref || !ref.decl) return "notJudged";
  if (!ref.decl.inRepo || ref.kind !== "call") return "wrong";
  return ref.decl.file === row.node.file && row.node.start <= ref.decl.line && row.node.end >= ref.decl.line ? "right" : "wrong";
}

/** The kind of code a missed call is, for the misses by cause. */
const causeOf = (c: GotypesCall) => `${c.callee} -> ${c.decl?.kind ?? "?"}`;

async function main() {
  const [repo, outPath, ...flags] = process.argv.slice(2);
  if (!repo || !outPath) throw new Error("usage: measure.ts <repo> <out.json> [--without-modules] [--only=...]");
  const withoutModules = flags.includes("--without-modules");
  const only = flags.find((f) => f.startsWith("--only="))?.slice("--only=".length).split(",") ?? [...CANDIDATES];
  const scratch = env("TMB_GO_SCRATCH");
  mkdirSync(scratch, { recursive: true });

  const files = (await $`git -C ${repo} ls-files --cached --others --exclude-standard -- '*.go'`.text()).split("\n").filter((f) => f !== "" && !f.split("/").includes("vendor"));
  const texts = new Map(await Promise.all(files.map(async (f) => [f, await Bun.file(join(repo, f)).text()] as const)));
  const fileList = join(scratch, "files.txt");
  writeFileSync(fileList, files.join("\n"));
  const module = /^module\s+(\S+)/m.exec(texts.has("go.mod") ? (texts.get("go.mod") ?? "") : await Bun.file(join(repo, "go.mod")).text())?.[1] ?? "";
  const commit = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();

  // Nodes and calls, from the grammar.
  const parser = await goParser(env("TMB_CANDIDATE_GO_GRAMMAR"));
  const t0 = performance.now();
  const parsed = files.map((f) => parseFile(parser, f, texts.get(f) ?? "", { interfaceMethods: true }));
  const parseMs = Math.round(performance.now() - t0);
  const allNodes = parsed.flatMap((p) => p.nodes);
  const calls = parsed.flatMap((p) => p.calls);
  const notParsed = files.filter((_, i) => !parsed[i]?.parsed);

  // The reference: go/types with the modules (always), and the compiler's functions.
  const reference = await runGotypes(env("GOTYPES_BIN"), repo, fileList, texts, []);
  const refByKey = new Map(reference.calls.map((c) => [callKey(c.file, c.pos), c]));
  const refFns = new Map<string, string[]>();
  for (const f of reference.functions) if (f.kind === "func" || f.kind === "method" || f.kind === "funclit") refFns.set(f.file, [...(refFns.get(f.file) ?? []), `${f.start}-${f.end}`]);
  const graphFns = new Map<string, string[]>();
  for (const n of allNodes) if (CALLABLE.includes(n.kind)) graphFns.set(n.file, [...(graphFns.get(n.file) ?? []), `${n.start}-${n.end}`]);
  const functions = functionsFound(refFns, graphFns);

  // Without the modules, the candidates run with an empty module cache and no proxy.
  if (withoutModules) {
    process.env.GOMODCACHE = env("TMB_GO_EMPTY_MODCACHE");
    process.env.GOPROXY = "off";
  }

  const results: Record<string, unknown> = {};
  for (const name of only as Candidate[]) {
    let ans: Answers;
    if (name === "gotypes") ans = gotypesAnswers(withoutModules ? await runGotypes(env("GOTYPES_BIN"), repo, fileList, texts, []) : reference);
    else if (name === "gopls") ans = await goplsAnswers(env("GOPLS_BIN"), repo, calls);
    else ans = await scipAnswers(env("SCIP_GO_BIN"), repo, module, join(scratch, `index-${withoutModules ? "nomods" : "mods"}.scip`), calls, texts);

    const variants: Record<string, unknown> = {};
    for (const iface of [false, true]) {
      const byFile = new Map<string, GoNode[]>();
      for (const n of allNodes) if (iface || n.kind !== "ifacemethod") byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
      const rows = calls.map((c) => state(c, ans.answers.get(callKey(c.file, c.pos)) ?? { kind: "none" }, byFile));
      const count = (s: State) => rows.filter((r) => r.state === s).length;
      const states = { linked: count("linked"), outside: count("outside"), notKnown: count("notKnown") };

      const verdicts = { right: 0, wrong: 0, notJudged: 0 };
      const wrong: string[] = [];
      for (const r of rows.filter((x) => x.state === "linked")) {
        const v = judge(r, refByKey.get(callKey(r.file, r.pos)));
        verdicts[v]++;
        if (v === "wrong") wrong.push(`${r.file}:${r.line} ${r.name} -> ${r.node?.qualified}`);
      }

      const kinds = iface ? [...NODE_DECLS, IFACE_DECL] : NODE_DECLS;
      const refCalls: ReferenceCall[] = reference.calls
        .filter((c) => c.kind === "call" && c.decl?.inRepo && kinds.includes(c.decl.kind))
        .map((c) => ({ file: c.file, line: c.line, pos: c.pos, names: [c.name], decls: [{ file: c.decl?.file ?? "", spans: [{ start: c.decl?.line ?? 0, end: c.decl?.line ?? 0 }] }], cause: causeOf(c) }));
      const graphCalls: GraphCall[] = rows.filter((r) => r.node).map((r) => ({ file: r.file, line: r.line, pos: r.pos, name: r.name, dst: r.node?.file ?? "", start: r.node?.start ?? 0, end: r.node?.end ?? 0 }));
      const byRef = linksFoundByReference(refCalls, graphCalls);

      const refOwners = new Map<string, number>();
      for (const c of reference.calls) if (c.kind !== "conversion") refOwners.set(`${c.file}:${c.owner}`, (refOwners.get(`${c.file}:${c.owner}`) ?? 0) + 1);
      const graphOwners = new Map<string, number>();
      for (const r of rows) if (r.state !== "conversion") graphOwners.set(`${r.file}:${r.owner}`, (graphOwners.get(`${r.file}:${r.owner}`) ?? 0) + 1);
      const outsideWrong = rows.filter((r) => r.state === "outside" && refByKey.get(callKey(r.file, r.pos))?.decl?.inRepo).map((r) => `${r.file}:${r.line} ${r.name}`);
      const accounted = callsAccountedFor(refOwners, graphOwners, outsideWrong.length);

      variants[iface ? "interfaceMethodsAsNodes" : "default"] = {
        functionsFound: format(functions),
        linksRight: format({ n: verdicts.right, of: verdicts.right + verdicts.wrong }),
        linksRightDetail: verdicts,
        linksFoundByState: format(linksFoundByState(states)),
        linksFoundByReference: format(byRef),
        callsAccountedFor: format(accounted),
        states: { ...states, conversion: count("conversion") },
        missesByCause: byRef.misses,
        missedExamples: byRef.missed.slice(0, 40).map((m) => `${m.file}:${m.line} ${m.names[0]} (${m.cause})`),
        wrong,
        outsideWrong,
        rows: iface ? undefined : rows,
      };
      console.log(`${name}${withoutModules ? " (no modules)" : ""}${iface ? " +iface" : ""}: functions ${format(functions)}, links right ${format({ n: verdicts.right, of: verdicts.right + verdicts.wrong })} (not judged ${verdicts.notJudged}), by state ${format(linksFoundByState(states))}, by reference ${format(byRef)}, accounted ${format(accounted)}, states ${JSON.stringify(states)} conv ${count("conversion")}`);
    }
    results[name] = { ms: ans.ms, note: ans.note, ...variants };
  }

  const refKinds: Record<string, number> = {};
  for (const c of reference.calls) refKinds[`${c.kind}:${c.decl ? (c.decl.inRepo ? `repo ${c.decl.kind}` : `outside ${c.decl.kind}`) : "none"}`] = (refKinds[`${c.kind}:${c.decl ? (c.decl.inRepo ? `repo ${c.decl.kind}` : `outside ${c.decl.kind}`) : "none"}`] ?? 0) + 1;
  const out = {
    repo,
    commit,
    module,
    withoutModules,
    files: files.length,
    notParsed,
    parseMs,
    nodes: Object.fromEntries(["function", "method", "unnamed", "type", "data", "ifacemethod"].map((k) => [k, allNodes.filter((n) => n.kind === k).length])),
    treeSitterCalls: calls.length,
    reference: { go: reference.go, ms: reference.ms, loadMs: reference.loadMs, packages: reference.packages, errors: reference.errors.slice(0, 20), errorCount: reference.errors.length, loaded: reference.loaded.length, notLoaded: files.filter((f) => !reference.loaded.includes(f)), calls: reference.calls.length, kinds: refKinds, parseFails: reference.parseFails },
    results,
    referenceCalls: reference.calls,
  };
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`files ${files.length}, nodes ${JSON.stringify(out.nodes)}, tree-sitter calls ${calls.length}, reference calls ${reference.calls.length}, not loaded ${out.reference.notLoaded.length}, load errors ${reference.errors.length}`);
}

if (import.meta.main) await main();
