// The A/B harness for C and C++ (trustmybot/tmb#346): research only, nothing in src/ uses it.
//
// The nodes and the calls come from tree-sitter, the same for every candidate (CODE_GRAPH.md, "Two
// ways to make links"): each language's rules are in rules_c.ts and ../cpp/rules_cpp.ts. A
// candidate answers, for each call, the declarations its tool gives for the name the call is
// written at; the answer is matched to a node by place, and the four scores of
// tests/benchmark/score.ts are counted against the compiler's own answer (clang_reference.py).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import { callsAccountedFor, functionsFound, linksFoundByState, type Ratio } from "../../score.ts";

/** A symbol of the graph: a function, a method, a constructor, a type or an unnamed function. */
export type GraphNode = { file: string; name: string; kind: "function" | "method" | "type" | "unnamed"; start: number; end: number };
/** A call as the graph finds it: where the name it calls is written (1-based line and UTF-8 byte column), and the function it is in. */
export type GraphCall = { file: string; line: number; col: number; name: string; owner: GraphNode | null };
/** A declaration a tool gives: in the repo, by relative path and lines, or outside it. */
export type Decl = { file: string; start: number; end: number; name?: string } | { outside: string };
/** A tool's answer for one call: its declarations, none when it has no answer. */
export type Answer = Decl[];
export type Answers = Map<string, Answer>;

/** One language's rules for reading a file into nodes and calls. */
export type Rules = {
  language: "c" | "cpp";
  /** The file endings tmb would read in this language. */
  endings: readonly string[];
  /** The grammar's wasm, from the environment. */
  grammarEnv: string;
  nodes: (root: Node, file: string) => GraphNode[];
  calls: (root: Node, file: string, nodes: GraphNode[], text: string) => GraphCall[];
};

export const callKey = (file: string, line: number, col: number) => `${file}:${line}:${col}`;
export const keyOf = (c: { file: string; line: number; col: number }) => callKey(c.file, c.line, c.col);
export const spanKey = (n: { file: string; start: number; end: number }) => `${n.file}:${n.start}-${n.end}`;
export const isOutside = (d: Decl): d is { outside: string } => "outside" in d;

let runtime: Promise<void> | null = null;

/** A parser for the language, its grammar read from the file the environment names. */
export async function parserFor(rules: Rules): Promise<Parser> {
  const grammar = process.env[rules.grammarEnv];
  if (!grammar) throw new Error(`set ${rules.grammarEnv} to the tree-sitter grammar's .wasm`);
  if (!runtime) runtime = Parser.init();
  await runtime;
  const parser = new Parser();
  parser.setLanguage(await Language.load(new Uint8Array(readFileSync(grammar))));
  return parser;
}

/** The 1-based UTF-8 byte column of a tree-sitter node's start. */
export function byteColumn(text: string, node: Node): number {
  const lineStart = text.lastIndexOf("\n", node.startIndex - 1) + 1;
  return Buffer.byteLength(text.slice(lineStart, node.startIndex)) + 1;
}

/** The files of the repo in the language, as git tracks them at the checked-out commit. */
export function repoFiles(root: string, rules: Rules): string[] {
  const out = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed in ${root}`);
  return out.stdout.split("\0").filter((f) => rules.endings.some((e) => f.endsWith(e)));
}

export type Graph = { nodes: GraphNode[]; calls: GraphCall[]; byFile: Map<string, GraphNode[]>; parseErrors: string[] };

/** The nodes and the calls of every file of the repo in the language. */
export async function readRepo(root: string, rules: Rules, files = repoFiles(root, rules)): Promise<Graph> {
  const parser = await parserFor(rules);
  const nodes: GraphNode[] = [];
  const calls: GraphCall[] = [];
  const byFile = new Map<string, GraphNode[]>();
  const parseErrors: string[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    const tree = parser.parse(text);
    if (tree === null) continue;
    if (tree.rootNode.hasError) parseErrors.push(file);
    const own = rules.nodes(tree.rootNode, file);
    nodes.push(...own);
    byFile.set(file, own);
    calls.push(...rules.calls(tree.rootNode, file, own, text));
    tree.delete();
  }
  return { nodes, calls, byFile, parseErrors };
}

/** The function node a syntax node is in: the nearest ancestor of a kind that makes a function node. */
export function ownerOf(at: Node, nodes: GraphNode[], functionTypes: ReadonlySet<string>): GraphNode | null {
  let a: Node | null = at.parent;
  while (a !== null && !functionTypes.has(a.type)) a = a.parent;
  if (a === null) return null;
  const start = a.startPosition.row + 1;
  const end = a.endPosition.row + 1;
  let best: GraphNode | null = null;
  for (const n of nodes) {
    if (n.kind === "type" || n.end !== end || n.start > start) continue;
    if (best === null || n.start > best.start) best = n;
  }
  return best;
}

/**
 * The page's rule for matching a declaration to a node: same file, same name, overlapping lines;
 * when two nodes fit, the one that starts on the same line wins. A declaration that fits no node
 * gives no node.
 */
export function matchNode(graph: Graph, decl: Decl, name: string): GraphNode | null {
  if (isOutside(decl)) return null;
  const fits = (graph.byFile.get(decl.file) ?? []).filter((n) => n.name === name && n.start <= decl.end && n.end >= decl.start);
  if (fits.length === 0) return null;
  return fits.find((n) => n.start === decl.start) ?? fits[0]!;
}

export type State = "linked" | "outside" | "notKnown";
export type Resolved = { state: State; links: GraphNode[] };

/** A call's state from a tool's answer (CODE_GRAPH.md, "Two ways to make links"). */
export function resolve(graph: Graph, call: { name: string }, answer: Answer | undefined, nameOf: (d: Decl) => string = () => call.name): Resolved {
  if (answer === undefined || answer.length === 0) return { state: "notKnown", links: [] };
  const links = [...new Set(answer.map((d) => matchNode(graph, d, nameOf(d))).filter((n): n is GraphNode => n !== null))];
  if (links.length > 0) return { state: "linked", links };
  if (answer.every(isOutside)) return { state: "outside", links: [] };
  return { state: "notKnown", links: [] };
}

// ---------------------------------------------------------------------------------------------
// The compiler's answer (clang_reference.py) and the judge built from it.

type RefPlace = { file: string; start: number; end: number } | { outside: string } | null;
type RefDecl = { usr: string; kind: string; name: string; decl: RefPlace; def: RefPlace };
export type RefCall = { file: string; line: number; col: number; name: string; owners: string[]; decls: RefDecl[]; dynamic: boolean };
export type Reference = {
  units: { file: string; errors?: number; error?: string; first?: string[] }[];
  functions: { file: string; start: number; end: number; name: string; kind: string }[];
  defs: Record<string, { file: string; start: number; end: number; name: string }[]>;
  calls: RefCall[];
};

/** Run the compiler over the repo through libclang. */
export function runReference(opts: { python: string; libclang: string; cindexDir: string; root: string; cdb: string | null; language: "c" | "cpp"; out: string }): Reference {
  const script = path.join(import.meta.dir, "clang_reference.py");
  const r = spawnSync(opts.python, ["-I", script, opts.libclang, opts.cindexDir, opts.root, opts.cdb ?? "none", opts.language, opts.out], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`clang_reference.py failed: ${r.stderr}`);
  process.stderr.write(r.stdout);
  return JSON.parse(readFileSync(opts.out, "utf8")) as Reference;
}

/**
 * The definitions the compiler's answer reaches: the definition it sees in the same unit, else
 * every definition of the same USR in the repo (an entity with external linkage is one entity in
 * every unit: C11 6.2.2, C++ [basic.link]), else the declaration itself.
 */
export function referenceDecls(ref: Reference, call: RefCall): Answer {
  const out: Answer = [];
  for (const d of call.decls) {
    if (d.decl === null) continue;
    if ("outside" in d.decl) {
      out.push({ outside: d.decl.outside });
      continue;
    }
    // A construction by a class's name calls the constructor and names the class: the class that
    // declares the constructor is reached as well as the constructor's definition.
    if (d.kind === "CONSTRUCTOR") out.push({ ...d.decl, name: d.name });
    if (d.def !== null) {
      out.push({ ...d.def, name: d.name });
      continue;
    }
    const defs = ref.defs[d.usr];
    if (defs !== undefined && defs.length > 0) for (const x of defs) out.push({ ...x, name: d.name });
    else out.push({ ...d.decl, name: d.name });
  }
  return out;
}

/** The answer of clang alone, one unit at a time: the declaration the compiler binds in that unit, its definition when that unit has one. */
export function clangPerUnitAnswers(ref: Reference): Answers {
  const out: Answers = new Map();
  for (const c of ref.calls) {
    const ans: Answer = [];
    for (const d of c.decls) {
      const at = d.def ?? d.decl;
      if (at === null) continue;
      ans.push("outside" in at ? { outside: at.outside } : { ...at, name: d.name });
    }
    out.set(keyOf(c), ans);
  }
  return out;
}

export type Judged = { right: number; wrong: number; notJudged: number; wrongList: { call: string; got: string; want: string }[] };

export type Scores = {
  functionsFound: Ratio;
  states: Record<State, number>;
  linksRight: Judged;
  linksFoundByState: Ratio;
  linksFoundByReference: Ratio;
  callsAccountedFor: Ratio;
  answered: number;
};

const nodeLabel = (n: GraphNode) => `${n.file}:${n.start}-${n.end} ${n.name}`;

/** The reference's state and links for each call it finds, by position. */
export function referenceResolved(graph: Graph, ref: Reference): Map<string, Resolved & { call: RefCall }> {
  const out = new Map<string, Resolved & { call: RefCall }>();
  for (const c of ref.calls) {
    const ans = referenceDecls(ref, c);
    out.set(keyOf(c), { ...resolve(graph, c, ans, (d) => ("name" in d && d.name ? d.name : c.name)), call: c });
  }
  return out;
}

/** The compiler's function list against the graph's function nodes, for the files the compiler read. */
export function scoreFunctions(graph: Graph, ref: Reference): { ratio: Ratio; missing: string[]; extra: string[] } {
  const want = new Map<string, string[]>();
  for (const f of ref.functions) want.set(f.file, [...(want.get(f.file) ?? []), `${f.start}-${f.end}`]);
  const have = new Map<string, string[]>();
  for (const n of graph.nodes) if (n.kind !== "type" && want.has(n.file)) have.set(n.file, [...(have.get(n.file) ?? []), `${n.start}-${n.end}`]);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [file, w] of want) {
    const h = [...(have.get(file) ?? [])];
    for (const x of w) {
      const i = h.indexOf(x);
      if (i >= 0) h.splice(i, 1);
      else missing.push(`${file}:${x}`);
    }
    extra.push(...h.map((x) => `${file}:${x}`));
  }
  return { ratio: functionsFound(want, have), missing, extra };
}

/** The four scores of one candidate's answers, judged by the compiler's. */
export function score(graph: Graph, ref: Reference, refResolved: ReturnType<typeof referenceResolved>, answers: Answers): Scores & { perCall: Map<string, Resolved> } {
  const states: Record<State, number> = { linked: 0, outside: 0, notKnown: 0 };
  const perCall = new Map<string, Resolved>();
  const judged: Judged = { right: 0, wrong: 0, notJudged: 0, wrongList: [] };
  const graphCounts = new Map<string, number>();
  let outsideWrong = 0;
  let answered = 0;
  for (const c of graph.calls) {
    const key = keyOf(c);
    const a = answers.get(key);
    if (a !== undefined && a.length > 0) answered++;
    const r = resolve(graph, c, a);
    perCall.set(key, r);
    states[r.state]++;
    if (c.owner !== null) graphCounts.set(spanKey(c.owner), (graphCounts.get(spanKey(c.owner)) ?? 0) + 1);
    const want = refResolved.get(key);
    if (r.state === "outside" && want?.state === "linked") outsideWrong++;
    for (const link of r.links) {
      if (want === undefined || want.call.decls.length === 0) judged.notJudged++;
      else if (want.links.includes(link)) judged.right++;
      else if (want.state === "linked" || want.state === "outside") {
        judged.wrong++;
        judged.wrongList.push({ call: `${key} ${c.name}`, got: nodeLabel(link), want: want.state === "outside" ? "outside" : want.links.map(nodeLabel).join(" | ") });
      } else judged.notJudged++;
    }
  }
  const refCounts = new Map<string, number>();
  for (const c of ref.calls) for (const o of c.owners.slice(0, 1)) refCounts.set(o, (refCounts.get(o) ?? 0) + 1);
  let found = 0;
  let of = 0;
  for (const [key, want] of refResolved) {
    if (want.state !== "linked") continue;
    of++;
    const got = perCall.get(key);
    if (got !== undefined && got.links.some((l) => want.links.includes(l))) found++;
  }
  return {
    functionsFound: scoreFunctions(graph, ref).ratio,
    states,
    linksRight: judged,
    linksFoundByState: linksFoundByState(states),
    linksFoundByReference: { n: found, of },
    callsAccountedFor: callsAccountedFor(refCounts, graphCounts, outsideWrong),
    answered,
    perCall,
  };
}

export const pct = (r: Ratio) => (r.of === 0 ? "none" : `${((r.n / r.of) * 100).toFixed(1)}% (${r.n}/${r.of})`);
