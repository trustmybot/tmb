// The benchmark's measure of a TypeScript and JavaScript repo (trustmybot/tmb#244): each way's graph
// against the TypeScript compiler, which is the reference for functions and for links. The checks
// are the graph's own: coverage.ts lists the compiler's functions, links.ts judges each link and
// each call state; this file only counts.
import type { Database } from "bun:sqlite";
import ts from "typescript5";
import type { BuildOptions } from "../../src/engine/graph/build.ts";
import { BASE_LAYER } from "../../src/engine/graph/db.ts";
import type { SourceLanguage } from "../../src/engine/graph/extract.ts";
import { compilerFunctions, coveredLanguage } from "../../src/engine/graph/languages/typescript/coverage.ts";
import { checkLayer, type CompilerCall, compilerProgram, commitTexts } from "../../src/engine/graph/languages/typescript/links.ts";
import { graphFunctionLines, languageTexts, parsedFiles, withGraph } from "./graph.ts";
import { callsAccountedFor, functionsFound, type GraphCall, linksFoundByReference, linksFoundByState, type ReferenceCall, type Way, type WayScores } from "./score.ts";

const LANGUAGES: ReadonlySet<SourceLanguage> = new Set(["typescript", "tsx", "javascript"]);

export const REFERENCE = `TypeScript compiler ${ts.version}`;

/**
 * How each way builds the graph. Way B's tool is the 5.9 development dependency, passed in: tmb
 * installs nothing, and the benchmark measures the tool, not a repo's own install of it.
 */
const BUILD: Record<Way, BuildOptions> = {
  A: { links: "built-in" },
  B: { links: "language-tool", tools: new Map([["typescript", ts]]) },
};

/**
 * Way B's links are made by the very tool that judges them: links right is shown, and it is no
 * proof of way B.
 */
export const SAME_TOOL = "same tool as the reference";

/**
 * The kind of code a call is, by its syntax, for the misses by cause: how its callee is written,
 * and for a name, how that name is declared. Each kind is a class of the language's syntax; none
 * names a repo or a symbol.
 */
export const CAUSES = {
  direct: "a function's name called directly",
  destructured: "a name bound by destructuring (`const { f } = …`), called",
  data: "a name of data whose value is no function written there, called",
  construct: "a construction by a class's name",
  self: "a method on the object itself (`this`)",
  parent: "a call on the parent (`super`)",
  moduleOrClass: "a method on a module's or class's name",
  written: "a method on a name whose type is written",
  made: "a method on a name made by `new`, its type not written",
  notWritten: "a method on a name whose type is not written",
  otherName: "a method on a name of another kind (a function, an enum member)",
  chain: "a method on an expression (a chain, a call's result, an index)",
  tag: "a tagged template",
} as const;

/** The symbol a name means, through an import to what it imports. */
function symbolOf(name: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const sym = checker.getSymbolAtLocation(name);
  if (sym === undefined || (sym.flags & ts.SymbolFlags.Alias) === 0) return sym;
  try {
    return checker.getAliasedSymbol(sym);
  } catch {
    return undefined;
  }
}

/** Declarations that bind a name to a value and may write its type. */
type Typed = ts.ParameterDeclaration | ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertySignature;
const isTyped = (d: ts.Node): d is Typed => ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d);

/** A function or a class written as a value, which is a node of the graph whatever binds it. */
const isFunctionValue = (e: ts.Expression | undefined): boolean => e !== undefined && (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e));

/** Whether a declaration sits inside a callable. */
function insideCallable(d: ts.Node): boolean {
  for (let n: ts.Node | undefined = d.parent; n !== undefined; n = n.parent) if (ts.isFunctionLike(n)) return true;
  return false;
}

/** How a name a method is called on is declared. */
function receiverCause(name: ts.Identifier, checker: ts.TypeChecker): string {
  const sym = symbolOf(name, checker);
  if (sym === undefined) return CAUSES.notWritten;
  if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) return CAUSES.moduleOrClass;
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (decl === undefined || ts.isBindingElement(decl) || ts.isShorthandPropertyAssignment(decl)) return CAUSES.notWritten;
  if (!isTyped(decl)) return CAUSES.otherName;
  if (decl.type !== undefined) return CAUSES.written;
  const value = ts.isPropertySignature(decl) ? undefined : decl.initializer;
  return value !== undefined && ts.isNewExpression(value) ? CAUSES.made : CAUSES.notWritten;
}

/** How a name called directly is declared. */
function nameCause(name: ts.Identifier, checker: ts.TypeChecker): string {
  const decl = symbolOf(name, checker)?.declarations?.[0];
  if (decl !== undefined && ts.isBindingElement(decl)) return CAUSES.destructured;
  if (decl !== undefined && ts.isVariableDeclaration(decl) && !isFunctionValue(decl.initializer)) return CAUSES.data;
  return CAUSES.direct;
}

/** The kind of code one call is, by its syntax. Only calls whose callee is a name reach here ({@link declaresANode}). */
export function causeOf(call: CompilerCall, checker: ts.TypeChecker): string {
  const { node } = call;
  if (ts.isTaggedTemplateExpression(node)) return CAUSES.tag;
  let callee: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee)) return ts.isNewExpression(node) ? CAUSES.construct : nameCause(callee, checker);
  if (!ts.isPropertyAccessExpression(callee)) return CAUSES.chain;
  const receiver = callee.expression;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return CAUSES.self;
  if (receiver.kind === ts.SyntaxKind.SuperKeyword) return CAUSES.parent;
  if (ts.isIdentifier(receiver)) return receiverCause(receiver, checker);
  return CAUSES.chain;
}

/**
 * Whether the compiler declares a call's callee as a node of the graph, by "Kinds of symbol" in
 * CODE_GRAPH.md, so a link could reach it: a callable with a body (a function written as a
 * variable's, a field's or a property's value included), a type, or data declared outside every
 * callable. A local is no node: a parameter, or a variable inside a callable whose value is no
 * function written there. Nor is a signature with no body, a field (Planned), or a property of an
 * object written by a name alone (`{ f }`).
 */
export function declaresANode(call: CompilerCall, checker: ts.TypeChecker): boolean {
  if (call.callee === null) return false;
  return (symbolOf(call.callee, checker)?.declarations ?? []).some((d) => {
    if (ts.isFunctionLike(d)) return "body" in d && d.body !== undefined;
    if (ts.isClassLike(d)) return true;
    if (ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d)) return isFunctionValue(d.initializer);
    if (ts.isVariableDeclaration(d)) return isFunctionValue(d.initializer) || !insideCallable(d);
    if (ts.isBindingElement(d)) return !insideCallable(d);
    return false;
  });
}

/** Every call the graph links, in the given files, with the declaration it links. */
function graphCalls(db: Database, files: ReadonlySet<string>): GraphCall[] {
  const rows = db
    .query(
      `SELECT s.path AS file, e.line AS line, e.pos AS pos, e.dst_name AS name, d.path AS dst, d.start_line AS start, d.end_line AS end
         FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state = 'linked'`,
    )
    .all(BASE_LAYER) as { file: string; line: number; pos: number; name: string; dst: string; start: number | null; end: number | null }[];
  return rows.filter((r) => files.has(r.file)).map((r) => ({ ...r, start: r.start ?? 0, end: r.end ?? r.start ?? 0 }));
}

/** How many missed calls of each cause the output shows, so a reader can see the kind of code. */
const EXAMPLES_PER_CAUSE = 3;

/** A few missed calls of each cause, `file:line name`. */
function examples(missed: readonly ReferenceCall[]): string[] {
  const shown = new Map<string, string[]>();
  for (const m of missed) {
    const here = shown.get(m.cause) ?? [];
    if (here.length < EXAMPLES_PER_CAUSE) here.push(`${m.file}:${m.line} \`${m.names[0] ?? ""}\``);
    shown.set(m.cause, here);
  }
  return [...shown].map(([cause, list]) => `missed, ${cause}: ${list.join(", ")}`);
}

export type Measured = { scores: WayScores; ms: { graph: number; reference: number }; detail: string[] };

/** Measures one way on the repo at `sha`. */
export async function measureTypescript(repoDir: string, sha: string, way: Way): Promise<Measured> {
  return withGraph(repoDir, sha, BUILD[way], (db, graphMs) => {
    const t = performance.now();
    const scope = languageTexts(repoDir, sha, LANGUAGES);
    const reference = new Map([...scope].map(([file, text]) => [file, compilerFunctions(file, text)]));
    const functions = functionsFound(reference, graphFunctionLines(db, scope.keys()));

    const texts = commitTexts(repoDir, sha);
    const program = compilerProgram(repoDir, sha, texts);
    const { links, calls } = checkLayer(db, program, texts);

    // The reference's links: every call in a file the graph read that the compiler declares in the repo.
    const read = new Set([...parsedFiles(db)].filter((f) => scope.has(f) && coveredLanguage(f) !== null));
    const refCalls: ReferenceCall[] = [];
    for (const file of read) {
      for (const call of program.calls(file)) {
        if (call.answer.kind !== "declared" || !declaresANode(call, program.checker)) continue;
        refCalls.push({ file, line: call.line, pos: call.pos, names: call.names, decls: call.answer.decls, cause: causeOf(call, program.checker) });
      }
    }
    const byReference = linksFoundByReference(refCalls, graphCalls(db, read));
    const referenceMs = Math.round(performance.now() - t);

    const scores: WayScores = {
      functionsFound: functions,
      linksRight: { n: links.right, of: links.right + links.wrong.length, ...(way === "B" ? { note: SAME_TOOL } : {}) },
      linksFoundByState: linksFoundByState(calls),
      linksFoundByReference: { n: byReference.n, of: byReference.of },
      callsAccountedFor: callsAccountedFor(calls.byFunction.compiler, calls.byFunction.graph, calls.outsideWrong.length),
      missesByCause: byReference.misses,
    };
    const detail = [
      `links right: ${links.links} cross-file links, ${links.right} right, ${links.wrong.length} wrong, not judged ${JSON.stringify(links.notJudged)}`,
      `calls: ${calls.accounted} of ${calls.compiler} with a state, ${calls.linked} linked, ${calls.outside} outside, ${calls.notKnown} not known; ${calls.differ.length} functions counted otherwise, ${calls.outsideWrong.length} outside calls the compiler declares in the repo`,
      ...links.wrong.map((w) => `wrong link: ${w}`),
      ...examples(byReference.missed),
    ];
    return { scores, ms: { graph: graphMs, reference: referenceMs }, detail };
  });
}
