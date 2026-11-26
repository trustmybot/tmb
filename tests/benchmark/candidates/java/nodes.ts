// The nodes and calls every Java candidate is scored on (trustmybot/tmb#346), made once from the
// tree-sitter-java grammar, as way B's nodes come from the built-in parser (CODE_GRAPH.md, "Two
// ways to make links"). A candidate never adds or removes a node.
//
// What is a node, by the Java Language Specification (Java SE 21):
// - Type: a class (JLS 8.1), an enum (8.9), a record (8.10), an interface (9.1) and an annotation
//   interface (9.6). An anonymous class body (15.9.5) has no name and is not a node.
// - Method: a method declaration (8.4, 9.4) and an annotation interface element (9.6.1), which the
//   JLS calls a method. Java has no callable outside a type, so there is no Function.
// - Constructor: a constructor declaration (8.8) and a record's compact canonical constructor
//   (8.10.4). A default constructor (8.8.9) is not written, so it is not a node.
// - Unnamed function: a lambda expression (15.27). A method reference (15.13) names a method and is
//   not a function.
// - Not callables: an instance or static initializer (8.6, 8.7) and an enum constant's arguments;
//   a call in them, or in a field's initial value, belongs to the type.
//
// What is a call (CODE_GRAPH.md, "The three states of a call"): a method invocation (JLS 15.12), a
// class instance creation with `new` (15.9), and an explicit constructor invocation `this(...)` or
// `super(...)` (8.8.7.1). Its position is where the called name is written: the method's name, the
// simple name of the created class, or the keyword `this` or `super`. Positions are UTF-16 offsets,
// as Java's tools and JavaScript strings count them.
import { Language, Parser, type Node } from "web-tree-sitter";

export type Kind = "type" | "method" | "constructor" | "lambda";
export type JNode = { file: string; name: string; kind: Kind; start: number; end: number; from: number; to: number };
export type JCall = { file: string; pos: number; line: number; name: string; form: "method" | "new" | "this-super"; owner: string };

const TYPES = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
const METHODS = new Set(["method_declaration", "annotation_type_element_declaration"]);
const CONSTRUCTORS = new Set(["constructor_declaration", "compact_constructor_declaration"]);

let parser: Parser | null = null;

/** The tree-sitter-java parser, from the grammar file the caller names. */
export async function javaParser(grammar: string): Promise<Parser> {
  if (parser) return parser;
  await Parser.init();
  const p = new Parser();
  p.setLanguage(await Language.load(new Uint8Array(await Bun.file(grammar).arrayBuffer())));
  parser = p;
  return p;
}

/** A node's key: what owns a call and what the benchmark counts calls under. */
export const keyOf = (n: { file: string; name: string; start: number }) => `${n.file}:${n.start}:${n.name}`;

/** The simple name written in a created class's type: `a.B<T>` gives `B`. */
function typeName(t: Node): Node | null {
  if (t.type === "type_identifier") return t;
  if (t.type === "generic_type") return typeName(t.namedChildren.find((c) => c !== null && c.type !== "type_arguments") as Node);
  if (t.type === "scoped_type_identifier") {
    const last = t.namedChildren.filter((c) => c !== null && (c.type === "type_identifier" || c.type === "generic_type" || c.type === "scoped_type_identifier")).at(-1);
    return last ? typeName(last) : null;
  }
  return null;
}

/** Every node and call of one file. A file that does not parse cleanly is still read, and says so. */
export function readFile(p: Parser, file: string, text: string): { nodes: JNode[]; calls: JCall[]; errors: boolean } {
  const tree = p.parse(text);
  if (!tree) throw new Error(`no tree for ${file}`);
  const nodes: JNode[] = [];
  const calls: JCall[] = [];
  const fileKey = `${file}:0:`;
  const walk = (n: Node, owner: string) => {
    let next = owner;
    const line = n.startPosition.row + 1;
    const span = { file, start: line, end: n.endPosition.row + 1, from: n.startIndex, to: n.endIndex };
    if (TYPES.has(n.type) || METHODS.has(n.type) || CONSTRUCTORS.has(n.type)) {
      const name = n.childForFieldName("name")?.text ?? "";
      const kind: Kind = TYPES.has(n.type) ? "type" : METHODS.has(n.type) ? "method" : "constructor";
      const node = { ...span, name, kind };
      nodes.push(node);
      // A call in a type's body outside any callable (a field's value, an initializer) belongs to the type.
      next = keyOf(node);
    } else if (n.type === "lambda_expression") {
      // Unnamed: a call in it is answered under the nearest named owner, so the owner does not change.
      nodes.push({ ...span, name: "", kind: "lambda" });
    } else if (n.type === "method_invocation") {
      const id = n.childForFieldName("name");
      if (id) calls.push({ file, pos: id.startIndex, line: id.startPosition.row + 1, name: id.text, form: "method", owner });
    } else if (n.type === "object_creation_expression") {
      const t = n.childForFieldName("type");
      const id = t ? typeName(t) : null;
      if (id) calls.push({ file, pos: id.startIndex, line: id.startPosition.row + 1, name: id.text, form: "new", owner });
    } else if (n.type === "explicit_constructor_invocation") {
      const kw = n.childForFieldName("constructor");
      if (kw) calls.push({ file, pos: kw.startIndex, line: kw.startPosition.row + 1, name: kw.text, form: "this-super", owner });
    }
    for (const c of n.children) if (c) walk(c, next);
  };
  walk(tree.rootNode, fileKey);
  const errors = tree.rootNode.hasError;
  tree.delete();
  return { nodes, calls, errors };
}

/** The owner of a position: the innermost named node around it that is not a lambda, else the file. */
export function ownerAt(nodes: readonly JNode[], file: string, pos: number): string {
  let best: JNode | null = null;
  for (const n of nodes) {
    if (n.file !== file || n.kind === "lambda" || n.from > pos || n.to <= pos) continue;
    if (!best || n.to - n.from < best.to - best.from) best = n;
  }
  return best ? keyOf(best) : `${file}:0:`;
}
