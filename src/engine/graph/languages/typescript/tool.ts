// Way B for TypeScript and JavaScript (trustmybot/tmb#311): the TypeScript compiler makes the links
// of the graph's calls. It asks the compiler; it does not imitate it. For each call the built-in
// parser found, the compiler's checker names the callee's declarations, and the call is:
// - linked, when they are exactly one node of the graph: a declaration of a value in the repo
//   that is a node by "Kinds of symbol", in the same file, of the same name, its lines
//   overlapping the node's;
// - outside, when every declaration is outside the repo: the compiler's lib, or an installed
//   package;
// - not known, otherwise: no answer, a declaration that is no node (a parameter, a local value, a
//   signature with no body), or more than one node.
// No answer is ever replaced by a guess.
//
// tmb carries the TypeScript compiler (CODE_GRAPH.md, "Two ways to make links"): way B needs no
// install, and tmb always uses the compiler it carries, never the repo's own, so one tmb gives one
// answer. The program holds the compiler's code and its default library (library.ts); a repo's own
// `typescript` package is never loaded. The repo's files are read from the commit; its installed
// packages, which git does not hold, from its `node_modules` folder when there is one, and without
// them a call of a package is not known.
import path from "node:path";
import type TS from "typescript5";
import type { LanguageTool, ToolAnswer, ToolCall, ToolInput, ToolNode } from "../contract.ts";
import { baseOptions, calleeOf, type CommitFiles, commitProgram, isCallNode, originalNames, projectOptions, type TypeScriptModule } from "./compiler.ts";
import { compilerLibrary } from "./library.ts" with { type: "macro" };

const NOT_KNOWN: ToolAnswer = { state: "not_known" };
const OUTSIDE: ToolAnswer = { state: "outside" };

/** The compiler tmb carries, with its default library, loaded on first use: way B alone needs it. */
type Carried = { ts: TypeScriptModule; library: ReadonlyMap<string, string> };
let carried: Carried | undefined;

/** The compiler tmb carries, or why it cannot be loaded. */
function carriedCompiler(): Carried | { unavailable: string } {
  if (carried !== undefined) return carried;
  try {
    // A plain require of the package by its name, so the build bundles it into the program; it is
    // the package library.ts reads the default library from.
    const ts = require("typescript5") as TypeScriptModule;
    carried = { ts, library: new Map(Object.entries(compilerLibrary())) };
    return carried;
  } catch (error) {
    return { unavailable: `the compiler tmb carries did not load (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** A function or a class written as a value. */
const isFunctionValue = (ts: TypeScriptModule, e: TS.Expression | undefined): boolean =>
  e !== undefined && (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e));

/** Whether a declaration sits inside a callable. */
function insideCallable(ts: TypeScriptModule, d: TS.Node): boolean {
  for (let n: TS.Node | undefined = d.parent; n !== undefined; n = n.parent) if (ts.isFunctionLike(n)) return true;
  return false;
}

/**
 * Whether a declaration of a called value is a node of the graph by "Kinds of symbol": a callable
 * with a body (a function written as a variable's, a field's or a property's value included), a
 * type that makes objects, or data declared outside every callable. A local is no node: a
 * parameter, or a variable inside a callable whose value is no function written there; nor is a
 * signature with no body.
 */
function isNodeDeclaration(ts: TypeScriptModule, d: TS.Declaration): boolean {
  if (ts.isFunctionLike(d)) return "body" in d && d.body !== undefined;
  if (ts.isClassLike(d)) return true;
  if (ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d)) return isFunctionValue(ts, d.initializer);
  if (ts.isVariableDeclaration(d)) return isFunctionValue(ts, d.initializer) || !insideCallable(ts, d);
  return false;
}

/** The name a declaration declares, when it is written as one. */
function declaredName(ts: TypeScriptModule, d: TS.Declaration): string | null {
  const name = ts.getNameOfDeclaration(d);
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

const lineOf = (sf: TS.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

/** A call's place in its file: its position (ToolCall) and the name it calls. */
const placeKey = (pos: number, name: string): string => `${pos}\u0000${name}`;

/** The compiler's answers for the graph's calls, one per call, in order. */
function answerCalls({ ts, library }: Carried, repoDir: string, input: ToolInput): ToolAnswer[] {
  const root = path.resolve(repoDir);
  // The program reads the source files and the settings files of the commit, the default library
  // tmb carries, and the installed packages of the working tree.
  const texts = new Map<string, string>([...input.configs, ...input.files]);
  const files: CommitFiles = { texts, installed: true, library };
  const options: TS.CompilerOptions = { ...baseOptions(ts), ...projectOptions(ts, root, files), noEmit: true, allowJs: true, skipLibCheck: true };
  const program = commitProgram(ts, root, input.files.keys(), files, options);
  const checker = program.getTypeChecker();
  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const inRepo = (sf: TS.SourceFile) => input.files.has(rel(sf.fileName));

  const nodesByFile = new Map<string, { index: number; node: ToolNode }[]>();
  input.nodes.forEach((node, index) => {
    const here = nodesByFile.get(node.path) ?? [];
    here.push({ index, node });
    nodesByFile.set(node.path, here);
  });

  /**
   * The node a declaration in the repo is: of its name, in its file, its lines overlapping the
   * declaration's. A function of the same name written inside it (`const f = () => function f() {}`)
   * overlaps it too: of several, the node is the one that starts where the declaration, its name or
   * its value starts, when only one does.
   */
  const nodesOf = (d: TS.Declaration): number[] => {
    const name = declaredName(ts, d);
    if (name === null || !isNodeDeclaration(ts, d)) return [];
    const sf = d.getSourceFile();
    const start = lineOf(sf, d.getStart(sf));
    const end = lineOf(sf, d.getEnd());
    const overlapping = (nodesByFile.get(rel(sf.fileName)) ?? []).filter(({ node }) => node.name === name && node.start <= end && node.end >= start);
    if (overlapping.length <= 1) return overlapping.map(({ index }) => index);
    const named = ts.getNameOfDeclaration(d);
    const value = "initializer" in d ? (d.initializer as TS.Expression | undefined) : undefined;
    const starts = new Set([start, ...[named, value].filter((n) => n !== undefined).map((n) => lineOf(sf, n.getStart(sf)))]);
    const starting = overlapping.filter(({ node }) => starts.has(node.start));
    return (starting.length === 1 ? starting : overlapping).map(({ index }) => index);
  };

  const answerOf = (callee: TS.Identifier | TS.PrivateIdentifier): ToolAnswer => {
    let sym = checker.getSymbolAtLocation(callee);
    if (sym === undefined) return NOT_KNOWN;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = checker.getAliasedSymbol(sym);
      } catch {
        return NOT_KNOWN;
      }
    }
    const decls = sym.declarations ?? [];
    if (decls.length === 0) return NOT_KNOWN;
    const own = decls.filter((d) => inRepo(d.getSourceFile()));
    if (own.length === 0) return OUTSIDE;
    const nodes = new Set(own.flatMap(nodesOf));
    return nodes.size === 1 ? { node: [...nodes][0]! } : NOT_KNOWN;
  };

  // Each file's calls, by their position, where the name each calls is written, and that name: the
  // callee's, or the name an import under a new name declares. A name is one token, so no two
  // calls share a position.
  const byFile = new Map<string, Map<string, ToolAnswer>>();
  const callsOf = (file: string): Map<string, ToolAnswer> => {
    const known = byFile.get(file);
    if (known !== undefined) return known;
    const out = new Map<string, ToolAnswer>();
    byFile.set(file, out);
    const sf = program.getSourceFile(path.join(root, file));
    if (sf === undefined) return out;
    const original = originalNames(ts, sf);
    const visit = (node: TS.Node): void => {
      if (isCallNode(ts, node)) {
        const callee = calleeOf(ts, node);
        if (callee !== null) {
          const answer = answerOf(callee);
          const pos = callee.getStart(sf);
          for (const name of new Set([callee.text, original.get(callee.text) ?? callee.text])) out.set(placeKey(pos, name), answer);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  };

  // A call is answered by the compiler's call at its position, of its name; a call the compiler
  // has none at is not known.
  return input.calls.map((call: ToolCall) => callsOf(call.path).get(placeKey(call.pos, call.name)) ?? NOT_KNOWN);
}

/** The TypeScript compiler, way B's tool for TypeScript, TSX and JavaScript. */
export const typescriptCompiler: LanguageTool = {
  name: "the TypeScript compiler",
  open(repoDir: string) {
    const compiler = carriedCompiler();
    if ("unavailable" in compiler) return compiler;
    return { answer: (input: ToolInput) => answerCalls(compiler, repoDir, input) };
  },
};
