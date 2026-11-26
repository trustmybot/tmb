// The nodes and the calls of a Rust file, from the tree-sitter grammar for Rust (tree-sitter-rust,
// whose .wasm the harness reads from TMB_RUST_GRAMMAR). One set of nodes for every candidate, as
// CODE_GRAPH.md requires ("The nodes are the same for both"): a candidate only answers what each
// call resolves to.
//
// What counts as each kind, by the Rust Reference (https://doc.rust-lang.org/reference/):
// - Function: a function item, `fn f() {}` (items/functions.html), outside any impl or trait,
//   nested in a body or a `mod` included; and a function declared in an `extern` block
//   (items/external-blocks.html), which has no body.
// - Method: an associated function (items/associated-items.html): a function item, or a trait's
//   function signature with no body, written in an `impl` or a `trait`. It is held by the type it
//   is for: an `impl Cart` or `impl Priced for Cart` gives `Cart.total`; a trait gives
//   `Priced.price`. With or without a `self` parameter, as the page's Method is.
// - Constructor: none. Rust has no constructor function to write; a tuple struct's or a tuple
//   variant's name is a constructor the compiler makes (items/structs.html,
//   items/enumerations.html), so it has no node of its own and a call of it is a construction
//   by the type's name.
// - Type: a struct, an enum, a union or a trait (items/structs.html, items/enumerations.html,
//   items/unions.html, items/traits.html). An `impl` block is no type; its functions belong to
//   the type it names.
// - Unnamed function: a closure expression, `|x| x * 2` (expressions/closure-expr.html).
// - Lines: a node starts at its first outer attribute, doc comments included, since a doc comment
//   is a `doc` attribute (attributes.html, comments.html#doc-comments), and ends at its last line.
//
// A call, by the Reference's expressions: a call expression `f(x)`, `a::f(x)`, `T::f(x)`
// (expressions/call-expr.html), and a method call `a.f(x)` (expressions/method-call-expr.html).
// Its position is where the name it calls is written, else where the call starts.
import { Language, Parser, type Node } from "web-tree-sitter";
import { readFileSync } from "node:fs";

export type Kind = "function" | "method" | "type" | "unnamed";
export type RustNode = {
  id: number;
  kind: Kind;
  /** The name as the page writes it, `Cart.total`; an unnamed function's is `closure@line`. */
  qualified: string;
  /** The bare name the place rule compares with the tool's declaration. */
  name: string;
  start: number;
  end: number;
  /** The line its name is on, for the compiler's own list. */
  nameLine: number;
  parent: number | null;
};
export type RustCall = {
  line: number;
  /** Byte column of the name on its line: the call's position. */
  col: number;
  name: string;
  /** Written as `a.f()`. */
  method: boolean;
  /** Found as a name followed by a parenthesised group in a macro's input, not parsed as a call. */
  inMacro: boolean;
  owner: number | null;
};
export type RustFile = { path: string; nodes: RustNode[]; calls: RustCall[]; hasError: boolean };

const TYPE_ITEMS = new Set(["struct_item", "enum_item", "union_item", "trait_item"]);
const FUNCTION_ITEMS = new Set(["function_item", "function_signature_item"]);
const OUTER_ATTRIBUTES = new Set(["attribute_item"]);

let parser: Parser | null = null;

export async function rustParser(): Promise<Parser> {
  if (parser) return parser;
  const grammar = process.env.TMB_RUST_GRAMMAR;
  if (!grammar) throw new Error("set TMB_RUST_GRAMMAR to tree-sitter-rust.wasm");
  await Parser.init();
  parser = new Parser();
  parser.setLanguage(await Language.load(new Uint8Array(readFileSync(grammar))));
  return parser;
}

/** A doc comment written before an item: `///` or a block doc comment, which the Reference makes a `doc` attribute. */
function isOuterDoc(n: Node): boolean {
  return (n.type === "line_comment" || n.type === "block_comment") && n.children.some((c) => c?.type === "outer_doc_comment_marker");
}

/** The first line of an item: its first outer attribute or doc comment directly before it. */
function firstLine(item: Node): number {
  let start = item.startPosition.row + 1;
  let prev = item.previousSibling;
  while (prev && (OUTER_ATTRIBUTES.has(prev.type) || isOuterDoc(prev))) {
    start = prev.startPosition.row + 1;
    prev = prev.previousSibling;
  }
  return start;
}

/** The type an impl block is for, by its last path segment: `impl<T> a::Cart<T>` gives `Cart`. */
function implTypeName(impl: Node): string {
  let t = impl.childForFieldName("type");
  while (t) {
    if (t.type === "generic_type") t = t.childForFieldName("type");
    else if (t.type === "scoped_type_identifier") t = t.childForFieldName("name");
    else if (t.type === "reference_type" || t.type === "pointer_type") t = t.childForFieldName("type");
    else break;
  }
  return t?.text ?? impl.childForFieldName("type")?.text ?? "";
}

/** Byte columns: tree-sitter in JavaScript counts UTF-16 units, rustc and SCIP count UTF-8 bytes. */
export function byteColumn(lineText: string, utf16: number): number {
  return Buffer.byteLength(lineText.slice(0, utf16));
}

/** Where a call's name is written, and that name. */
function callee(fn: Node): Node {
  let f: Node | null = fn;
  for (;;) {
    if (!f) return fn;
    if (f.type === "identifier" || f.type === "field_identifier") return f;
    if (f.type === "field_expression") f = f.childForFieldName("field");
    else if (f.type === "scoped_identifier") f = f.childForFieldName("name");
    else if (f.type === "generic_function") f = f.childForFieldName("function");
    else return fn;
  }
}

export async function parseRust(path: string, text: string): Promise<RustFile> {
  const p = await rustParser();
  const tree = p.parse(text)!;
  const lines = text.split("\n");
  const nodes: RustNode[] = [];
  const calls: RustCall[] = [];
  const col = (n: Node) => byteColumn(lines[n.startPosition.row] ?? "", n.startPosition.column);

  const add = (kind: Kind, qualified: string, name: string, item: Node, nameNode: Node | null, parent: number | null): number => {
    const id = nodes.length;
    nodes.push({
      id,
      kind,
      qualified,
      name,
      start: firstLine(item),
      end: item.endPosition.row + 1,
      nameLine: (nameNode ?? item).startPosition.row + 1,
      parent,
    });
    return id;
  };

  // A name followed by a parenthesised group in a macro's input: a call when the macro expands it
  // as an expression, which only the macro's expansion shows.
  const macroCalls = (tt: Node, owner: number | null) => {
    const kids = tt.children.filter((c): c is Node => c !== null);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (k.type === "token_tree") {
        macroCalls(k, owner);
        const prev = kids[i - 1];
        if (k.text.startsWith("(") && prev && prev.type === "identifier") {
          const before = kids[i - 2];
          calls.push({ line: prev.startPosition.row + 1, col: col(prev), name: prev.text, method: before?.text === ".", inMacro: true, owner });
        }
      }
    }
  };

  const visit = (n: Node, owner: number | null, container: { type: string } | null) => {
    let nextOwner = owner;
    let nextContainer = container;
    if (TYPE_ITEMS.has(n.type)) {
      const nameNode = n.childForFieldName("name");
      const name = nameNode?.text ?? "";
      nextOwner = add("type", name, name, n, nameNode, owner);
      nextContainer = n.type === "trait_item" ? { type: name } : null;
    } else if (n.type === "impl_item") {
      nextContainer = { type: implTypeName(n) };
    } else if (FUNCTION_ITEMS.has(n.type)) {
      const nameNode = n.childForFieldName("name");
      const name = nameNode?.text ?? "";
      const inType = container !== null && n.parent?.type === "declaration_list" && (n.parent.parent?.type === "impl_item" || n.parent.parent?.type === "trait_item");
      nextOwner = inType ? add("method", `${container!.type}.${name}`, name, n, nameNode, owner) : add("function", name, name, n, nameNode, owner);
      nextContainer = null;
    } else if (n.type === "closure_expression") {
      nextOwner = add("unnamed", `closure@${n.startPosition.row + 1}`, "", n, null, owner);
    } else if (n.type === "mod_item" || n.type === "foreign_mod_item") {
      nextContainer = null;
    } else if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn) {
        const at = callee(fn);
        calls.push({ line: at.startPosition.row + 1, col: col(at), name: at === fn && at.type !== "identifier" ? "" : at.text, method: fn.type === "field_expression", inMacro: false, owner });
      }
    } else if (n.type === "macro_invocation") {
      for (const c of n.children) if (c?.type === "token_tree") macroCalls(c, owner);
    }
    for (const c of n.children) if (c) visit(c, nextOwner, nextContainer);
  };
  visit(tree.rootNode, null, null);
  const hasError = tree.rootNode.hasError;
  tree.delete();
  return { path, nodes, calls, hasError };
}

if (import.meta.main) {
  const file = process.argv[2]!;
  const out = await parseRust(file, readFileSync(file, "utf8"));
  for (const n of out.nodes) console.log(`${n.kind} ${n.qualified} ${n.start}-${n.end} (name ${n.nameLine}) parent ${n.parent}`);
  for (const c of out.calls) console.log(`call ${c.line}:${c.col} ${c.name}${c.method ? " method" : ""}${c.inMacro ? " macro" : ""} owner ${c.owner}`);
}
