// C++'s nodes and calls from tree-sitter-cpp, the same for every candidate.
//
// What a node is, in C++ (ISO/IEC 14882:2020):
// - Function or method: a function definition, [dcl.fct.def.general]: a body, `= default` or
//   `= delete`. That includes a member function defined in its class ([class.mfct]) or outside it by
//   a qualified name, a constructor ([class.ctor]), a destructor ([class.dtor]), a conversion function
//   ([class.conv.fct]) and an operator function ([over.oper]). A function template's definition
//   ([temp.pre]) starts at its `template` head. A member declared with no definition, such as a pure
//   virtual function ([class.abstract]), is a declaration and not a node, as a TypeScript signature
//   with no body is not one.
// - Unnamed function: a lambda expression, [expr.prim.lambda].
// - Type: a class, struct, union or enum with a member list ([class.pre], [dcl.enum]).
// - What a call is: a function call, [expr.call], and a new-expression, [expr.new], which calls a
//   constructor. A named cast (`static_cast<T>(x)` and the other three, [expr.cast]) and an explicit
//   type conversion in functional notation of a fundamental type (`int(x)`, [expr.type.conv]) are
//   written like calls but call nothing.
import type { Node } from "web-tree-sitter";
import { byteColumn, ownerOf, type GraphCall, type GraphNode, type Rules } from "../c/lib.ts";
import { walk } from "../c/rules_c.ts";

const FUNCTION_TYPES = new Set(["function_definition", "lambda_expression"]);
const TYPE_SPECIFIERS = new Set(["class_specifier", "struct_specifier", "union_specifier", "enum_specifier"]);
/** The named casts: keywords ([lex.key]), not names, though the grammar reads them as a call of a template. */
const NAMED_CASTS = new Set(["static_cast", "dynamic_cast", "reinterpret_cast", "const_cast"]);

const line = (n: Node) => n.startPosition.row + 1;
const endLine = (n: Node) => n.endPosition.row + 1;

/** The name a declarator or a name expression writes: the last part of a qualified name, a template's name. */
export function nameNode(d: Node | null): Node | null {
  while (d !== null) {
    switch (d.type) {
      case "identifier":
      case "field_identifier":
      case "type_identifier":
      case "destructor_name":
      case "operator_name":
      case "operator_cast":
        return d;
      case "qualified_identifier":
      case "template_function":
      case "template_method":
      case "template_type":
        d = d.childForFieldName("name");
        break;
      case "dependent_name":
        d = d.namedChild(0);
        break;
      default: {
        const inner = d.childForFieldName("declarator");
        d = inner ?? d.namedChildren.find((c): c is Node => c !== null && c.type.endsWith("declarator")) ?? null;
      }
    }
  }
  return null;
}

/** A name as the compiler spells it: `operator bool` for a conversion, other names as written. */
const spelled = (n: Node) => (n.type === "operator_cast" ? `operator ${n.childForFieldName("type")?.text ?? ""}` : n.text).replace(/\s+/g, " ");

/** Where a definition starts: its outermost `template` head, if it has one. */
function declarationStart(n: Node): number {
  let top = n;
  while (top.parent?.type === "template_declaration") top = top.parent;
  return line(top);
}

export function nodesCpp(root: Node, file: string): GraphNode[] {
  const out: GraphNode[] = [];
  walk(root, (n) => {
    if (n.type === "function_definition") {
      const decl = n.childForFieldName("declarator");
      const name = nameNode(decl);
      if (name === null) return;
      const inClass = n.parent?.type === "field_declaration_list" || n.parent?.parent?.type === "field_declaration_list";
      const qualified = decl?.descendantsOfType("qualified_identifier").length !== 0;
      out.push({ file, name: spelled(name), kind: inClass || qualified ? "method" : "function", start: declarationStart(n), end: endLine(n) });
    } else if (n.type === "lambda_expression") {
      out.push({ file, name: "", kind: "unnamed", start: line(n), end: endLine(n) });
    } else if (TYPE_SPECIFIERS.has(n.type) && n.childForFieldName("body") !== null) {
      const name = nameNode(n.childForFieldName("name"));
      if (name !== null) out.push({ file, name: name.text, kind: "type", start: declarationStart(n), end: endLine(n) });
    }
  });
  return out;
}

/** Where a callee expression writes the name it calls, if it is a name. */
export function calleeName(f: Node | null): Node | null {
  if (f === null) return null;
  if (f.type === "field_expression") return nameNode(f.childForFieldName("field"));
  if (f.type === "identifier" || f.type === "qualified_identifier" || f.type === "template_function") return nameNode(f);
  return null;
}

export function callsCpp(root: Node, file: string, nodes: GraphNode[], text: string): GraphCall[] {
  const out: GraphCall[] = [];
  walk(root, (n) => {
    let at: Node | null;
    if (n.type === "call_expression") {
      const f = n.childForFieldName("function");
      if (f?.type === "primitive_type") return;
      if (f?.type === "template_function" && NAMED_CASTS.has(f.childForFieldName("name")?.text ?? "")) return;
      at = calleeName(f);
    } else if (n.type === "new_expression") {
      at = nameNode(n.childForFieldName("type"));
    } else return;
    const where = at ?? n;
    out.push({ file, line: line(where), col: byteColumn(text, where), name: at === null ? "" : spelled(at), owner: ownerOf(n, nodes, FUNCTION_TYPES) });
  });
  return out;
}

export const CPP_RULES: Rules = { language: "cpp", endings: [".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh"], grammarEnv: "TMB_GRAMMAR_CPP", nodes: nodesCpp, calls: callsCpp };
