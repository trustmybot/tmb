// C's nodes and calls from tree-sitter-c, the same for every candidate.
//
// What a node is, in C (ISO/IEC 9899:2018):
// - Function: a function definition, 6.9.1: declaration specifiers, a declarator and a compound
//   statement. A declaration with no body (a prototype, 6.7.6.3) is not a function: it names one
//   defined elsewhere, and a call reaches the function through its definition. A function-like
//   macro (6.10.3) is not a function.
// - Type: a struct, union or enum specifier with a member list and a tag (6.7.2.1, 6.7.2.2), or one
//   with no tag that a typedef names (6.7.8), named by that typedef.
// - What a call is: a function call, 6.5.2.2, `postfix-expression ( argument-list )`. Its position
//   is where the name it calls is written: the identifier, or the member after `.` or `->`.
import type { Node } from "web-tree-sitter";
import { byteColumn, ownerOf, type GraphCall, type GraphNode, type Rules } from "./lib.ts";

const FUNCTION_TYPES = new Set(["function_definition"]);
const TYPE_SPECIFIERS = new Set(["struct_specifier", "union_specifier", "enum_specifier"]);

/** The name a declarator declares: through pointers, arrays, parentheses and the function declarator. */
export function declaratorName(d: Node | null): Node | null {
  while (d !== null) {
    if (d.type === "identifier" || d.type === "field_identifier" || d.type === "type_identifier") return d;
    const inner = d.childForFieldName("declarator");
    if (inner !== null) d = inner;
    else d = d.namedChildren.find((c): c is Node => c !== null && c.type.endsWith("declarator")) ?? null;
  }
  return null;
}

function walk(node: Node, visit: (n: Node) => void): void {
  const cursor = node.walk();
  let done = false;
  while (!done) {
    visit(cursor.currentNode);
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        done = true;
        break;
      }
    }
  }
  cursor.delete();
}

const line = (n: Node) => n.startPosition.row + 1;
const endLine = (n: Node) => n.endPosition.row + 1;

export function nodesC(root: Node, file: string): GraphNode[] {
  const out: GraphNode[] = [];
  walk(root, (n) => {
    if (n.type === "function_definition") {
      const name = declaratorName(n.childForFieldName("declarator"));
      if (name !== null) out.push({ file, name: name.text, kind: "function", start: line(n), end: endLine(n) });
    } else if (TYPE_SPECIFIERS.has(n.type) && n.childForFieldName("body") !== null) {
      const tag = n.childForFieldName("name");
      if (tag !== null) out.push({ file, name: tag.text, kind: "type", start: line(n), end: endLine(n) });
      else if (n.parent?.type === "type_definition") {
        for (const d of n.parent.childrenForFieldName("declarator")) {
          const name = declaratorName(d);
          if (name !== null) out.push({ file, name: name.text, kind: "type", start: line(n.parent), end: endLine(n.parent) });
        }
      }
    }
  });
  return out;
}

/** Where a callee expression writes the name it calls, if it is a name. */
export function calleeName(f: Node | null): Node | null {
  if (f === null) return null;
  if (f.type === "identifier" || f.type === "field_identifier") return f;
  if (f.type === "field_expression") return calleeName(f.childForFieldName("field"));
  return null;
}

export function callsC(root: Node, file: string, nodes: GraphNode[], text: string): GraphCall[] {
  const out: GraphCall[] = [];
  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const at = calleeName(n.childForFieldName("function")) ?? n;
    const name = at === n ? "" : at.text;
    out.push({ file, line: line(at), col: byteColumn(text, at), name, owner: ownerOf(n, nodes, FUNCTION_TYPES) });
  });
  return out;
}

export const C_RULES: Rules = { language: "c", endings: [".c", ".h"], grammarEnv: "TMB_GRAMMAR_C", nodes: nodesC, calls: callsC };
export { walk };
