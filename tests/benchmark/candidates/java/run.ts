// The A/B harness for Java's way B tool (trustmybot/tmb#346). Research only: nothing in src/ uses it.
//
// Every candidate runs on the same files, with and without the project's dependencies on the
// classpath. The nodes and calls come once from tree-sitter-java (nodes.ts); a candidate only
// answers what each call reaches. Its answer is matched to a node by place, as CODE_GRAPH.md says:
// same file, same name, overlapping lines; when two nodes fit, the one that starts on the same line
// wins. The four scores use tests/benchmark/score.ts's definitions.
//
// The reference is javac, the official compiler, with the dependencies. javac's own links are
// judged by the Eclipse compiler (JDT) with the dependencies, the one other complete Java compiler.
//
// Usage: bun tests/benchmark/candidates/java/run.ts <repo> <work dir> [deps dir]
// Environment (every tool lives outside the repo; tmb installs nothing):
//   TMB_JAVA_HOME     a JDK (javac and java)
//   TMB_JAVA_GRAMMAR  tree-sitter-java.wasm
//   TMB_JAVA_LIB      the folder of jars JDT and JavaParser need
//   TMB_JAVA_SCIP     the folder of the scip-java launcher (scip-java-*) and its javac plugin (scip-plugin.jar)
//   TMB_JAVA_RUNS     how many times each candidate runs, for the median time (default 1)
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { callsAccountedFor, format, functionsFound, linksFoundByReference, linksFoundByState, type GraphCall, type Ratio, type ReferenceCall } from "../../score.ts";
import { javaParser, keyOf, ownerAt, readFile, type JCall, type JNode } from "./nodes.ts";
import { scipAnswers } from "./scip.ts";

type Decl = { file: string; name: string; start: number; end: number };
type Answer = { file: string; pos: number; line: number; name: string; state: "repo" | "outside" | "unknown"; decls: Decl[]; why?: string };
type Fn = { file: string; name: string; kind: string; start: number; end: number };
type Run = { answers: Map<string, Answer>; fns: Fn[]; info: Record<string, string>; ms: number[] };
type State = "linked" | "outside" | "notKnown";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
};

const HERE = import.meta.dir;
const TOOLS = join(HERE, "tools");
/** Heap for the Java candidates; JDT and JavaParser hold every tree of the repo at once. */
const HEAP = "-Xmx6g";
export const CANDIDATES = ["javac", "jdt", "javaparser", "scip-java"] as const;
export type Candidate = (typeof CANDIDATES)[number];
const REFERENCE: Candidate = "javac";
const JUDGE_OF_REFERENCE: Candidate = "jdt";
/** A file Java compiles as a module declaration (JLS 7.7): read with it, the compilation is a module's. It declares no callable. */
const MODULE_DECLARATION = "module-info.java";

const at = (file: string, pos: number) => `${file}@${pos}`;

function sh(cmd: string[], cwd?: string): { ms: number; out: string } {
  const t = performance.now();
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const ms = performance.now() - t;
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${p.stderr.toString().slice(-4000)}`);
  return { ms, out: p.stdout.toString() };
}

function parseLines(text: string): Omit<Run, "ms"> {
  const answers = new Map<string, Answer>();
  const fns: Fn[] = [];
  const info: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.t === "call") answers.set(at(o.file, o.pos), o);
    else if (o.t === "fn") fns.push(o);
    else if (o.t === "info") info[o.key] = o.key in info ? `${info[o.key]} | ${o.value}` : o.value;
  }
  return { answers, fns, info };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

/** Compile the Java candidates once into the work folder. */
export function compileTools(work: string, javaHome: string, lib: string) {
  const javac = join(javaHome, "bin", "javac");
  const cp = `${lib}/*`;
  for (const [name, main] of [["javac", "JavacCandidate"], ["jdt", "JdtCandidate"], ["javaparser", "JavaParserCandidate"]] as const)
    sh([javac, "-nowarn", "-cp", cp, "-d", join(work, "classes", name), join(TOOLS, "Out.java"), join(TOOLS, `${main}.java`)]);
}

export async function runCandidate(c: Candidate, repo: string, list: string, cp: string, work: string, tag: string): Promise<Run> {
  const javaHome = env("TMB_JAVA_HOME");
  const java = join(javaHome, "bin", "java");
  const lib = env("TMB_JAVA_LIB");
  const runs = Number(process.env.TMB_JAVA_RUNS ?? "1");
  const out = join(work, `${c}-${tag}.jsonl`);
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    if (c === "scip-java") {
      const scip = env("TMB_JAVA_SCIP");
      const launcher = readdirSync(scip).find((f) => f.startsWith("scip-java-") && !f.endsWith(".sha256"));
      if (!launcher) throw new Error(`no scip-java launcher in ${scip}`);
      const tr = join(work, `scip-${tag}`);
      sh(["rm", "-rf", tr]);
      const files = Bun.spawnSync(["cat", list]).stdout.toString().split("\n").filter(Boolean);
      const t = performance.now();
      // The plugin runs inside javac, so javac is kept attributing past errors as the javac candidate is.
      const args = [join(javaHome, "bin", "javac"), "-proc:none", "-nowarn", "-encoding", "UTF-8", "-Xmaxerrs", "1000000", "-XDshould-stop.ifError=FLOW",
        "-cp", [join(scip, "scip-plugin.jar"), cp].filter(Boolean).join(":"), `-Xplugin:scip -sourceroot:${repo} -targetroot:${tr}/root`, "-d", `${tr}/classes`, ...files];
      const p = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
      const errors = (p.stderr.toString().match(/ error: /g) ?? []).length;
      sh([join(scip, launcher), "aggregate", `--targetroot=${tr}/root`, `--output=${tr}/index.scip`, "--allow-empty-index"], tr);
      const lines = await scipAnswers(`${tr}/index.scip`, repo);
      ms.push(performance.now() - t);
      lines.push(JSON.stringify({ t: "info", key: "errors", value: String(errors) }));
      await Bun.write(out, `${lines.join("\n")}\n`);
    } else {
      const main = { javac: "JavacCandidate", jdt: "JdtCandidate", javaparser: "JavaParserCandidate" }[c];
      const r = sh([java, HEAP, "-cp", `${join(work, "classes", c)}:${lib}/*`, main, repo, list, cp, out]);
      ms.push(r.ms);
    }
  }
  return { ...parseLines(await Bun.file(out).text()), ms };
}

/** The nodes of a declaration's place: same file, same name, overlapping lines; the same start line breaks a tie. */
function fit(d: Decl, byFile: Map<string, JNode[]>): JNode | null {
  const fits = (byFile.get(d.file) ?? []).filter((n) => n.kind !== "lambda" && n.name === d.name && n.start <= d.end && n.end >= d.start);
  if (fits.length === 1) return fits[0] as JNode;
  const same = fits.filter((n) => n.start === d.start);
  return same.length === 1 ? (same[0] as JNode) : null;
}

type Judged = { state: State; nodes: JNode[]; why: string };

/** A call's state from a candidate's answer (CODE_GRAPH.md: linked only when the declaration is a node). */
export function judge(a: Answer | undefined, byFile: Map<string, JNode[]>): Judged {
  if (!a) return { state: "notKnown", nodes: [], why: "no answer" };
  if (a.state === "outside") return { state: "outside", nodes: [], why: "outside" };
  if (a.state === "unknown") return { state: "notKnown", nodes: [], why: a.why ?? "unknown" };
  const nodes = a.decls.map((d) => fit(d, byFile)).filter((n): n is JNode => n !== null);
  if (nodes.length === 0) return { state: "notKnown", nodes: [], why: a.why === "implicit" ? "implicit member, no node" : "no node fits" };
  return { state: "linked", nodes, why: a.why ?? "" };
}

export type Scores = {
  functionsFound: Ratio & { extra: number };
  linksRight: { right: number; wrong: number; notJudged: number; judge: string };
  linksFoundByState: Ratio;
  linksFoundByReference: Ratio & { misses: Record<string, number> };
  callsAccountedFor: Ratio;
  states: Record<State, number>;
  notKnownWhy: Record<string, number>;
  answersOffCall: number;
  ms: number;
  info: Record<string, string>;
};

const fnKey = (f: { name: string; start: number; end: number; kind: string }) => (f.kind === "lambda" ? `λ ${f.start}-${f.end}` : `${f.name} ${f.start}-${f.end}`);

function score(c: Candidate, run: Run, ref: Run, refJudge: Run, nodes: JNode[], calls: JCall[], byFile: Map<string, JNode[]>): { scores: Scores; states: Map<string, Judged> } {
  // Functions found: the tool's own list of callables against the graph's, one to one by file, name and lines.
  const want = new Map<string, string[]>();
  for (const f of run.fns) want.set(f.file, [...(want.get(f.file) ?? []), fnKey(f)]);
  const have = new Map<string, string[]>();
  for (const n of nodes) if (n.kind !== "type") have.set(n.file, [...(have.get(n.file) ?? []), fnKey(n)]);
  const ff = functionsFound(want, have);
  const extra = functionsFound(have, want);

  const states = new Map<string, Judged>();
  const counts: Record<State, number> = { linked: 0, outside: 0, notKnown: 0 };
  const why: Record<string, number> = {};
  for (const call of calls) {
    const j = judge(run.answers.get(at(call.file, call.pos)), byFile);
    states.set(at(call.file, call.pos), j);
    counts[j.state]++;
    if (j.state === "notKnown") why[j.why] = (why[j.why] ?? 0) + 1;
  }
  const callAt = new Set(calls.map((x) => at(x.file, x.pos)));
  const answersOffCall = [...run.answers.keys()].filter((k) => !callAt.has(k)).length;

  // Links right: each link against the judge's answer for the same call, matched to a node by the same rule.
  const judgeRun = c === REFERENCE ? refJudge : ref;
  let right = 0;
  let wrong = 0;
  let notJudged = 0;
  for (const call of calls) {
    const j = states.get(at(call.file, call.pos)) as Judged;
    if (j.state !== "linked") continue;
    const r = judge(judgeRun.answers.get(at(call.file, call.pos)), byFile);
    if (r.state === "outside") wrong++;
    else if (r.state === "notKnown") notJudged++;
    else if (j.nodes.some((n) => r.nodes.includes(n))) right++;
    else wrong++;
  }

  // Links found against the reference: of the calls the reference links to a node, the share this candidate links there too.
  const refCalls: ReferenceCall[] = [];
  const graphCalls: GraphCall[] = [];
  for (const call of calls) {
    const r = judge(ref.answers.get(at(call.file, call.pos)), byFile);
    if (r.state === "linked") refCalls.push({ file: call.file, line: call.line, pos: call.pos, names: [call.name], decls: r.nodes.map((n) => ({ file: n.file, spans: [{ start: n.start, end: n.end }] })), cause: call.form });
    const j = states.get(at(call.file, call.pos)) as Judged;
    for (const n of j.nodes) graphCalls.push({ file: call.file, line: call.line, pos: call.pos, name: call.name, dst: n.file, start: n.start, end: n.end });
  }
  const lf = linksFoundByReference(refCalls, graphCalls);

  // Calls accounted for: per owner, the reference's calls against the calls the graph holds a state for.
  const refByOwner = new Map<string, number>();
  for (const a of ref.answers.values()) {
    const o = ownerAt(nodes, a.file, a.pos);
    refByOwner.set(o, (refByOwner.get(o) ?? 0) + 1);
  }
  const graphByOwner = new Map<string, number>();
  for (const call of calls) graphByOwner.set(call.owner, (graphByOwner.get(call.owner) ?? 0) + 1);
  let outsideWrong = 0;
  for (const call of calls) {
    if ((states.get(at(call.file, call.pos)) as Judged).state !== "outside") continue;
    if (ref.answers.get(at(call.file, call.pos))?.state === "repo") outsideWrong++;
  }
  const ca = callsAccountedFor(refByOwner, graphByOwner, outsideWrong);

  return {
    scores: {
      functionsFound: { ...ff, extra: extra.of - extra.n },
      linksRight: { right, wrong, notJudged, judge: c === REFERENCE ? JUDGE_OF_REFERENCE : REFERENCE },
      linksFoundByState: linksFoundByState(counts),
      linksFoundByReference: { n: lf.n, of: lf.of, misses: lf.misses },
      callsAccountedFor: { ...ca, note: `${outsideWrong} outside the reference puts in the repo` },
      states: counts,
      notKnownWhy: why,
      answersOffCall,
      ms: median(run.ms),
      info: run.info,
    },
    states,
  };
}

if (import.meta.main) {
  const [repoArg, workArg, depsArg] = Bun.argv.slice(2);
  if (!repoArg || !workArg) throw new Error("usage: bun run.ts <repo> <work dir> [deps dir]");
  const repo = resolve(repoArg);
  const work = resolve(workArg);
  sh(["mkdir", "-p", work]);
  const files = sh(["git", "ls-files", "*.java"], repo).out.split("\n").filter((f) => f && !f.endsWith(`/${MODULE_DECLARATION}`) && f !== MODULE_DECLARATION);
  const list = join(work, "files.txt");
  await Bun.write(list, `${files.join("\n")}\n`);
  const deps = depsArg ? readdirSync(resolve(depsArg)).filter((f) => f.endsWith(".jar")).map((f) => join(resolve(depsArg), f)).join(":") : "";

  const p = await javaParser(env("TMB_JAVA_GRAMMAR"));
  const nodes: JNode[] = [];
  const calls: JCall[] = [];
  let unparsed = 0;
  for (const f of files) {
    const r = readFile(p, f, await Bun.file(join(repo, f)).text());
    nodes.push(...r.nodes);
    calls.push(...r.calls);
    if (r.errors) unparsed++;
  }
  const byFile = new Map<string, JNode[]>();
  for (const n of nodes) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
  console.log(`files ${files.length} (with a parse error: ${unparsed}); nodes ${nodes.length} (${nodes.filter((n) => n.kind !== "type").length} callables); calls ${calls.length}`);

  compileTools(work, env("TMB_JAVA_HOME"), env("TMB_JAVA_LIB"));
  const only = (process.env.TMB_JAVA_ONLY ?? CANDIDATES.join(",")).split(",") as Candidate[];
  const tags = deps ? (["deps", "nodeps"] as const) : (["nodeps"] as const);
  const runs = new Map<string, Run>();
  for (const tag of tags)
    for (const c of only) {
      const r = await runCandidate(c, repo, list, tag === "deps" ? deps : "", work, tag);
      runs.set(`${c}-${tag}`, r);
      console.log(`ran ${c} ${tag}: ${Math.round(median(r.ms))} ms`);
    }
  const refTag = deps ? "deps" : "nodeps";
  const ref = runs.get(`${REFERENCE}-${refTag}`);
  const refJudge = runs.get(`${JUDGE_OF_REFERENCE}-${refTag}`);
  if (!ref || !refJudge) throw new Error("the reference and its judge must run");
  const results: Record<string, Scores> = {};
  const allStates: Record<string, Record<string, { state: State; nodes: string[]; why: string }>> = {};
  for (const [k, r] of runs) {
    const c = k.replace(/-(deps|nodeps)$/, "") as Candidate;
    const { scores, states } = score(c, r, ref, refJudge, nodes, calls, byFile);
    results[k] = scores;
    allStates[k] = Object.fromEntries([...states].map(([pos, j]) => [pos, { state: j.state, nodes: j.nodes.map(keyOf), why: j.why }]));
    console.log(`\n== ${k}  (${Math.round(scores.ms)} ms; tool errors ${r.info.errors ?? "?"})`);
    console.log(`functions found      ${format(scores.functionsFound)}; graph callables the tool does not list: ${scores.functionsFound.extra}`);
    console.log(`links right          ${scores.linksRight.right} right, ${scores.linksRight.wrong} wrong, ${scores.linksRight.notJudged} not judged (judge: ${scores.linksRight.judge} ${refTag})`);
    console.log(`links found by state ${format(scores.linksFoundByState)}`);
    console.log(`links found by ref   ${format(scores.linksFoundByReference)}  misses ${JSON.stringify(scores.linksFoundByReference.misses)}`);
    console.log(`calls accounted for  ${format(scores.callsAccountedFor)}`);
    console.log(`states               ${JSON.stringify(scores.states)}; not known: ${JSON.stringify(scores.notKnownWhy)}; answers off a graph call: ${scores.answersOffCall}`);
  }
  await Bun.write(join(work, "results.json"), JSON.stringify({ files: files.length, nodes: nodes.length, calls: calls.length, results }, null, 1));
  await Bun.write(join(work, "states.json"), JSON.stringify({ calls, states: allStates }));
}
