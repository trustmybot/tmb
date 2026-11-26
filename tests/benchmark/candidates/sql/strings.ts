// Research harness for trustmybot/tmb#339, not product code: the SQL a repo holds, as units a
// parser is given. A `.sql` file is one unit. In code, every string literal is a unit, with each
// part the language fills in at run time (an interpolation, a `+` operand that is not a string,
// a Python `.format` or `%` field) replaced by a hole, an identifier no SQL names, so a parser
// still reads the rest and a table written as a hole is known to have no name in the code.
import type { Node } from "web-tree-sitter";
import { loadParsers } from "../../../../src/engine/graph/loader.ts";

/** The identifier each hole becomes; the number tells holes apart. */
export const HOLE = "tmb_hole_";
export const isHole = (name: string): boolean => name.toLowerCase().startsWith(HOLE);

export type Unit = {
  repo: string;
  path: string;
  line: number;
  /** "file" for a .sql file; else the language the string is in. */
  from: "file" | "typescript" | "python" | "bash";
  /** The text with holes, as a parser is given it. */
  sql: string;
  /** The literal as written, for the hand check. */
  raw: string;
  holes: number;
  /** The text starts with an SQL statement's first word (case-insensitive), after spaces, comments and brackets. */
  startsLikeSql: boolean;
};

/** The words an SQL statement can start with, in the SQL standard and the common dialects' own statements. */
const STATEMENT_START =
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()*(SELECT|INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|WITH|CREATE|ALTER|DROP|TRUNCATE|PRAGMA|VALUES|EXPLAIN|ATTACH|DETACH|VACUUM|ANALYZE|REINDEX)\b\s+\S/i;
export const startsLikeSql = (text: string): boolean => STATEMENT_START.test(text);

/** Python's escape sequences in a non-raw literal (the language reference, "String and Bytes literals"). */
function unescapePython(s: string): string {
  return s.replace(/\\(\n|\\|'|"|n|t|r)/g, (_, c: string) => ({ "\n": "", "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t", r: "\r" })[c] ?? c);
}
/** JavaScript's escape sequences in a string or template (ECMA-262, "String Literals"). */
function unescapeJs(s: string): string {
  return s.replace(/\\(\n|\\|'|"|`|n|t|r|\$)/g, (_, c: string) => ({ "\n": "", "\\": "\\", "'": "'", '"': '"', "`": "`", n: "\n", t: "\t", r: "\r", $: "$" })[c] ?? c);
}

type Piece = { text: string; holes: number };

class Holes {
  n = 0;
  next(): string {
    return `${HOLE}${this.n++}`;
  }
}

/** A Python string node's text, its interpolations and format fields as holes. */
function pythonString(node: Node, holes: Holes, formatted: boolean): string {
  const start = node.namedChildren.find((c) => c?.type === "string_start")?.text ?? '"';
  const prefix = start.replace(/['"]+$/, "").toLowerCase();
  const raw = prefix.includes("r");
  let out = "";
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "string_content") out += raw ? c.text : unescapePython(c.text);
    else if (c.type === "escape_sequence") out += unescapePython(c.text);
    else if (c.type === "interpolation") out += holes.next();
  }
  // A `.format` receiver's `{…}` fields and a `%` left side's `%s`/`%(name)s` fields are filled at run
  // time (the language reference, "Format String Syntax" and "printf-style String Formatting").
  if (formatted) out = out.replace(/\{[^{}]*\}/g, () => holes.next());
  return out;
}

function isFormatReceiver(node: Node): boolean {
  const p = node.parent;
  return p?.type === "attribute" && p.childForFieldName("object")?.id === node.id && p.childForFieldName("attribute")?.text === "format";
}

/** A `%` left operand's printf fields. */
function percentFields(text: string, holes: Holes): string {
  return text.replace(/%(?:\([^)]*\))?s/g, () => holes.next());
}

function fold(node: Node, lang: Unit["from"], holes: Holes): Piece | null {
  const t = node.type;
  if (lang === "python") {
    if (t === "string") return { text: pythonString(node, holes, isFormatReceiver(node)), holes: holes.n };
    if (t === "concatenated_string") {
      const fmt = isFormatReceiver(node);
      return { text: node.namedChildren.map((c) => (c && c.type === "string" ? pythonString(c, holes, fmt) : "")).join(""), holes: holes.n };
    }
  }
  if (lang === "typescript") {
    if (t === "string") return { text: unescapeJs(node.text.slice(1, -1)), holes: holes.n };
    if (t === "template_string") {
      let out = "";
      let at = node.startIndex + 1;
      for (const c of node.namedChildren) {
        if (c?.type !== "template_substitution") continue;
        out += unescapeJs(node.tree.rootNode.text.slice(at, c.startIndex)) + holes.next();
        at = c.endIndex;
      }
      out += unescapeJs(node.tree.rootNode.text.slice(at, node.endIndex - 1));
      return { text: out, holes: holes.n };
    }
  }
  if (lang === "bash" && (t === "string" || t === "raw_string" || t === "heredoc_body")) {
    if (t === "raw_string") return { text: node.text.slice(1, -1), holes: holes.n };
    let out = "";
    let at = node.startIndex + (t === "string" ? 1 : 0);
    const end = node.endIndex - (t === "string" ? 1 : 0);
    for (const c of node.namedChildren) {
      if (!c || !/expansion|command_substitution/.test(c.type)) continue;
      out += node.tree.rootNode.text.slice(at, c.startIndex) + holes.next();
      at = c.endIndex;
    }
    out += node.tree.rootNode.text.slice(at, end);
    return { text: out, holes: holes.n };
  }
  return null;
}

/** `a + b + …` where some operand is a string: the strings joined, every other operand a hole. */
function foldPlus(node: Node, lang: Unit["from"], holes: Holes): Piece | null {
  const op = node.childForFieldName("operator")?.text;
  if (op !== "+") return null;
  const parts: string[] = [];
  let strings = 0;
  const walk = (n: Node): void => {
    if ((n.type === "binary_expression" || n.type === "binary_operator") && n.childForFieldName("operator")?.text === "+") {
      walk(n.childForFieldName("left")!);
      walk(n.childForFieldName("right")!);
      return;
    }
    if (n.type === "parenthesized_expression" && n.namedChildCount === 1) return walk(n.namedChildren[0]!);
    const piece = fold(n, lang, holes);
    if (piece) {
      strings++;
      parts.push(piece.text);
    } else parts.push(holes.next());
  };
  walk(node);
  return strings > 0 ? { text: parts.join(""), holes: holes.n } : null;
}

/** Every string unit of one file in code. */
export async function stringUnits(repo: string, path: string, text: string, lang: Unit["from"]): Promise<Unit[]> {
  const grammar = lang === "typescript" ? (path.endsWith(".tsx") ? "tsx" : /\.(m|c)?jsx?$/.test(path) ? "javascript" : "typescript") : lang;
  const parser = (await loadParsers([grammar])).get(grammar);
  if (!parser) return [];
  const tree = parser.parse(text);
  if (!tree) return [];
  const out: Unit[] = [];
  const seen = new Set<number>();
  const visit = (node: Node): void => {
    if (seen.has(node.id)) return;
    let piece: Piece | null = null;
    const holes = new Holes();
    if (node.type === "binary_expression" || node.type === "binary_operator") {
      const op = node.childForFieldName("operator")?.text;
      if (op === "+") piece = foldPlus(node, lang, holes);
      else if (op === "%" && lang === "python") {
        const left = node.childForFieldName("left")!;
        const p = fold(left, lang, holes);
        if (p) piece = { text: percentFields(p.text, holes), holes: holes.n };
      }
    } else piece = fold(node, lang, holes);
    if (piece) {
      for (const d of node.descendantsOfType(["string", "template_string", "concatenated_string", "binary_expression", "binary_operator"])) if (d) seen.add(d.id);
      if (piece.text.trim()) {
        out.push({
          repo,
          path,
          line: node.startPosition.row + 1,
          from: lang,
          sql: piece.text,
          raw: node.text,
          holes: piece.holes,
          startsLikeSql: startsLikeSql(piece.text),
        });
      }
      return;
    }
    for (const c of node.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  tree.delete();
  return out;
}
