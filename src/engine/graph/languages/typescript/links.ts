// The link check of trustmybot/tmb#242: every `calls` and `instantiates` link the code graph
// makes, in the same file or across files, with resolution `exact` in TypeScript and JavaScript is compared with the
// TypeScript compiler's own answer for the same name. A link the graph did not make is no
// failure; a link to another file or declaration than the compiler's is, and so is a link into
// the repo where the compiler names only a declaration outside it (trustmybot/tmb#287). The
// compiler is the TypeScript 5.9 compiler tmb carries for way B, a dependency of tmb, given the
// same commit the graph reads. The check runs in the tests and the benchmark, never in tmb's
// commands.
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript5";
import { buildLayer, FUNCTION_KINDS } from "../../build.ts";
import { BASE_LAYER, openGraphDb } from "../../db.ts";
import { commitReader, listTree, readBlobs, resolveCommit } from "../../git-source.ts";
import { isImportConfigPath } from "../../import-config.ts";
import { calleeOf as calleeIn, isCallNode, originalNames as originalIn } from "./compiler.ts";
import { coveredLanguage, scriptKind } from "./coverage.ts";
import { projectsOf } from "./projects.ts";

/** Files larger than this the graph does not parse, so the compiler does not read them either. */
const MAX_BYTES = 1_000_000;

type Span = { start: number; end: number };

/** How a wrong link names the compiler's answer when that is a declaration outside the repo. */
const OUTSIDE = "a declaration outside the repo";

/** What the compiler says one call or construction's callee is. */
export type Answer =
  | { kind: "declared"; decls: { file: string; spans: Span[] }[]; importFile: string | null }
  | { kind: "external" }
  | { kind: "unknown" };

/**
 * Where a use of a name is in a file: its line, and for a call its position, the offset where the
 * name it calls is written, else where the call starts (CODE_GRAPH.md, "Two ways to make links").
 * A use that is no call has no position.
 */
export type Place = { line: number; pos: number | null };

/**
 * The compiler's answers for a name used at a place of a file: the call at the position, when the
 * place has one; else every reference to the name on the line.
 */
export type CompilerLookup = (file: string, at: Place, name: string) => Answer[];

/**
 * One call or construction the compiler finds in a file: the line it starts on; its position, as
 * the graph records it, the offset where the name it calls is written, else where it starts; the
 * names it may record it by (the callee's, and the name an import under a new name declares it
 * as); and the compiler's answer for the callee.
 */
export type CompilerCall = {
  file: string;
  node: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;
  callee: ts.Identifier | ts.PrivateIdentifier | null;
  line: number;
  pos: number;
  names: string[];
  answer: Answer;
};

/**
 * The compiler's programs of a repo at a commit: its answer for a name on a line, every call of a
 * file, and the checker of the program a file is resolved in.
 */
export type CompilerProgram = { lookup: CompilerLookup; calls: (file: string) => CompilerCall[]; checkerOf: (file: string) => ts.TypeChecker };

/** One link of the graph: the call's file, line and position, the name it calls, and the declaration it links. */
export type GraphLink = { src: string; line: number; pos: number | null; name: string; dst: string; start: number; end: number; kind: string };

export type LinkVerdict = "right" | "wrong" | "unknown" | "no reference";

export type LinkReport = {
  /** Every link checked. */
  links: number;
  right: number;
  wrong: string[];
  /** Links the compiler gave no answer for, by why: not judged. */
  notJudged: { unknown: number; noReference: number };
  /** The links reached through an `export … from` or `export *`: the import's file is not the target's. */
  reexports: { right: number; wrong: number };
  /** Milliseconds spent building the graph, and the compiler's program with its answers. */
  ms: { graph: number; compiler: number };
};

const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

/** The TypeScript and JavaScript files of the repo at `commit` the graph would parse, by path. */
export function commitTexts(repoDir: string, commit: string): Map<string, string> {
  const root = path.resolve(repoDir);
  const entries = listTree(root, commit).filter((e) => e.size <= MAX_BYTES && coveredLanguage(e.path) !== null);
  const blobs = readBlobs(
    root,
    entries.map((e) => e.blob),
  );
  const texts = new Map<string, string>();
  for (const e of entries) {
    const text = blobs.get(e.blob);
    if (text !== undefined) texts.set(e.path, text);
  }
  return texts;
}

/** The name a call, a construction, a JSX element or a tagged template calls, when it is one. */
const calleeOf = (node: ts.Node) => calleeIn(ts, node);

/** One name on a line: a callee, or any other reference, which the graph also links (a function passed as a value). */
type Ref = { name: string; node: ts.Identifier | ts.PrivateIdentifier };

/**
 * The TypeScript compiler's program of the repo at `commit`, read from git as the graph reads it,
 * and a lookup of its answer for a name at a place. A call is found at the position where the name
 * it calls is written. A reference that is no call is found on its line; a call's callee counts on
 * its own line and on the call's first line, where the graph records a call that spans lines.
 */
export function compilerLookup(repoDir: string, commit: string, texts = commitTexts(repoDir, commit)): CompilerLookup {
  return compilerProgram(repoDir, commit, texts).lookup;
}

/**
 * The compiler's programs of the repo at `commit`, read from git as the graph reads it: each file
 * in the program of the config that owns it, as way B resolves it (CODE_GRAPH.md, "Two ways to make
 * links"), with the repo's configs and the files they name. No installed package is read.
 */
export function compilerProgram(repoDir: string, commit: string, texts = commitTexts(repoDir, commit)): CompilerProgram {
  const root = path.resolve(repoDir);
  const tree = listTree(root, commit);
  const configEntries = tree.filter((e) => isImportConfigPath(e.path));
  const blobs = readBlobs(
    root,
    configEntries.map((e) => e.blob),
  );
  const withConfigs = new Map(texts);
  for (const e of configEntries) {
    const text = blobs.get(e.blob);
    if (text !== undefined && !withConfigs.has(e.path)) withConfigs.set(e.path, text);
  }
  const projects = projectsOf(ts, root, { texts: withConfigs, installed: false, read: commitReader(root, tree) }, texts.keys());
  const programOf = (file: string) => projects.programOf(file);
  const checkerOf = (file: string) => programOf(file).getTypeChecker();
  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const inRepo = (sf: ts.SourceFile) => texts.has(rel(sf.fileName));

  /** The file an imported name's import names, when the name is an import of a file of the repo. */
  const importFileOf = (checker: ts.TypeChecker, sym: ts.Symbol | undefined): string | null => {
    if (sym === undefined || (sym.flags & ts.SymbolFlags.Alias) === 0) return null;
    let node: ts.Node | undefined = sym.declarations?.[0];
    while (node !== undefined && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isSourceFile(node)) node = node.parent;
    if (node === undefined || ts.isSourceFile(node)) return null;
    const spec = ts.isImportDeclaration(node) ? node.moduleSpecifier : ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : null;
    const target = spec === null ? undefined : checker.getSymbolAtLocation(spec)?.valueDeclaration;
    return target !== undefined && ts.isSourceFile(target) && inRepo(target) ? rel(target.fileName) : null;
  };

  const answer = (checker: ts.TypeChecker, id: ts.Identifier | ts.PrivateIdentifier): Answer => {
    const parent = id.parent;
    let sym = parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === id ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(id);
    if (sym === undefined) return { kind: "unknown" };
    // The import the name reaches its declaration through: its own, or its namespace's for `ns.f`.
    const receiver = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === id && ts.isIdentifier(parent.expression) ? checker.getSymbolAtLocation(parent.expression) : undefined;
    const importFile = importFileOf(checker, sym) ?? importFileOf(checker, receiver);
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = checker.getAliasedSymbol(sym);
      } catch {
        return { kind: "unknown" };
      }
    }
    const all = sym.declarations ?? [];
    if (all.length === 0) return { kind: "unknown" };
    const decls = new Map<string, Span[]>();
    for (const d of all) {
      const sf = d.getSourceFile();
      if (!inRepo(sf)) continue;
      // Every declaration counts, so an overload's body and a merged declaration are each the name's.
      const spans = decls.get(rel(sf.fileName)) ?? [];
      spans.push({ start: lineOf(sf, d.getStart(sf)), end: lineOf(sf, d.getEnd()) });
      // A variable's function value: the whole statement's lines.
      if (ts.isVariableDeclaration(d) && d.parent?.parent !== undefined) spans.push({ start: lineOf(sf, d.parent.parent.getStart(sf)), end: lineOf(sf, d.parent.parent.getEnd()) });
      decls.set(rel(sf.fileName), spans);
    }
    if (decls.size === 0) return { kind: "external" };
    return { kind: "declared", decls: [...decls].map(([file, spans]) => ({ file, spans })), importFile };
  };

  // Each file's names by line and by position, made the first time a link asks for the file. A
  // name is one token, so the names at a position are those of one reference.
  type FileRefs = { byLine: Map<string, Ref[]>; byPos: Map<string, Ref[]> };
  const byFile = new Map<string, FileRefs>();
  const refsOf = (file: string): FileRefs => {
    const known = byFile.get(file);
    if (known !== undefined) return known;
    const refs: FileRefs = { byLine: new Map(), byPos: new Map() };
    byFile.set(file, refs);
    const sf = programOf(file).getSourceFile(path.join(root, file));
    if (sf === undefined) return refs;
    const original = originalNames(sf);
    const put = (into: Map<string, Ref[]>, at: number, name: string, ref: Ref) => {
      const key = `${at}\u0000${name}`;
      const here = into.get(key) ?? [];
      if (!here.some((r) => r.node === ref.node)) here.push(ref);
      into.set(key, here);
    };
    const add = (into: Map<string, Ref[]>, at: number, ref: Ref) => {
      put(into, at, ref.name, ref);
      const imported = original.get(ref.name);
      if (imported !== undefined) put(into, at, imported, ref);
    };
    const visit = (node: ts.Node): void => {
      const callee = calleeOf(node);
      if (callee !== null) {
        const ref = { name: callee.text, node: callee };
        add(refs.byLine, lineOf(sf, callee.getStart(sf)), ref);
        add(refs.byLine, lineOf(sf, node.getStart(sf)), ref);
        add(refs.byPos, callee.getStart(sf), ref);
      }
      if (ts.isIdentifier(node)) {
        const ref = { name: node.text, node };
        add(refs.byLine, lineOf(sf, node.getStart(sf)), ref);
        add(refs.byPos, node.getStart(sf), ref);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return refs;
  };

  const answers = new Map<ts.Node, Answer>();
  // A file's names are answered by the checker of the program the file is resolved in.
  const answerOf = (file: string, node: ts.Identifier | ts.PrivateIdentifier): Answer => {
    let a = answers.get(node);
    if (a === undefined) answers.set(node, (a = answer(checkerOf(file), node)));
    return a;
  };
  // A link with a position, a call or a use that is no call: the reference written there, of its
  // name. With none: every reference to the name on the line, as the line does not say which one
  // when it holds several (`[f].map((f) => f())`).
  const lookup: CompilerLookup = (file, at, name) => {
    const refs = refsOf(file);
    const found = at.pos === null ? refs.byLine.get(`${at.line}\u0000${name}`) : refs.byPos.get(`${at.pos}\u0000${name}`);
    return (found ?? []).map((r) => answerOf(file, r.node));
  };

  const calls = (file: string): CompilerCall[] => {
    const sf = programOf(file).getSourceFile(path.join(root, file));
    if (sf === undefined) return [];
    const original = originalNames(sf);
    const out: CompilerCall[] = [];
    const visit = (node: ts.Node): void => {
      if (isCall(node)) {
        const callee = calleeOf(node);
        const names = callee === null ? [] : [callee.text];
        const imported = callee === null ? undefined : original.get(callee.text);
        if (imported !== undefined) names.push(imported);
        out.push({ file, node, callee, line: lineOf(sf, node.getStart(sf)), pos: (callee ?? node).getStart(sf), names, answer: callee === null ? { kind: "unknown" } : answerOf(file, callee) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  };
  return { lookup, calls, checkerOf };
}

/** `import { a as b }`: the graph names a reference to `b` by the name `a` it is declared as. */
const originalNames = (sf: ts.SourceFile) => originalIn(ts, sf);

/** Every `calls` and `instantiates` link of a layer resolved `exact` between TypeScript or JavaScript files, in the same file or across files: every link is judged (CODE_GRAPH.md, Benchmark). */
export function graphLinks(db: Database, layer = BASE_LAYER): GraphLink[] {
  const rows = db
    .query(
      `SELECT s.path AS src, e.line AS line, e.pos AS pos, e.dst_name AS name, d.path AS dst, d.start_line AS start, d.end_line AS end, e.kind AS kind
         FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.kind IN ('calls', 'instantiates') AND e.resolution = 'exact'`,
    )
    .all(layer) as { src: string; line: number; pos: number | null; name: string; dst: string; start: number | null; end: number | null; kind: string }[];
  return rows
    .filter((r) => coveredLanguage(r.src) !== null && coveredLanguage(r.dst) !== null)
    .map((r) => ({ ...r, start: r.start ?? 0, end: r.end ?? r.start ?? 0 }));
}

/**
 * The verdict on one link: right when, for the reference at the link's position, where the name
 * it links is written (for a link with no position, a reference to the name on its line), one of the compiler's declarations is in the
 * link's file and its lines overlap the target's; wrong when the compiler names declarations and
 * none of them is, those outside the repo included, since every link of the graph is into the
 * repo; else not judged, saying why.
 */
export function judge(link: GraphLink, lookup: CompilerLookup): { verdict: LinkVerdict; reexport: boolean; compiler: string } {
  const here = lookup(link.src, { line: link.line, pos: link.pos }, link.name);
  if (here.length === 0) return { verdict: "no reference", reexport: false, compiler: "" };
  const overlaps = (s: Span) => s.start <= link.end && s.end >= link.start;
  const declared = here.flatMap((a) => (a.kind === "declared" ? [a] : []));
  const hit = declared.find((a) => a.decls.some((d) => d.file === link.dst && d.spans.some(overlaps)));
  // Reached through an `export … from` or `export *`: the import names another file than the declaration's.
  const reexport = (a: (typeof declared)[number]) => a.importFile !== null && !a.decls.some((d) => d.file === a.importFile);
  if (hit !== undefined) return { verdict: "right", reexport: reexport(hit), compiler: "" };
  const outside = here.some((a) => a.kind === "external");
  if (declared.length > 0 || outside) {
    const named = declared.map((a) => a.decls.map((d) => `${d.file}:${d.spans.map((s) => `${s.start}-${s.end}`).join(",")}`).join(" | "));
    const compiler = [...named, ...(outside ? [OUTSIDE] : [])].join("; ");
    return { verdict: "wrong", reexport: declared.some(reexport), compiler };
  }
  return { verdict: "unknown", reexport: false, compiler: "" };
}

/**
 * The call states of trustmybot/tmb#252, checked against the compiler: every call written in a
 * function is linked, outside the repo or not known, and the three add up to the calls the
 * compiler finds in that function. A call outside every function counts for its file.
 */
export type CallReport = {
  /** Calls and constructions the compiler finds in the files the graph read. */
  compiler: number;
  /** Of them, calls the graph holds a state for. */
  accounted: number;
  linked: number;
  outside: number;
  notKnown: number;
  /** linked / (linked + not known): the calls into the repo's own code the graph links. */
  linksFound: number;
  /** Each function, `file:start-end`, or file, where the graph's count is not the compiler's: "graph vs compiler". */
  differ: string[];
  /** Calls the graph puts outside the repo that the compiler finds declared in the repo. */
  outsideWrong: string[];
  /** How many calls each function, `file:start-end`, or file, `file:`, holds: the graph's states and the compiler's calls. */
  byFunction: { graph: Map<string, number>; compiler: Map<string, number> };
};

/** A call or a construction, as the compiler writes it: what the graph counts as a call. */
const isCall = (node: ts.Node): node is ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression => isCallNode(ts, node);

/**
 * How many calls the compiler finds in each function with a body, `start-end`, or else for the
 * file, "": outside every function, or in a class's body outside its methods, such as a field's
 * initial value, which the graph counts for the class, a node that is no function.
 */
export function compilerCalls(relPath: string, text: string): Map<string, number> {
  const file = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKind(relPath));
  const out = new Map<string, number>();
  // `around` is what encloses the nearest function: a parameter is defined with its function.
  const visit = (node: ts.Node, fn: string, around: string): void => {
    const isFn = ts.isFunctionLike(node);
    const here = isFn && "body" in node && node.body !== undefined ? `${lineOf(file, node.getStart(file))}-${lineOf(file, node.getEnd())}` : ts.isClassLike(node) ? "" : fn;
    if (isCall(node)) out.set(here, (out.get(here) ?? 0) + 1);
    // A decorator runs when the thing it decorates is defined, so its call belongs to what encloses that thing.
    const decoratorOwner = ts.isParameter(node) ? around : fn;
    ts.forEachChild(node, (c) => visit(c, ts.isDecorator(c) ? decoratorOwner : here, isFn ? fn : around));
  };
  visit(file, "", "");
  return out;
}

type StateRow = { path: string; kind: string; start: number | null; end: number | null; state: string; line: number; name: string };

/** The graph's calls in TypeScript and JavaScript files, each with its state and the symbol it is written in. */
function graphCalls(db: Database, layer = BASE_LAYER): StateRow[] {
  const rows = db
    .query(
      `SELECT s.path AS path, s.kind AS kind, s.start_line AS start, s.end_line AS end, e.call_state AS state, e.line AS line, e.dst_name AS name
         FROM edges e JOIN symbols s ON s.id = e.src_id WHERE e.layer = ? AND e.call_state IS NOT NULL`,
    )
    .all(layer) as StateRow[];
  return rows.filter((r) => coveredLanguage(r.path) !== null);
}

/** Checks the graph's call states of one built layer against the compiler. */
export function checkCalls(db: Database, texts: ReadonlyMap<string, string>, lookup: CompilerLookup, layer = BASE_LAYER): CallReport {
  const read = new Set((db.query("SELECT path FROM files WHERE layer = ? AND parse_error IS NULL").all(layer) as { path: string }[]).map((r) => r.path));
  const rows = graphCalls(db, layer);
  const graph = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.path}:${FUNCTION_KINDS.has(r.kind) ? `${r.start}-${r.end}` : ""}`;
    graph.set(key, (graph.get(key) ?? 0) + 1);
  }
  const compiler = new Map<string, number>();
  for (const [file, text] of texts) {
    if (!read.has(file) || coveredLanguage(file) === null) continue;
    for (const [fn, n] of compilerCalls(file, text)) compiler.set(`${file}:${fn}`, n);
  }
  const differ: string[] = [];
  for (const key of new Set([...graph.keys(), ...compiler.keys()])) {
    const g = graph.get(key) ?? 0;
    const c = compiler.get(key) ?? 0;
    if (g !== c) differ.push(`${key} ${g} vs ${c}`);
  }
  const outsideWrong: string[] = [];
  for (const r of rows) {
    if (r.state !== "outside") continue;
    // Checked against every reference to the name on the call's line, as the call states have been.
    const answers = lookup(r.path, { line: r.line, pos: null }, r.name);
    if (answers.some((a) => a.kind === "declared") && !answers.some((a) => a.kind !== "declared")) outsideWrong.push(`${r.path}:${r.line} \`${r.name}\``);
  }
  const count = (state: string) => rows.filter((r) => r.state === state).length;
  const linked = count("linked");
  const notKnown = count("not_known");
  return {
    compiler: [...compiler.values()].reduce((a, b) => a + b, 0),
    accounted: rows.filter((r) => read.has(r.path)).length,
    linked,
    outside: count("outside"),
    notKnown,
    linksFound: linked + notKnown === 0 ? 0 : linked / (linked + notKnown),
    differ: differ.sort(),
    outsideWrong,
    byFunction: { graph, compiler },
  };
}

/** Builds the graph of the repo at `commit` (HEAD by default) the way tmb does, in a scratch folder, and checks every link. */
export async function checkLinks(repoDir: string, commit = "HEAD"): Promise<LinkReport> {
  return (await checkRepo(repoDir, commit)).links;
}

/** Builds the graph of the repo at `commit` the way tmb does, in a scratch folder, and checks every link and every call state. */
export async function checkRepo(repoDir: string, commit = "HEAD"): Promise<{ links: LinkReport; calls: CallReport }> {
  const sha = resolveCommit(repoDir, commit);
  if (sha === null) throw new Error(`${repoDir} has no commit ${commit}`);
  const scratch = mkdtempSync(path.join(tmpdir(), "tmb-links-"));
  try {
    const t = performance.now();
    const db = openGraphDb(scratch);
    try {
      await buildLayer(db, repoDir, sha, BASE_LAYER, { force: true });
      const graphMs = performance.now() - t;
      const compilerStart = performance.now();
      const texts = commitTexts(repoDir, sha);
      const { links, calls } = checkLayer(db, compilerProgram(repoDir, sha, texts), texts);
      links.ms = { graph: Math.round(graphMs), compiler: Math.round(performance.now() - compilerStart) };
      return { links, calls };
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Checks every link and every call state of one built layer against the compiler's program of the
 * same commit. The time the compiler's answers take is in `links.ms.compiler`; the graph's is left
 * to the caller, who built it.
 */
export function checkLayer(db: Database, program: CompilerProgram, texts: ReadonlyMap<string, string>, layer = BASE_LAYER): { links: LinkReport; calls: CallReport } {
  const t = performance.now();
  const links = graphLinks(db, layer);
  const report: LinkReport = {
    links: links.length,
    right: 0,
    wrong: [],
    notJudged: { unknown: 0, noReference: 0 },
    reexports: { right: 0, wrong: 0 },
    ms: { graph: 0, compiler: 0 },
  };
  for (const link of links) {
    const { verdict, reexport, compiler } = judge(link, program.lookup);
    if (verdict === "right") report.right++;
    else if (verdict === "wrong") report.wrong.push(`${link.src}:${link.line} ${link.kind} \`${link.name}\` -> ${link.dst}:${link.start}-${link.end}; the compiler: ${compiler}`);
    else if (verdict === "unknown") report.notJudged.unknown++;
    else report.notJudged.noReference++;
    if (reexport && verdict === "right") report.reexports.right++;
    if (reexport && verdict === "wrong") report.reexports.wrong++;
  }
  report.ms.compiler = Math.round(performance.now() - t);
  return { links: report, calls: checkCalls(db, texts, program.lookup, layer) };
}
