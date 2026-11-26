// The nodes and calls of Go files, from the tree-sitter Go grammar (trustmybot/tmb#346). Every
// candidate of the A/B is scored on these same nodes and calls: a candidate only answers what each
// call names (CODE_GRAPH.md, "Two ways to make links").
//
// What is a node, by the Go spec (https://go.dev/ref/spec) and CODE_GRAPH.md's "Kinds of symbol":
// - Function: a FunctionDecl, `func F() {}` ("Function declarations"), init and main included.
// - Method: a MethodDecl, `func (r T) M() {}` ("Method declarations"), named through its receiver's
//   base type as `T.M`. Go declares a method outside its type's body, in any file of the package.
// - Unnamed function: a FunctionLit, `func() {}` ("Function literals").
// - Type: every TypeSpec, a definition or an alias ("Type declarations"). Any defined type can have
//   methods, a function type included (`type HandlerFunc func(*Context)`), so each is a named shape.
// - File-level data: each name a package-level VarSpec or ConstSpec declares ("Variable
//   declarations", "Constant declarations"); the blank identifier `_` declares nothing.
// - Constructor and accessor: Go has neither. `NewT()` is a plain function; a composite literal
//   `T{}` runs no code.
// - A method spec of an interface type (`Total() int` in `interface{ ... }`) is a callable declared
//   in a type with no body. TypeScript's module makes no node of a signature with no body, so by
//   default it is none here either; `withInterfaceMethods` makes it a method node, to measure what
//   that choice costs.
//
// What is a call: a CallExpr ("Calls"). A conversion `T(x)` has the same syntax ("Conversions"), so
// the parser cannot tell the two apart; a candidate whose answer for the callee is a type tells it
// is a conversion, and the call is then dropped.
import { Language, type Node, Parser } from "web-tree-sitter";

export type NodeKind = "function" | "method" | "unnamed" | "type" | "data" | "ifacemethod";

/** A node of the graph: lines are 1-based and inclusive. `name` is the name the code declares it by. */
export type GoNode = { file: string; kind: NodeKind; name: string; qualified: string; start: number; end: number };

/**
 * A call: `pos` is the UTF-16 offset in the file where the called name is written, else where the
 * call starts; `line` (1-based) and `char` (0-based UTF-16 column) are that same place. `owner` is
 * the line of the named node the call belongs to (a function, a method, or file-level data that
 * binds one name), 0 for the file; a call in an unnamed function belongs to the nearest named one.
 */
export type GoCall = { file: string; pos: number; line: number; char: number; name: string; owner: number };

export type FileParse = { nodes: GoNode[]; calls: GoCall[]; parsed: boolean };

let parser: Parser | null = null;

/** The parser, from the grammar wasm at `grammar` (tree-sitter-go's npm package ships one). */
export async function goParser(grammar: string): Promise<Parser> {
  if (parser) return parser;
  await Parser.init();
  const p = new Parser();
  p.setLanguage(await Language.load(new Uint8Array(await Bun.file(grammar).arrayBuffer())));
  parser = p;
  return p;
}

const line = (n: Node) => n.startPosition.row + 1;
const endLine = (n: Node) => n.endPosition.row + 1;

/** The base type name of a method's receiver: `T` in `(r *T)`, `(T)`, `(r T[K, V])`. */
function receiverType(decl: Node): string {
  const recv = decl.childForFieldName("receiver");
  const param = recv?.namedChildren.find((c) => c?.type === "parameter_declaration");
  let t = param?.childForFieldName("type") ?? null;
  while (t && t.type !== "type_identifier") {
    if (t.type === "pointer_type" || t.type === "parenthesized_type") t = t.namedChildren[t.namedChildren.length - 1] ?? null;
    else if (t.type === "generic_type") t = t.childForFieldName("type");
    else return "?";
  }
  return t?.text ?? "?";
}

/** Where a call's name is written: the name of `f(...)`, `x.f(...)`, `(f)(...)`, `f[T](...)`, else the call's start. */
function calledName(call: Node): Node | null {
  let fn = call.childForFieldName("function");
  for (;;) {
    if (!fn) return null;
    if (fn.type === "parenthesized_expression") fn = fn.namedChildren[0] ?? null;
    else if (fn.type === "index_expression") fn = fn.childForFieldName("operand");
    else if (fn.type === "generic_type") fn = fn.childForFieldName("type");
    else break;
  }
  if (fn.type === "identifier" || fn.type === "type_identifier") return fn;
  if (fn.type === "selector_expression") return fn.childForFieldName("field");
  if (fn.type === "qualified_type") return fn.childForFieldName("name");
  return null;
}

/** The name of a call the grammar reads as a conversion to a generic type: `f` in `f[T](x)`, `h` in `c.h[i](x)`. */
function genericName(conv: Node): Node | null {
  const t = conv.childForFieldName("type")?.childForFieldName("type") ?? null;
  if (t?.type === "type_identifier") return t;
  if (t?.type === "qualified_type") return t.childForFieldName("name");
  return null;
}

/** Offsets of each line's start, in UTF-16 units, for the column of an offset. */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

export function parseFile(p: Parser, file: string, text: string, opts: { interfaceMethods: boolean }): FileParse {
  const tree = p.parse(text);
  if (!tree) return { nodes: [], calls: [], parsed: false };
  const starts = lineStarts(text);
  const nodes: GoNode[] = [];
  const calls: GoCall[] = [];
  const add = (kind: NodeKind, name: string, qualified: string, n: Node) => nodes.push({ file, kind, name, qualified, start: line(n), end: endLine(n) });

  const visit = (n: Node, owner: number, top: boolean): void => {
    let here = owner;
    switch (n.type) {
      case "function_declaration": {
        const name = n.childForFieldName("name")?.text ?? "?";
        add("function", name, name, n);
        here = line(n);
        break;
      }
      case "method_declaration": {
        const name = n.childForFieldName("name")?.text ?? "?";
        add("method", name, `${receiverType(n)}.${name}`, n);
        here = line(n);
        break;
      }
      case "func_literal":
        add("unnamed", "", "", n);
        break;
      case "type_spec":
      case "type_alias": {
        const name = n.childForFieldName("name")?.text ?? "?";
        add("type", name, name, n);
        break;
      }
      case "method_elem": {
        if (opts.interfaceMethods) {
          const name = n.childForFieldName("name")?.text ?? "?";
          add("ifacemethod", name, name, n);
        }
        break;
      }
      case "var_spec":
      case "const_spec": {
        if (top) {
          const names = n.childrenForFieldName("name").filter((c): c is Node => c !== null && c.text !== "_");
          for (const c of names) add("data", c.text, c.text, n);
          // A call in the value of a spec that binds one name belongs to that name, else to the file.
          here = names.length === 1 && n.childrenForFieldName("name").length === 1 ? line(n) : 0;
        }
        break;
      }
      case "type_conversion_expression":
      case "call_expression": {
        // `f[int](x)` and `a[i](x)` parse as a conversion to a generic type: the grammar cannot
        // tell a call of an instantiated function or of an indexed element from a conversion
        // without types. Each is a call candidate; a candidate's answer that the callee is a type
        // makes it a conversion. Any other conversion syntax (`[]byte(s)`) is no call.
        if (n.type === "type_conversion_expression" && n.childForFieldName("type")?.type !== "generic_type") break;
        const at = n.type === "call_expression" ? calledName(n) : genericName(n);
        const pos = at ? at.startIndex : n.startIndex;
        const row = (at ?? n).startPosition.row;
        calls.push({ file, pos, line: row + 1, char: pos - (starts[row] ?? 0), name: at?.text ?? "", owner });
        break;
      }
    }
    // Package-level specs sit under a var or const declaration, possibly in a spec list.
    const childTop = top && (n.type === "source_file" || n.type === "var_declaration" || n.type === "const_declaration" || n.type === "var_spec_list" || n.type === "const_spec_list");
    for (const c of n.children) if (c) visit(c, here, childTop);
  };
  visit(tree.rootNode, 0, true);
  const parsed = !tree.rootNode.hasError;
  tree.delete();
  return { nodes, calls, parsed };
}

/** The callable nodes, as `start-end` lines, which functions found compares with the compiler's list. */
export const CALLABLE: readonly NodeKind[] = ["function", "method", "unnamed"];
