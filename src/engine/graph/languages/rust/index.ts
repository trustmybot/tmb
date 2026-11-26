// Rust, read through tree-sitter (trustmybot/tmb#354): its functions, the methods of its impl blocks
// and traits, its types, traits and inline modules, the closures in them, its file-level constants
// and statics, and the calls each makes. The kinds follow CODE_GRAPH.md's "Kinds of symbol"; each
// rule below names the page of the Rust Reference (https://doc.rust-lang.org/reference/) it reads.
// Way A links only what those rules prove inside one file; the rest is the tool's.
import rustWasm from 'tree-sitter-rust/tree-sitter-rust.wasm' with { type: 'file' };
import type { Node } from 'web-tree-sitter';
import type { CallMark, Collector, LanguageModule, SymbolKind } from '../contract.ts';
import { clip, DOC_MAX, memberHint, named, normalizedHash, oneLine, signatureOf, syntaxTree } from '../kit.ts';
import { rustAnalyzer } from './tool.ts';

/** The grammar's node types for a comment. */
const RUST_COMMENTS: readonly string[] = ['line_comment', 'block_comment'];

/** The longest a call's text is kept as its name when its callee is no name. */
const CALLEE_TEXT_MAX = 80;

/** The type items (items/structs.html, items/enumerations.html, items/unions.html, items/type-aliases.html), each a type node. */
const TYPE_ITEMS: ReadonlySet<string> = new Set(['struct_item', 'enum_item', 'union_item', 'type_item']);

/** A trait (items/traits.html): a type whose methods may have no body, as an interface's. */
const TRAIT_ITEM = 'trait_item';

/** A module (items/modules.html). One written with a body is a type-like container; `mod m;` names a file and is no node. */
const MOD_ITEM = 'mod_item';

/** An implementation (items/implementations.html): no node of its own; its associated items are members of the type it is for. */
const IMPL_ITEM = 'impl_item';

/** An external block (items/external-blocks.html): its functions are declarations whose code is elsewhere, so they are no nodes. */
const EXTERN_BLOCK = 'foreign_mod_item';

/** A function item with a body, and a function declared with none, in a trait or an external block (items/functions.html). */
const FUNCTION_ITEMS: ReadonlySet<string> = new Set(['function_item', 'function_signature_item']);

/** A constant and a static item (items/constant-items.html, items/static-items.html): file-level data at a file's top level. */
const DATA_ITEMS: ReadonlySet<string> = new Set(['const_item', 'static_item']);

/** The node types an outer attribute is written as before an item (attributes.html). */
const OUTER_ATTRIBUTE = 'attribute_item';

/** A doc comment's marker that makes it an outer doc attribute (comments.html#doc-comments). */
const OUTER_DOC_MARKER = 'outer_doc_comment_marker';

/** The type `Self` names inside an implementation (paths.html#self-1). */
const SELF_TYPE = 'Self';

// The nodes whose identifiers a pattern binds as local variables (patterns.html, statements.html#let-statements):
// a function's and a closure's parameters, a `let`, a `for`, an `if let` or `while let`, and a match arm.
const PATTERN_HOLDERS: ReadonlySet<string> = new Set(['parameter', 'closure_parameters', 'let_declaration', 'for_expression', 'let_condition', 'match_pattern']);

/** The field of each pattern holder that holds its pattern; null when the whole node is the pattern. */
const PATTERN_FIELD: Readonly<Record<string, string | null>> = {
  parameter: 'pattern',
  closure_parameters: null,
  let_declaration: 'pattern',
  for_expression: 'pattern',
  let_condition: 'pattern',
  match_pattern: null,
};

const startLine = (n: Node): number => n.startPosition.row + 1;
const endLine = (n: Node): number => n.endPosition.row + 1;

// Whether a comment is a doc comment of the item after it, `///` or `/** */` (comments.html#doc-comments).
const isOuterDoc = (n: Node): boolean => RUST_COMMENTS.includes(n.type) && named(n).some((c) => c.type === OUTER_DOC_MARKER);

// Whether a comment is an inner doc comment, `//!` or `/*! */`, which documents what holds it, not the item after it.
const isInnerDoc = (n: Node): boolean => RUST_COMMENTS.includes(n.type) && named(n).some((c) => c.type === 'inner_doc_comment_marker');

// The outer attributes and comments written right before an item, nearest first. Outer attributes,
// doc comments among them, belong to the item that follows them, across blank lines and plain
// comments (attributes.html, comments.html#doc-comments).
function leading(item: Node): Node[] {
  const out: Node[] = [];
  for (let prev = item.previousSibling; prev; prev = prev.previousSibling) {
    if (prev.type === OUTER_ATTRIBUTE || (RUST_COMMENTS.includes(prev.type) && !isInnerDoc(prev))) out.push(prev);
    else break;
  }
  return out;
}

/** Where an item starts: at its first outer attribute or doc comment, else at the item. */
function itemStart(item: Node): number {
  let start = startLine(item);
  for (const n of leading(item)) if (n.type === OUTER_ATTRIBUTE || isOuterDoc(n)) start = startLine(n);
  return start;
}

/** The comments right above an item, past its attributes, with no blank row between, as one line. */
function docAbove(item: Node): string {
  const blocks: string[] = [];
  let edge = item.startPosition.row;
  for (const n of leading(item)) {
    // A line comment's node ends on the row after it when it holds its newline.
    const end = n.endPosition.column === 0 ? n.endPosition.row - 1 : n.endPosition.row;
    if (end < edge - 1) break;
    edge = n.startPosition.row;
    if (n.type !== OUTER_ATTRIBUTE) blocks.unshift(n.text);
  }
  const raw = blocks
    .flatMap((b) => b.split('\n'))
    .map((l) => l.replace(/\*\//g, ' ').replace(/^\s*(\/\*[*!]?|\*|\/\/[/!]?)/, ' '))
    .join(' ');
  return clip(oneLine(raw), DOC_MAX);
}

/** Whether an item is public, `pub` with no restriction (visibility-and-privacy.html). */
const isPub = (item: Node): boolean => named(item).some((c) => c.type === 'visibility_modifier' && c.text === 'pub');

/** The node an implementation is for, its `Self` (items/implementations.html), with references, pointers and type arguments taken off. */
function implSelf(impl: Node): Node | null {
  let t = impl.childForFieldName('type');
  for (;;) {
    if (t?.type === 'generic_type') t = t.childForFieldName('type');
    else if (t?.type === 'reference_type' || t?.type === 'pointer_type') t = t.childForFieldName('type');
    else return t;
  }
}

/** The name an implementation's type is written by: its last path segment, or the type's own text when it is no path. */
function implTypeName(impl: Node): string {
  const t = implSelf(impl);
  if (!t) return '';
  if (t.type === 'scoped_type_identifier') return t.childForFieldName('name')?.text ?? t.text;
  return oneLine(t.text);
}

/** What a call's callee names, and where it is written (expressions/call-expr.html, expressions/method-call-expr.html). */
type Callee =
  | { kind: 'bare'; name: Node }
  | { kind: 'path'; name: Node; path: Node }
  | { kind: 'method'; name: Node; on: Node }
  | { kind: 'none'; at: Node };

function callee(call: Node): Callee {
  let fn = call.childForFieldName('function');
  for (;;) {
    if (!fn) return { kind: 'none', at: call };
    if (fn.type === 'parenthesized_expression') fn = named(fn)[0] ?? null;
    else if (fn.type === 'generic_function') fn = fn.childForFieldName('function');
    else break;
  }
  if (fn.type === 'identifier' || fn.type === 'self') return { kind: 'bare', name: fn };
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name');
    const path = fn.childForFieldName('path');
    return name && path ? { kind: 'path', name, path } : name ? { kind: 'bare', name } : { kind: 'none', at: fn };
  }
  if (fn.type === 'field_expression') {
    const name = fn.childForFieldName('field');
    const on = fn.childForFieldName('value');
    if (name && on) return { kind: 'method', name, on };
  }
  return { kind: 'none', at: fn };
}

/** The name of a closure: the call it is passed to, else its line. */
function closureLabel(closure: Node): string {
  const args = closure.parent;
  const c = args?.type === 'arguments' && args.parent?.type === 'call_expression' ? callee(args.parent) : null;
  return c !== null && c.kind !== 'none' ? `callback of \`${c.name.text}\`` : `function at line ${startLine(closure)}`;
}

/** Every identifier a pattern under `node` may bind, a path among them: more names than it binds hide more, never fewer. */
function patternNames(node: Node, into: Set<string>): void {
  if (node.type === 'identifier' || node.type === 'shorthand_field_identifier') into.add(node.text);
  for (const c of named(node)) patternNames(c, into);
}

/** Every name a pattern binds as a local variable anywhere inside `top`, its parameters included. */
function localNames(top: Node): Set<string> {
  const names = new Set<string>();
  const walk = (n: Node): void => {
    if (PATTERN_HOLDERS.has(n.type)) {
      const field = PATTERN_FIELD[n.type];
      const pattern = field === null || field === undefined ? n : n.childForFieldName(field);
      if (pattern) patternNames(pattern, names);
    }
    for (const c of named(n)) walk(c);
  };
  walk(top);
  return names;
}

/** What one item a scope holds binds a name to, in the value namespace or the type namespace (names/namespaces.html). */
type Binding =
  | { kind: 'function'; item: Node }
  | { kind: 'tuple struct'; item: Node }
  | { kind: 'data'; item: Node }
  | { kind: 'enum'; item: Node }
  | { kind: 'other' };

// The names the items of one scope declare (names/scopes.html#item-scopes): a module's, written in a
// file or in a `mod` body, or a block's, whose items are in scope in the whole block. `open` is
// set when the scope may hold a name it does not write out: a glob import, which the scope's own
// items shadow, or a macro invocation in an item's place, whose expansion may declare items.
type Scope = { values: Map<string, Binding[]>; types: Map<string, Binding[]>; open: boolean };

/** Whether a struct is a tuple struct, whose name is also a constructor function (items/structs.html). */
const isTupleStruct = (item: Node): boolean => named(item).some((c) => c.type === 'ordered_field_declaration_list');

/** The names a `use` declaration binds (items/use-declarations.html), and whether it is a glob. */
function useNames(use: Node): { names: string[]; glob: boolean } {
  const names: string[] = [];
  let glob = false;
  const walk = (n: Node | null): void => {
    if (!n) return;
    switch (n.type) {
      case 'use_wildcard':
        glob = true;
        return;
      case 'use_as_clause':
        names.push(n.childForFieldName('alias')?.text ?? '');
        return;
      case 'scoped_use_list':
        walk(n.childForFieldName('list'));
        return;
      case 'use_list':
        for (const c of named(n)) walk(c);
        return;
      case 'scoped_identifier':
        names.push(n.childForFieldName('name')?.text ?? '');
        return;
      case 'identifier':
      case 'self':
      case 'crate':
      case 'super':
        names.push(n.text);
        return;
    }
  };
  walk(use.childForFieldName('argument'));
  return { names: names.filter((n) => n !== ''), glob };
}

/** The items a module body, a file or a block declares, by name. */
function scopeOf(holder: Node): Scope {
  const scope: Scope = { values: new Map(), types: new Map(), open: false };
  const add = (map: Map<string, Binding[]>, name: string | undefined, b: Binding): void => {
    if (name) map.set(name, [...(map.get(name) ?? []), b]);
  };
  for (const raw of named(holder)) {
    // A macro invocation in a block is written as a statement.
    const item = raw.type === 'expression_statement' && named(raw)[0]?.type === 'macro_invocation' ? named(raw)[0]! : raw;
    const name = item.childForFieldName('name')?.text;
    switch (item.type) {
      case 'function_item':
        add(scope.values, name, { kind: 'function', item });
        break;
      case 'struct_item':
        add(scope.types, name, { kind: 'other' });
        // A tuple struct's name is a function too; a unit struct's is a constant (items/structs.html).
        add(scope.values, name, isTupleStruct(item) ? { kind: 'tuple struct', item } : { kind: 'other' });
        break;
      case 'enum_item':
        add(scope.types, name, { kind: 'enum', item });
        break;
      case 'union_item':
      case 'type_item':
      case 'trait_item':
      case 'mod_item':
        add(scope.types, name, { kind: 'other' });
        break;
      case 'const_item':
      case 'static_item':
        add(scope.values, name, { kind: 'data', item });
        break;
      case 'extern_crate_declaration':
        add(scope.types, item.childForFieldName('alias')?.text ?? name, { kind: 'other' });
        break;
      case 'use_declaration': {
        const u = useNames(item);
        if (u.glob) scope.open = true;
        for (const n of u.names) {
          add(scope.values, n, { kind: 'other' });
          add(scope.types, n, { kind: 'other' });
        }
        break;
      }
      case EXTERN_BLOCK:
        for (const f of named(item.childForFieldName('body') ?? item)) {
          const fname = f.childForFieldName('name')?.text;
          if (fname) add(scope.values, fname, { kind: 'other' });
        }
        break;
      case 'macro_invocation':
        scope.open = true;
        break;
    }
  }
  return scope;
}

/** Whether a node is a module's own scope: the file, or the body of a `mod` (items/modules.html). */
const isModuleScope = (n: Node): boolean => n.type === 'source_file' || (n.type === 'declaration_list' && n.parent?.type === MOD_ITEM);

/** The generic parameters an item declares (items/generics.html): each a name in the type namespace inside it. */
function genericNames(item: Node): string[] {
  const params = item.childForFieldName('type_parameters');
  return params ? named(params).flatMap((p) => (p.childForFieldName('name') ? [p.childForFieldName('name')!.text] : [])) : [];
}

function extractRust(root: Node, src: string, out: Collector, moduleSymbol: number): void {
  // Each declaration is its own symbol, by its place: two items of one name, such as two impls'
  // methods or two cfg'd functions, stay two.
  const symbolOf = (kind: SymbolKind, name: string, item: Node, parent: number, exported: boolean, reach?: 'nested' | 'member'): number =>
    out.symbol(
      {
        kind,
        qualified_name: name,
        signature: signatureOf(item, src),
        doc: docAbove(item),
        start_line: itemStart(item),
        end_line: endLine(item),
        body_hash: normalizedHash(item, RUST_COMMENTS),
        exported: exported ? 1 : 0,
        parent,
        ...(reach ? { reach } : {}),
      },
      `${kind}\u0000${item.startIndex}\u0000${name}`,
    );

  // The node each item of the file is, by the item's syntax node.
  const nodeOf = new Map<number, number>();
  // The type node an implementation's items are members of, and the name they are named through.
  const scopes = new Map<number, Scope>();
  const scopeFor = (holder: Node): Scope => {
    let s = scopes.get(holder.id);
    if (!s) scopes.set(holder.id, (s = scopeOf(holder)));
    return s;
  };

  /** The one type item of `name` the scope `holder` declares, or null. */
  const typeItemIn = (holder: Node, name: string): Node | null => {
    for (const c of named(holder)) if ((TYPE_ITEMS.has(c.type) || c.type === TRAIT_ITEM) && c.childForFieldName('name')?.text === name) return c;
    return null;
  };

  // `prefix` names what a module's items are named through; `inBlock` is set inside a function's
  // body, where an item is local to its block (statements.html#item-declarations) and named by its
  // own name. `scope` is the node a call here belongs to, `container` what holds a node made here,
  // `owner` the nearest named node, and `member` the type an implementation's or a trait's items
  // belong to.
  type Around = { scope: number; container: number; owner: number; prefix: string; inBlock: boolean; member: { name: string; symbol: number | null; exported: boolean } | null };
  const pending: { call: Node; scope: number }[] = [];

  const visit = (node: Node, at: Around): void => {
    let inner: Around = at;
    const t = node.type;
    const name = node.childForFieldName('name')?.text;
    const qualified = (own: string): string => (at.inBlock ? own : `${at.prefix}${own}`);
    const reach = at.inBlock ? ('nested' as const) : undefined;
    if (FUNCTION_ITEMS.has(t)) {
      // A function in an external block is a declaration whose code is elsewhere: no node
      // (CODE_GRAPH.md, "Two ways to make links").
      if (name && node.parent?.parent?.type !== EXTERN_BLOCK) {
        const holder = node.parent?.parent?.type;
        const symbol =
          at.member !== null && (holder === IMPL_ITEM || holder === TRAIT_ITEM)
            ? // An associated function is a member of the type its implementation is for, or of its trait (items/associated-items.html).
              symbolOf('method', `${at.member.name}.${name}`, node, at.member.symbol ?? moduleSymbol, holder === TRAIT_ITEM ? at.member.exported : isPub(node))
            : symbolOf('function', qualified(name), node, at.container, isPub(node), reach);
        nodeOf.set(node.id, symbol);
        inner = { ...at, scope: symbol, container: symbol, owner: symbol, inBlock: true, member: null };
      }
    } else if (TYPE_ITEMS.has(t) || t === TRAIT_ITEM || (t === MOD_ITEM && node.childForFieldName('body'))) {
      if (name) {
        const kind: SymbolKind = t === TRAIT_ITEM ? 'interface' : 'type';
        const symbol = symbolOf(kind, qualified(name), node, at.container, isPub(node), reach);
        nodeOf.set(node.id, symbol);
        // A module's items are named through it, as a type's members are (CODE_GRAPH.md, "Kinds of
        // symbol"); a trait's are its members.
        inner = {
          ...at,
          scope: symbol,
          container: symbol,
          owner: symbol,
          prefix: `${qualified(name)}.`,
          inBlock: false,
          member: t === TRAIT_ITEM ? { name: qualified(name), symbol, exported: isPub(node) } : null,
        };
      }
    } else if (t === IMPL_ITEM) {
      // An implementation's items are members of its type: named through it, and held by it when the
      // scope the implementation is written in declares that type, else by the file (CODE_GRAPH.md,
      // "A member is always inside its type", edge case 3).
      const typeName = implTypeName(node);
      const self = implSelf(node);
      const declared = self?.type === 'type_identifier' && node.parent ? typeItemIn(node.parent, self.text) : null;
      const symbol = declared ? (nodeOf.get(declared.id) ?? null) : null;
      const memberName = symbol !== null ? out.symbols[symbol]!.qualified_name : typeName;
      inner = { ...at, scope: symbol ?? at.scope, member: { name: memberName, symbol, exported: false } };
    } else if (DATA_ITEMS.has(t) && node.parent?.type === 'source_file') {
      // A constant or a static at a file's top level is file-level data; a call in its value belongs to it.
      if (name) {
        const symbol = symbolOf('const', name, node, moduleSymbol, isPub(node));
        nodeOf.set(node.id, symbol);
        inner = { ...at, scope: symbol, owner: symbol };
      }
    } else if (t === 'closure_expression') {
      // A closure (expressions/closure-expr.html) is a function with no name, owned by the nearest named node.
      const symbol = out.symbol(
        {
          kind: 'function',
          qualified_name: closureLabel(node),
          signature: signatureOf(node, src),
          doc: '',
          start_line: startLine(node),
          end_line: endLine(node),
          body_hash: normalizedHash(node, RUST_COMMENTS),
          exported: 0,
          parent: at.container,
          unnamed: 1,
          owner: at.owner,
        },
        `closure\u0000${node.startIndex}`,
      );
      inner = { ...at, scope: symbol, container: symbol };
    } else if (t === 'call_expression') {
      pending.push({ call: node, scope: at.scope });
    }
    // An item is in scope in its whole module or block, before its declaration too
    // (names/scopes.html#item-scopes): the implementations come after the types they are for.
    const kids = named(node);
    for (const c of kids) if (c.type !== IMPL_ITEM) visit(c, inner);
    for (const c of kids) if (c.type === IMPL_ITEM) visit(c, inner);
  };
  visit(root, { scope: moduleSymbol, container: moduleSymbol, owner: moduleSymbol, prefix: '', inBlock: false, member: null });

  // The names each outermost item binds as locals, by the item.
  const locals = new Map<number, Set<string>>();
  const boundLocally = (node: Node, name: string): boolean => {
    let top: Node | null = null;
    for (let a: Node | null = node; a; a = a.parent) if (FUNCTION_ITEMS.has(a.type) || a.type === 'closure_expression' || DATA_ITEMS.has(a.type)) top = a;
    if (top === null) return false;
    let names = locals.get(top.id);
    if (!names) locals.set(top.id, (names = localNames(top)));
    return names.has(name);
  };

  // Whether a generic parameter of an item around `node` is named `name`: it hides a type of that name.
  const genericAround = (node: Node, name: string): boolean => {
    for (let a: Node | null = node; a; a = a.parent) if (genericNames(a).includes(name)) return true;
    return false;
  };

  // What a one-segment path names where it is written (names/name-resolution.html, names/scopes.html):
  // the items of each block around it, innermost first, then the items of its module; a module
  // does not see its parent's items. The first scope that declares the name decides; one that may
  // hold the name unwritten, by a glob import or a macro, proves nothing. Null when no scope proves
  // one binding.
  const lookup = (node: Node, name: string, space: 'values' | 'types'): Binding | null => {
    for (let a = node.parent; a; a = a.parent) {
      const isBlock = a.type === 'block';
      if (!isBlock && !isModuleScope(a)) continue;
      const scope = scopeFor(a);
      const found = scope[space].get(name);
      if (found) return found.length === 1 ? found[0]! : null;
      if (scope.open || isModuleScope(a)) return null;
    }
    return null;
  };

  /** The implementation `Self` names around a node, and the type item of the file it is for; null outside an implementation or when the file does not declare its type. */
  const selfItem = (node: Node): Node | null => {
    for (let a = node.parent; a; a = a.parent) {
      if (a.type === TRAIT_ITEM) return null;
      if (a.type !== IMPL_ITEM) continue;
      const self = implSelf(a);
      return self?.type === 'type_identifier' && a.parent ? typeItemIn(a.parent, self.text) : null;
    }
    return null;
  };

  /** The variant of an enum item named `name` that is written with fields in parentheses, a constructor function (items/enumerations.html). */
  const hasTupleVariant = (item: Node, name: string): boolean =>
    named(item.childForFieldName('body') ?? item).some(
      (v) => v.type === 'enum_variant' && v.childForFieldName('name')?.text === name && v.childForFieldName('body')?.type === 'ordered_field_declaration_list',
    );

  const markOf = (call: Node): { name: string; pos: number; hint: string | null; mark: CallMark } => {
    const c = callee(call);
    if (c.kind === 'none') return { name: clip(oneLine(c.at.text), CALLEE_TEXT_MAX), pos: call.startIndex, hint: null, mark: {} };
    const pos = c.name.startIndex;
    const name = c.name.text;
    if (c.kind === 'method') return { name, pos, hint: memberHint(c.on.text), mark: {} };
    if (c.kind === 'bare') {
      // `Self(…)` in an implementation for a tuple struct of the file constructs that struct (paths.html#self-1).
      if (name === SELF_TYPE) {
        const item = selfItem(call);
        const symbol = item && isTupleStruct(item) ? nodeOf.get(item.id) : undefined;
        return { name, pos, hint: null, mark: symbol === undefined ? {} : { target: symbol } };
      }
      // A local variable of the name hides every item of it (names/scopes.html#pattern-binding-scopes).
      if (boundLocally(call, name)) return { name, pos, hint: null, mark: {} };
      const b = lookup(call, name, 'values');
      // A function links to itself; a tuple struct's constructor to the struct (CODE_GRAPH.md, "Two
      // ways to make links"); file-level data to its node.
      const symbol = b !== null && (b.kind === 'function' || b.kind === 'tuple struct' || b.kind === 'data') ? nodeOf.get(b.item.id) : undefined;
      return { name, pos, hint: null, mark: symbol === undefined ? {} : { target: symbol } };
    }
    // `E::V(…)`, where `E` is an enum of the file and `V` its tuple variant, constructs the enum
    // (expressions/call-expr.html, items/enumerations.html); `Self::V(…)` in its implementation too.
    const path = c.path;
    const hint = memberHint(path.text);
    if (path.type !== 'identifier' && path.type !== 'self') return { name, pos, hint, mark: {} };
    let item: Node | null = null;
    if (path.text === SELF_TYPE) item = selfItem(call);
    else if (!genericAround(call, path.text)) {
      const b = lookup(call, path.text, 'types');
      item = b !== null && b.kind === 'enum' ? b.item : null;
    }
    const symbol = item !== null && item.type === 'enum_item' && hasTupleVariant(item, name) ? nodeOf.get(item.id) : undefined;
    return { name, pos, hint, mark: symbol === undefined ? {} : { target: symbol } };
  };

  for (const { call, scope } of pending) {
    const c = markOf(call);
    // No call is linked by its name alone: what the language's rules prove is its target.
    out.edge(scope, 'calls', c.name, startLine(call), c.hint, 'value', undefined, { pos: c.pos, ...c.mark });
  }
}

export const rust: LanguageModule = {
  name: 'rust',
  linguist: ['Rust'],
  endings: ['.rs'],
  grammar: rustWasm,
  comment: 'slash',
  tool: rustAnalyzer,
  extract: (file, out) => extractRust(syntaxTree(file), file.src, out, file.module),
};
