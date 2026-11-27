// Go, read through tree-sitter (trustmybot/tmb#352): its functions, methods, types and file-level
// names, the function literals in them, and the calls each makes. The kinds follow CODE_GRAPH.md's
// "Kinds of symbol", and each rule below names the part of the Go spec (https://go.dev/ref/spec)
// it reads.
import goWasm from 'tree-sitter-go/tree-sitter-go.wasm' with { type: 'file' };
import type { Node } from 'web-tree-sitter';
import { type Bound, type CallAt, type Collector, type ExtractedSymbol, type LanguageModule, SYMBOL_KINDS, type SymbolKind } from '../contract.ts';
import { clip, docOf, memberHint, named, normalizedHash, oneLine, signatureOf, syntaxTree } from '../kit.ts';
import { BUILTINS } from './builtins.ts';
import { goTypeChecker } from './tool.ts';

/** The longest a call's text is kept as its name when its callee is no name. */
const CALLEE_TEXT_MAX = 80;
/** How much of a declaration's text a signature without a body reads, and the longest a signature is kept. */
const SIGNATURE_TEXT = 140;
const SIGNATURE_MAX = 200;
/** The blank identifier, which declares nothing ("Blank identifier"). */
const BLANK = '_';

/** A name is exported when its first character is an upper-case letter ("Exported identifiers"). */
const exportedName = (name: string): number => (/^\p{Lu}/u.test(name) ? 1 : 0);

const startLine = (n: Node): number => n.startPosition.row + 1;
const endLine = (n: Node): number => n.endPosition.row + 1;

/** Whether a declaration writes its specs in parentheses, `var ( … )`: each spec then starts at its own name. */
const grouped = (decl: Node): boolean => decl.children.some((c) => c?.type === '(' || c?.type === 'var_spec_list');

/** The package-level declaration that holds a `var` or `const` spec, or null when the spec is inside a function. */
function topDeclaration(spec: Node): Node | null {
  let decl = spec.parent;
  if (decl?.type === 'var_spec_list') decl = decl.parent;
  return decl?.parent?.type === 'source_file' ? decl : null;
}

/** Where a spec's node starts: at its declaration's keyword for a lone spec, else at the spec. */
const specAnchor = (spec: Node, decl: Node): Node => (grouped(decl) ? spec : decl);

/** The base type a method's receiver names: `T` in `(r *T)`, `(T)` and `(r T[K])` ("Method declarations"). */
function receiverBase(method: Node): Node | null {
  const receiver = method.childForFieldName('receiver');
  const param = receiver ? named(receiver).find((c) => c.type === 'parameter_declaration') : undefined;
  let t = param?.childForFieldName('type') ?? null;
  while (t && t.type !== 'type_identifier') {
    if (t.type === 'pointer_type' || t.type === 'parenthesized_type') t = named(t).at(-1) ?? null;
    else if (t.type === 'generic_type') t = t.childForFieldName('type');
    else return null;
  }
  return t;
}

// The names a package-level declaration binds anywhere inside it, nested function literals included
// ("Declarations and scope"): a function's receiver, parameters and results, its type parameters
// and those its receiver names, and each name its body declares by `var`, `const`, `type`, `:=`,
// `range`, a type switch or a `select` case. Go looks a name up in these before the package's
// names, so a call of one is never a call of a package-level declaration. A name bound anywhere in
// the declaration counts for all of it: a call is never linked on a binding a block might give it.
function boundNames(top: Node): Set<string> {
  const names = new Set<string>();
  const add = (n: Node | null): void => {
    if (n && (n.type === 'identifier' || n.type === 'type_identifier') && n.text !== BLANK) names.add(n.text);
  };
  const receiver = top.type === 'method_declaration' ? top.childForFieldName('receiver') : null;
  for (const t of receiver?.descendantsOfType('type_arguments') ?? []) for (const id of t?.descendantsOfType('type_identifier') ?? []) add(id);
  const walk = (node: Node): void => {
    switch (node.type) {
      case 'parameter_declaration':
      case 'variadic_parameter_declaration':
      case 'type_parameter_declaration':
        for (const n of node.childrenForFieldName('name')) add(n);
        break;
      case 'var_spec':
      case 'const_spec':
        if (topDeclaration(node) === null) for (const n of node.childrenForFieldName('name')) add(n);
        break;
      case 'type_spec':
      case 'type_alias':
        if (node.parent?.parent?.type !== 'source_file') add(node.childForFieldName('name'));
        break;
      case 'short_var_declaration':
      case 'range_clause':
      case 'receive_statement':
      case 'type_switch_statement': {
        const list = node.childForFieldName(node.type === 'type_switch_statement' ? 'alias' : 'left');
        for (const n of list?.type === 'expression_list' ? named(list) : list ? [list] : []) add(n);
        break;
      }
    }
    for (const c of named(node)) walk(c);
  };
  walk(top);
  return names;
}

/** What a call's callee names, and where it is written: a name, a name on an operand, or nothing a lookup can follow. */
type Callee = { kind: 'bare'; name: Node; indexed: boolean } | { kind: 'member'; name: Node; on: Node } | { kind: 'none' };

/** The callee of a call, or the type of a conversion the grammar reads as one. */
const calleeNode = (call: Node): Node | null => (call.type === 'type_conversion_expression' ? call.childForFieldName('type') : call.childForFieldName('function'));

// What a call calls ("Calls", "Instantiations"): `f(…)`, `(f)(…)`, `x.f(…)`, and `f[T](…)`, an
// instance of a generic function, which the grammar cannot tell from a call of an element of `f`,
// `f[i](…)`, without types. A conversion is written as a call too ("Conversions"): `T(x)`, and
// `[]byte(s)`, whose type names nothing.
function callee(call: Node): Callee {
  let fn = calleeNode(call);
  let indexed = false;
  for (;;) {
    if (!fn) return { kind: 'none' };
    if (fn.type === 'parenthesized_expression') fn = named(fn)[0] ?? null;
    else if (fn.type === 'generic_type') {
      indexed = true;
      fn = fn.childForFieldName('type');
    } else if (fn.type === 'index_expression') {
      indexed = true;
      fn = fn.childForFieldName('operand');
    } else break;
  }
  if (fn.type === 'identifier' || fn.type === 'type_identifier') return { kind: 'bare', name: fn, indexed };
  const member = fn.type === 'selector_expression' ? ['field', 'operand'] : fn.type === 'qualified_type' ? ['name', 'package'] : null;
  const name = member ? fn.childForFieldName(member[0]!) : null;
  const on = member ? fn.childForFieldName(member[1]!) : null;
  return name && on ? { kind: 'member', name, on } : { kind: 'none' };
}

/** The name of a function literal no declaration names: the call it is passed to, else its line. */
function unnamedLabel(lit: Node): string {
  const args = lit.parent;
  const c = args?.type === 'argument_list' && args.parent ? callee(args.parent) : null;
  return c !== null && c.kind !== 'none' ? `callback of \`${c.name.text}\`` : `function at line ${startLine(lit)}`;
}

function extractGo(root: Node, src: string, out: Collector, moduleSymbol: number): void {
  // Each declaration is its own symbol, by its place: Go allows several `init` and `_` functions in a file.
  const symbolOf = (kind: SymbolKind, name: string, node: Node, anchor: Node, parent: number, signature: string): number =>
    out.symbol(
      {
        kind,
        qualified_name: name,
        signature,
        doc: docOf(anchor),
        start_line: startLine(anchor),
        end_line: endLine(node),
        body_hash: normalizedHash(node),
        exported: exportedName(name.slice(name.lastIndexOf('.') + 1)),
        parent,
      },
      `${kind}\u0000${anchor.startIndex}\u0000${name}`,
    );
  const textSignature = (from: Node, to: number): string => clip(oneLine(src.slice(from.startIndex, Math.min(to, from.startIndex + SIGNATURE_TEXT))), SIGNATURE_MAX);

  // The package-level types first, so a method finds its type wherever the file declares it ("Type
  // declarations"). An interface's method specs are methods declared in it, with no body.
  const types = new Map<string, number>();
  const topData = new Set<string>();
  for (const decl of named(root)) {
    if (decl.type === 'type_declaration') {
      for (const spec of named(decl)) {
        const name = spec.type === 'type_spec' || spec.type === 'type_alias' ? spec.childForFieldName('name')?.text : undefined;
        if (!name) continue;
        const shape = spec.childForFieldName('type');
        const anchor = specAnchor(spec, decl);
        const type = symbolOf(SYMBOL_KINDS.type, name, spec, anchor, moduleSymbol, textSignature(anchor, spec.endIndex));
        if (!types.has(name)) types.set(name, type);
        if (shape?.type !== 'interface_type') continue;
        for (const m of named(shape)) {
          const own = m.type === 'method_elem' ? m.childForFieldName('name')?.text : undefined;
          if (own) symbolOf('method', `${name}.${own}`, m, m, type, clip(oneLine(m.text), SIGNATURE_MAX));
        }
      }
    } else if (decl.type === 'var_declaration' || decl.type === 'const_declaration') {
      for (const spec of decl.descendantsOfType(['var_spec', 'const_spec'])) for (const n of spec?.childrenForFieldName('name') ?? []) if (n) topData.add(n.text);
    }
  }

  // The names each package-level declaration binds inside it, by the declaration.
  const bindings = new Map<number, Set<string>>();
  const boundAround = (node: Node, name: string): boolean => {
    let top = node;
    while (top.parent && top.parent.type !== 'source_file') top = top.parent;
    let names = bindings.get(top.id);
    if (!names) bindings.set(top.id, (names = boundNames(top)));
    return names.has(name);
  };

  const callEdge = (call: Node, scope: number): void => {
    const line = startLine(call);
    const c = callee(call);
    if (c.kind === 'none') {
      // A call that names nothing, such as `[]byte(s)` or `fns[k]()`, is a call all the same: it is
      // named by its callee's text and placed where it starts.
      out.edge(scope, 'calls', clip(oneLine((calleeNode(call) ?? call).text), CALLEE_TEXT_MAX), line, null, undefined, undefined, { pos: call.startIndex });
      return;
    }
    const at: CallAt = { pos: c.name.startIndex };
    if (c.kind === 'member') {
      out.edge(scope, 'calls', c.name.text, line, memberHint(c.on.text), undefined, undefined, at);
      return;
    }
    const name = c.name.text;
    // A name bound in the declaration is no package-level one; `x[i](…)` on file-level data calls
    // an element of it, never the data itself.
    const bound: Bound | undefined = boundAround(call, name) || (c.indexed && topData.has(name)) ? 'value' : undefined;
    // A predeclared name is in the universe scope, the last place Go looks ("Declarations and scope").
    const universe = bound === undefined && !topData.has(name) && !types.has(name) && BUILTINS.has(name);
    out.edge(scope, 'calls', name, line, null, bound, undefined, universe ? { ...at, outside: { kind: 'builtin', name } } : at);
  };

  // A function literal that is the one value of a package-level name: that name's own node.
  const made = new Map<number, number>();

  // `scope` is the symbol a call here starts from, `container` what holds a symbol made here, and
  // `owner` the nearest named symbol, which lookups name for an unnamed function.
  const visit = (node: Node, scope: number, container: number, owner: number): void => {
    let inner = scope;
    let innerContainer = container;
    let innerOwner = owner;
    switch (node.type) {
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) inner = innerContainer = innerOwner = symbolOf('function', name, node, node, moduleSymbol, signatureOf(node, src));
        break;
      }
      case 'method_declaration': {
        // A method is named through its receiver's base type, and held by it when the file declares it.
        const name = node.childForFieldName('name')?.text;
        const base = receiverBase(node)?.text;
        const type = base === undefined ? undefined : types.get(base);
        if (name) inner = innerContainer = innerOwner = symbolOf('method', `${base ?? '?'}.${name}`, node, node, type ?? moduleSymbol, signatureOf(node, src));
        break;
      }
      case 'func_literal': {
        const known = made.get(node.id);
        inner = innerContainer =
          known ??
          out.symbol(
            {
              kind: 'function',
              qualified_name: unnamedLabel(node),
              signature: signatureOf(node, src),
              doc: '',
              start_line: startLine(node),
              end_line: endLine(node),
              body_hash: normalizedHash(node),
              exported: 0,
              parent: container,
              unnamed: 1,
              owner,
            },
            `lit\u0000${node.startIndex}`,
          );
        break;
      }
      case 'var_spec':
      case 'const_spec': {
        // Each name a package-level `var` or `const` declares is file-level data ("Variable
        // declarations", "Constant declarations").
        const decl = topDeclaration(node);
        if (!decl) break;
        const anchor = specAnchor(node, decl);
        const names = node.childrenForFieldName('name').filter((n): n is Node => n !== null);
        const own = names.filter((n) => n.text !== BLANK);
        const valueList = node.childForFieldName('value');
        const values = valueList ? named(valueList).filter((v) => v.type !== 'comment') : [];
        // A function written as the one value of a file-level name is that name's one callable node.
        const lit = names.length === 1 && own.length === 1 && values.length === 1 && values[0]!.type === 'func_literal' ? values[0]! : null;
        const ids = own.map((n) =>
          lit
            ? symbolOf('function', n.text, node, anchor, moduleSymbol, textSignature(anchor, lit.childForFieldName('body')?.startIndex ?? lit.endIndex))
            : symbolOf(SYMBOL_KINDS.fileData, n.text, node, anchor, moduleSymbol, textSignature(anchor, node.endIndex)),
        );
        if (lit) made.set(lit.id, ids[0]!);
        // A call in the value of a spec that binds one name belongs to that name; else to the file.
        if (names.length === 1 && ids.length === 1) inner = innerOwner = ids[0]!;
        break;
      }
      case 'call_expression':
      case 'type_conversion_expression':
        callEdge(node, scope);
        break;
    }
    for (const c of named(node)) visit(c, inner, innerContainer, innerOwner);
  };
  visit(root, moduleSymbol, moduleSymbol, moduleSymbol);
}

export const go: LanguageModule = {
  name: 'go',
  linguist: ['Go'],
  endings: ['.go'],
  grammar: goWasm,
  comment: 'slash',
  extract: (file, out) => extractGo(syntaxTree(file), file.src, out, file.module),
  tool: goTypeChecker,
};
