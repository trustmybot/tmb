// The coverage check of trustmybot/tmb#140: every function a second, independent parser finds
// must be one function of the code graph, matched by file and lines, and the graph must hold
// no other. The second parser is the TypeScript 5.9 compiler, a development dependency only.
import ts from "typescript5";
import { extractFile, languageOf, type SourceLanguage } from "../../src/engine/graph/extract.ts";
import type { Parsers } from "../../src/engine/graph/loader.ts";

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

/** The languages this check covers: TypeScript, TSX and JavaScript. */
export function coveredLanguage(relPath: string): SourceLanguage | null {
  const lang = languageOf(relPath, () => "");
  return lang === "typescript" || lang === "tsx" || lang === "javascript" ? lang : null;
}

/** Each function with a body the TypeScript compiler finds, as `start-end` lines. */
export function compilerFunctions(relPath: string, text: string): string[] {
  const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
  const file = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, SCRIPT_KIND[ext] ?? ts.ScriptKind.TS);
  const out: string[] = [];
  const line = (pos: number) => file.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      out.push(`${line(node.getStart(file))}-${line(node.getEnd())}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out.sort();
}

/** Each function the code graph's extractor finds, as `start-end` lines. */
export function graphFunctions(parsers: Parsers, relPath: string, text: string): string[] {
  const lang = coveredLanguage(relPath);
  if (lang === null) throw new Error(`${relPath} is not TypeScript or JavaScript`);
  return extractFile(parsers, relPath, lang, text)
    .symbols.filter((s) => s.kind === "function" || s.kind === "method")
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
