// The coverage check of trustmybot/tmb#140: every function a second, independent parser finds
// must be one function of the code graph, matched by file and lines, and the graph must hold
// no other. The second parser is the TypeScript 5.9 compiler tmb carries for way B, a dependency
// of tmb. The check runs in the tests and the benchmark, never in tmb's commands.
import ts from "typescript5";
import { extractFile, languageOf, type SourceLanguage } from "../../extract.ts";
import type { Parsers } from "../../loader.ts";
import { bodilessMethods } from "./compiler.ts";

const SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JSX,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
};

/** How the compiler reads a file, by its extension. */
export function scriptKind(relPath: string): ts.ScriptKind {
  return SCRIPT_KIND[relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase()] ?? ts.ScriptKind.TS;
}

/** The languages this check covers: TypeScript, TSX and JavaScript. */
export function coveredLanguage(relPath: string): SourceLanguage | null {
  const lang = languageOf(relPath, () => "");
  return lang === "typescript" || lang === "tsx" || lang === "javascript" ? lang : null;
}

/**
 * Each function the TypeScript compiler finds, as `start-end` lines: each with a body, and each
 * method that has only a declaration, an overload set of them once, from its first signature to
 * its last (compiler.ts, bodilessMethods).
 */
export function compilerFunctions(relPath: string, text: string): string[] {
  const file = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKind(relPath));
  const out: string[] = [];
  const line = (pos: number) => file.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      out.push(`${line(node.getStart(file))}-${line(node.getEnd())}`);
    }
    for (const set of bodilessMethods(ts, node)) out.push(`${line(set[0]!.getStart(file))}-${line(set[set.length - 1]!.getEnd())}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out.sort();
}

/**
 * Each TypeScript or JavaScript function the code graph's extractor finds, as `start-end` lines. A
 * function no call names, such as an SQL trigger in a string, is code its store runs, not a function
 * of the file's own language, so the compiler does not list it.
 */
export function graphFunctions(parsers: Parsers, relPath: string, text: string): string[] {
  const lang = coveredLanguage(relPath);
  if (lang === null) throw new Error(`${relPath} is not TypeScript or JavaScript`);
  return extractFile(parsers, relPath, lang, text)
    .symbols.filter((s) => (s.kind === "function" || s.kind === "method") && s.reach !== "none")
    .map((s) => `${s.start_line}-${s.end_line}`)
    .sort();
}

/** What one list holds more often than the other, each entry once per extra occurrence. */
export function surplus(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}
