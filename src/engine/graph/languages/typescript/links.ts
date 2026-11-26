// The link check of trustmybot/tmb#242: every cross-file `calls` and `instantiates` link the code
// graph makes with resolution `exact` in TypeScript and JavaScript is compared with the
// TypeScript compiler's own answer for the same name. A link the graph did not make is no
// failure; a link to another file or declaration than the compiler's is, and so is a link into
// the repo where the compiler names only a declaration outside it (trustmybot/tmb#287). The
// compiler is the TypeScript 5.9 compiler, a development dependency only, given the same commit
// the graph reads.
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript5";
import { buildLayer } from "../../build.ts";
import { BASE_LAYER, openGraphDb } from "../../db.ts";
import { listTree, readBlobs, resolveCommit } from "../../git-source.ts";
import { coveredLanguage } from "./coverage.ts";

/** Files larger than this the graph does not parse, so the compiler does not read them either. */
const MAX_BYTES = 1_000_000;

type Span = { start: number; end: number };

/** How a wrong link names the compiler's answer when that is a declaration outside the repo. */
const OUTSIDE = "a declaration outside the repo";

/** What the compiler says one call or construction's callee is. */
type Answer =
  | { kind: "declared"; decls: { file: string; spans: Span[] }[]; importFile: string | null }
  | { kind: "external" }
  | { kind: "unknown" };

/** The compiler's answers for the references to a name on one line of a file. */
export type CompilerLookup = (file: string, line: number, name: string) => Answer[];

/** One link of the graph: the call's file and line, the name it calls, and the declaration it links. */
export type GraphLink = { src: string; line: number; name: string; dst: string; start: number; end: number; kind: string };

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

/** A compiler host that reads the repo's files from the commit, and the compiler's own lib files from disk. */
function commitHost(root: string, texts: ReadonlyMap<string, string>, options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const prefix = root + path.sep;
  const own = (file: string) => file === root || file.startsWith(prefix);
  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const dirs = new Set<string>();
  for (const file of texts.keys()) for (let d = path.posix.dirname(file); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
  const { getSourceFile } = host;
  return {
    ...host,
    getCurrentDirectory: () => root,
    fileExists: (file) => (own(file) ? texts.has(rel(file)) : ts.sys.fileExists(file)),
    readFile: (file) => (own(file) ? texts.get(rel(file)) : ts.sys.readFile(file)),
    directoryExists: (dir) => (own(dir) ? dir === root || dirs.has(rel(dir)) : ts.sys.directoryExists(dir)),
    getDirectories: (dir) => (own(dir) ? [] : ts.sys.getDirectories(dir)),
    realpath: (file) => file,
    getSourceFile: (file, version, onError) => {
      if (!own(file)) return getSourceFile.call(host, file, version, onError);
      const text = texts.get(rel(file));
      return text === undefined ? undefined : ts.createSourceFile(file, text, version, true);
    },
  };
}

/** The name a call, a construction, a JSX element or a tagged template calls, when it is one. */
function calleeOf(node: ts.Node): ts.Identifier | ts.PrivateIdentifier | null {
  const name = (expr: ts.Node): ts.Identifier | ts.PrivateIdentifier | null => {
    if (ts.isIdentifier(expr)) return expr;
    if (ts.isPropertyAccessExpression(expr)) return expr.name;
    if (ts.isParenthesizedExpression(expr)) return name(expr.expression);
    return null;
  };
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return name(node.expression);
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return name(node.tagName);
  if (ts.isTaggedTemplateExpression(node)) return name(node.tag);
  return null;
}

/** One name on a line: a callee, or any other reference, which the graph also links (a function passed as a value). */
type Ref = { name: string; node: ts.Identifier | ts.PrivateIdentifier };

/**
 * The TypeScript compiler's program of the repo at `commit`, read from git as the graph reads it,
 * and a lookup of its answer for each reference to a name on a line. A call's callee counts on
 * its own line and on the call's first line, where the graph records a call that spans lines.
 */
export function compilerLookup(repoDir: string, commit: string): CompilerLookup {
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
  const options: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const program = ts.createProgram(
    [...texts.keys()].map((f) => path.join(root, f)),
    options,
    commitHost(root, texts, options),
  );
  const checker = program.getTypeChecker();
  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const inRepo = (sf: ts.SourceFile) => texts.has(rel(sf.fileName));

  /** The file an imported name's import names, when the name is an import of a file of the repo. */
  const importFileOf = (sym: ts.Symbol | undefined): string | null => {
    if (sym === undefined || (sym.flags & ts.SymbolFlags.Alias) === 0) return null;
    let node: ts.Node | undefined = sym.declarations?.[0];
    while (node !== undefined && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isSourceFile(node)) node = node.parent;
    if (node === undefined || ts.isSourceFile(node)) return null;
    const spec = ts.isImportDeclaration(node) ? node.moduleSpecifier : ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : null;
    const target = spec === null ? undefined : checker.getSymbolAtLocation(spec)?.valueDeclaration;
    return target !== undefined && ts.isSourceFile(target) && inRepo(target) ? rel(target.fileName) : null;
  };

  const answer = (id: ts.Identifier | ts.PrivateIdentifier): Answer => {
    const parent = id.parent;
    let sym = parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === id ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(id);
    if (sym === undefined) return { kind: "unknown" };
    // The import the name reaches its declaration through: its own, or its namespace's for `ns.f`.
    const receiver = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === id && ts.isIdentifier(parent.expression) ? checker.getSymbolAtLocation(parent.expression) : undefined;
    const importFile = importFileOf(sym) ?? importFileOf(receiver);
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

  // Each file's names by line, made the first time a link asks for the file.
  const byFile = new Map<string, Map<string, Ref[]>>();
  const refsOf = (file: string): Map<string, Ref[]> => {
    const known = byFile.get(file);
    if (known !== undefined) return known;
    const refs = new Map<string, Ref[]>();
    byFile.set(file, refs);
    const sf = program.getSourceFile(path.join(root, file));
    if (sf === undefined) return refs;
    // `import { a as b }`: the graph names a reference to `b` by the name `a` it is declared as.
    const original = new Map<string, string>();
    for (const stmt of sf.statements) {
      const bindings = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined;
      if (bindings !== undefined && ts.isNamedImports(bindings)) for (const el of bindings.elements) if (el.propertyName !== undefined) original.set(el.name.text, el.propertyName.text);
    }
    const put = (line: number, name: string, ref: Ref) => {
      const key = `${line}\u0000${name}`;
      const here = refs.get(key) ?? [];
      if (!here.some((r) => r.node === ref.node)) here.push(ref);
      refs.set(key, here);
    };
    const add = (line: number, ref: Ref) => {
      put(line, ref.name, ref);
      const imported = original.get(ref.name);
      if (imported !== undefined) put(line, imported, ref);
    };
    const visit = (node: ts.Node): void => {
      const callee = calleeOf(node);
      if (callee !== null) {
        const ref = { name: callee.text, node: callee };
        add(lineOf(sf, callee.getStart(sf)), ref);
        add(lineOf(sf, node.getStart(sf)), ref);
      }
      if (ts.isIdentifier(node)) add(lineOf(sf, node.getStart(sf)), { name: node.text, node });
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return refs;
  };

  const answers = new Map<ts.Node, Answer>();
  return (file, line, name) => {
    // Every reference to the name on the line: the graph's link is for one of them, which one the
    // line does not say when it holds several (`[f].map((f) => f())`).
    return (refsOf(file).get(`${line}\u0000${name}`) ?? []).map((r) => {
      let a = answers.get(r.node);
      if (a === undefined) answers.set(r.node, (a = answer(r.node)));
      return a;
    });
  };
}

/** Every cross-file `calls` and `instantiates` link of a layer resolved `exact`, between TypeScript or JavaScript files. */
export function graphLinks(db: Database, layer = BASE_LAYER): GraphLink[] {
  const rows = db
    .query(
      `SELECT s.path AS src, e.line AS line, e.dst_name AS name, d.path AS dst, d.start_line AS start, d.end_line AS end, e.kind AS kind
         FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.kind IN ('calls', 'instantiates') AND e.resolution = 'exact' AND s.path != d.path`,
    )
    .all(layer) as { src: string; line: number; name: string; dst: string; start: number | null; end: number | null; kind: string }[];
  return rows
    .filter((r) => coveredLanguage(r.src) !== null && coveredLanguage(r.dst) !== null)
    .map((r) => ({ ...r, start: r.start ?? 0, end: r.end ?? r.start ?? 0 }));
}

/**
 * The verdict on one link: right when, for a reference to the name on the link's line, one of
 * the compiler's declarations is in the link's file and its lines overlap the target's; wrong
 * when the compiler names declarations and none of them is, those outside the repo included,
 * since every link of the graph is into the repo; else not judged, saying why.
 */
export function judge(link: GraphLink, lookup: CompilerLookup): { verdict: LinkVerdict; reexport: boolean; compiler: string } {
  const here = lookup(link.src, link.line, link.name);
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

/** Builds the graph of the repo at `commit` (HEAD by default) the way tmb does, in a scratch folder, and checks every link. */
export async function checkLinks(repoDir: string, commit = "HEAD"): Promise<LinkReport> {
  const sha = resolveCommit(repoDir, commit);
  if (sha === null) throw new Error(`${repoDir} has no commit ${commit}`);
  const scratch = mkdtempSync(path.join(tmpdir(), "tmb-links-"));
  try {
    let t = performance.now();
    const db = openGraphDb(scratch);
    let links: GraphLink[];
    try {
      await buildLayer(db, repoDir, sha, BASE_LAYER, { force: true });
      links = graphLinks(db);
    } finally {
      db.close();
    }
    const graphMs = performance.now() - t;
    t = performance.now();
    const lookup = compilerLookup(repoDir, sha);
    const report: LinkReport = {
      links: links.length,
      right: 0,
      wrong: [],
      notJudged: { unknown: 0, noReference: 0 },
      reexports: { right: 0, wrong: 0 },
      ms: { graph: Math.round(graphMs), compiler: 0 },
    };
    for (const link of links) {
      const { verdict, reexport, compiler } = judge(link, lookup);
      if (verdict === "right") report.right++;
      else if (verdict === "wrong") report.wrong.push(`${link.src}:${link.line} ${link.kind} \`${link.name}\` -> ${link.dst}:${link.start}-${link.end}; the compiler: ${compiler}`);
      else if (verdict === "unknown") report.notJudged.unknown++;
      else report.notJudged.noReference++;
      if (reexport && verdict === "right") report.reexports.right++;
      if (reexport && verdict === "wrong") report.reexports.wrong++;
    }
    report.ms.compiler = Math.round(performance.now() - t);
    return report;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
