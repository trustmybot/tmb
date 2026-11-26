// Java, read through tree-sitter (trustmybot/tmb#353): its classes, interfaces, enums, records and
// annotation interfaces, their methods and constructors, the lambdas in them, and the calls each
// makes. The kinds follow CODE_GRAPH.md's "Kinds of symbol"; each rule below names the section of
// the Java Language Specification, Java SE 21 (https://docs.oracle.com/javase/specs/jls/se21/html/),
// it reads. Way A links only what those rules prove inside one file; the rest is the tool's.
import javaWasm from 'tree-sitter-java/tree-sitter-java.wasm' with { type: 'file' };
import type { Node } from 'web-tree-sitter';
import type { CallMark, Collector, LanguageModule, SymbolKind } from '../contract.ts';
import { docOf, memberHint, named, normalizedHash, signatureOf, syntaxTree } from '../kit.ts';
import { INHERITED, JAVA_LANG_TYPES } from './builtins.ts';

/** The grammar's node types for a comment. */
const JAVA_COMMENTS: readonly string[] = ['line_comment', 'block_comment'];

/** The kinds of type declaration (8.1, 8.9, 8.10, 9.1, 9.6), by the grammar's node type, as builtins.ts names them. */
const TYPE_DECLARATIONS: ReadonlyMap<string, string> = new Map([
  ['class_declaration', 'class'],
  ['enum_declaration', 'enum'],
  ['record_declaration', 'record'],
  ['interface_declaration', 'interface'],
  ['annotation_type_declaration', 'annotation'],
]);

/** The node kind of each kind of type declaration: an enum and a record are classes, an annotation interface an interface. */
const TYPE_NODE_KIND: Readonly<Record<string, SymbolKind>> = { class: 'class', enum: 'class', record: 'class', interface: 'interface', annotation: 'interface' };

/** A method (8.4, 9.4), a constructor (8.8), a compact constructor (8.10.4) and an annotation interface element (9.6.1): each a method node. */
const CALLABLES: ReadonlySet<string> = new Set(['method_declaration', 'constructor_declaration', 'compact_constructor_declaration', 'annotation_type_element_declaration']);

/** Of those, the ones an invocation names by their own name (15.12): not a constructor, which only a creation or `this(…)` reaches. */
const INVOKED: ReadonlySet<string> = new Set(['method_declaration', 'annotation_type_element_declaration']);

/** The bodies whose declarations are members of the type around them (8.1.7, 8.9.2, 9.1.5, 9.6.1). */
const MEMBER_BODIES: ReadonlySet<string> = new Set(['class_body', 'interface_body', 'annotation_type_body', 'enum_body_declarations']);

/** What holds an anonymous class body: a class instance creation (15.9.5) or an enum constant (8.9.1). */
const ANONYMOUS_HOLDERS: ReadonlySet<string> = new Set(['object_creation_expression', 'enum_constant']);

/** Every member of an interface or an annotation interface is public unless it is private (9.3, 9.4, 9.5, 9.6.1). */
const PUBLIC_BODIES: ReadonlySet<string> = new Set(['interface_body', 'annotation_type_body']);

/** The methods an enum declares implicitly, with no declaration in the file (8.9.3). */
const ENUM_IMPLICIT_METHODS: ReadonlySet<string> = new Set(['values', 'valueOf']);

/** The methods a record declares implicitly unless it declares them itself, besides one accessor per component (8.10.3). */
const RECORD_IMPLICIT_METHODS: ReadonlySet<string> = new Set(['equals', 'hashCode', 'toString']);

/** The type an explicit constructor invocation `super(…)` reaches in a class that names no superclass (8.1.4). */
const OBJECT = 'Object';

// Every place the language declares a variable by a name (4.12.3, 6.1): a field and a local (8.3,
// 14.4), a parameter of a method, a constructor, a lambda, a catch clause or a for, a resource, a
// record component, a pattern's binding and an enum constant. A name of one is never a type (6.5.2).
const VARIABLE_HOLDERS: ReadonlySet<string> = new Set([
  'variable_declarator',
  'formal_parameter',
  'catch_formal_parameter',
  'resource',
  'enhanced_for_statement',
  'instanceof_expression',
  'enum_constant',
]);
/** Nodes whose every identifier child is a variable: a lambda's names with no types, and the bindings of a pattern. */
const VARIABLE_LISTS: ReadonlySet<string> = new Set(['inferred_parameters', 'record_pattern_component', 'type_pattern']);

const startLine = (n: Node): number => n.startPosition.row + 1;
const endLine = (n: Node): number => n.endPosition.row + 1;

/** One type declaration of the file, or an anonymous class body (`kind` null), and the type around it. */
interface TypeDecl {
  node: Node;
  kind: string | null;
  name: string;
  symbol: number;
  outer: TypeDecl | null;
}

/** A declaration's place: a member of a named type, a member of an anonymous class, at the file's top level, or local to a block (14.3). */
type Place = { kind: 'member'; type: Node } | { kind: 'anonymous' } | { kind: 'top' } | { kind: 'local' };

function placeOf(decl: Node): Place {
  const holder = decl.parent;
  if (!holder) return { kind: 'local' };
  if (holder.type === 'program') return { kind: 'top' };
  if (!MEMBER_BODIES.has(holder.type)) return { kind: 'local' };
  const body = holder.type === 'enum_body_declarations' ? holder.parent : holder;
  const type = body?.parent;
  if (!type) return { kind: 'local' };
  if (ANONYMOUS_HOLDERS.has(type.type)) return { kind: 'anonymous' };
  return TYPE_DECLARATIONS.has(type.type) ? { kind: 'member', type } : { kind: 'local' };
}

/** The declarations of a type's body, an enum's after its constants included. */
function bodyMembers(type: Node): Node[] {
  const body = type.childForFieldName('body');
  if (!body) return [];
  return named(body).flatMap((c) => (c.type === 'enum_body_declarations' ? named(c) : [c]));
}

/** Whether a declaration has the modifier `word`. */
const hasModifier = (decl: Node, word: string): boolean =>
  named(decl).some((c) => c.type === 'modifiers' && c.children.some((m) => m?.type === word));

/** The simple name a type is written by, `T` in `T` or `T<A>`; null for a qualified or other type. */
function simpleTypeName(type: Node | null): string | null {
  if (type?.type === 'generic_type') type = named(type)[0] ?? null;
  return type?.type === 'type_identifier' ? type.text : null;
}

/** The class a class declaration extends (8.1.4), or null when it names none. */
const superclassOf = (decl: Node): Node | null => {
  const sup = decl.childForFieldName('superclass');
  return sup ? (named(sup)[0] ?? null) : null;
};

/** Every supertype a declaration names: its superclass and the interfaces it implements or extends (8.1.4, 8.1.5, 9.1.3). */
function supertypesOf(decl: Node): Node[] {
  const out: Node[] = [];
  const sup = superclassOf(decl);
  if (sup) out.push(sup);
  for (const c of named(decl)) {
    if (c.type !== 'super_interfaces' && c.type !== 'extends_interfaces') continue;
    for (const list of named(c)) out.push(...(list.type === 'type_list' ? named(list) : [list]));
  }
  return out;
}

/** The name of a call's callee as the lambda's label: the method a lambda is passed to, or the class it is passed to the constructor of. */
function calledName(call: Node): string | null {
  if (call.type === 'method_invocation') return call.childForFieldName('name')?.text ?? null;
  if (call.type === 'explicit_constructor_invocation') return call.childForFieldName('constructor')?.text ?? null;
  if (call.type === 'object_creation_expression') return createdName(call)?.text ?? null;
  return null;
}

/** The simple name a class instance creation writes for its class (15.9): `B` in `new B()`, `new a.B<T>()` and `new @A B()`. */
function createdName(creation: Node): Node | null {
  let type = creation.childForFieldName('type');
  if (type?.type === 'generic_type') type = named(type)[0] ?? null;
  if (type?.type === 'scoped_type_identifier') type = named(type).at(-1) ?? null;
  return type?.type === 'type_identifier' ? type : null;
}

/** A lambda's name: the call it is passed to, else its line. */
function lambdaLabel(lambda: Node): string {
  const args = lambda.parent;
  const name = args?.type === 'argument_list' && args.parent ? calledName(args.parent) : null;
  return name ? `callback of \`${name}\`` : `function at line ${startLine(lambda)}`;
}

/** What a file's imports name (7.5): the simple names of its single imports, by whether each is static, and whether it has a static import on demand. */
function importsOf(root: Node): { types: Set<string>; statics: Set<string>; staticOnDemand: boolean } {
  const types = new Set<string>();
  const statics = new Set<string>();
  let staticOnDemand = false;
  for (const imp of named(root)) {
    if (imp.type !== 'import_declaration') continue;
    const isStatic = imp.children.some((c) => c?.type === 'static');
    const onDemand = imp.children.some((c) => c?.type === 'asterisk');
    const path = named(imp).find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
    const last = path?.text.split('.').at(-1)?.trim();
    if (onDemand) staticOnDemand ||= isStatic;
    else if (last) (isStatic ? statics : types).add(last);
  }
  return { types, statics, staticOnDemand };
}

/** Every name the file declares a variable by, anywhere in it. */
function variablesOf(root: Node): Set<string> {
  const names = new Set<string>();
  const walk = (n: Node): void => {
    if (VARIABLE_HOLDERS.has(n.type)) {
      const name = n.childForFieldName('name');
      if (name) names.add(name.text);
    } else if (VARIABLE_LISTS.has(n.type)) {
      for (const c of named(n)) if (c.type === 'identifier') names.add(c.text);
    } else if (n.type === 'lambda_expression') {
      const p = n.childForFieldName('parameters');
      if (p?.type === 'identifier') names.add(p.text);
    }
    for (const c of named(n)) walk(c);
  };
  walk(root);
  return names;
}

function extractJava(root: Node, src: string, out: Collector, moduleSymbol: number): void {
  const symbolOf = (
    kind: SymbolKind,
    name: string,
    node: Node,
    parent: number,
    exported: boolean,
    reach?: 'nested' | 'member',
  ): number =>
    out.symbol(
      {
        kind,
        qualified_name: name,
        signature: signatureOf(node, src),
        doc: docOf(node, JAVA_COMMENTS),
        start_line: startLine(node),
        end_line: endLine(node),
        body_hash: normalizedHash(node, JAVA_COMMENTS),
        exported: exported ? 1 : 0,
        parent,
        ...(reach ? { reach } : {}),
      },
      `${kind}\u0000${node.startIndex}\u0000${name}`,
    );
  // A declaration is exported when it is public (6.6.1), as every member of an interface is that is not private.
  const exportedDecl = (decl: Node): boolean =>
    hasModifier(decl, 'public') || (PUBLIC_BODIES.has(decl.parent?.type ?? '') && !hasModifier(decl, 'private'));

  const types = new Map<number, TypeDecl>();
  const callables = new Map<number, number>();
  const pending: { call: Node; scope: number; type: TypeDecl | null }[] = [];

  // `scope` is the node a call here belongs to, `container` what holds a node made here, `owner`
  // the nearest named node, and `type` the innermost type around, an anonymous one included.
  const visit = (node: Node, scope: number, container: number, owner: number, type: TypeDecl | null): void => {
    let inner = scope;
    let innerContainer = container;
    let innerOwner = owner;
    let innerType = type;
    const declKind = TYPE_DECLARATIONS.get(node.type);
    if (declKind !== undefined) {
      const own = node.childForFieldName('name')?.text;
      if (own) {
        // A member type is named through the type it is declared in (8.5); a local class (14.3) and
        // a member of an anonymous class have no such name, so each is named by its own and reaches
        // only the block it is in.
        const place = placeOf(node);
        const holder = place.kind === 'member' ? types.get(place.type.id) : undefined;
        const symbol =
          holder !== undefined
            ? symbolOf(TYPE_NODE_KIND[declKind]!, `${holder.name}.${own}`, node, holder.symbol, exportedDecl(node))
            : place.kind === 'top'
              ? symbolOf(TYPE_NODE_KIND[declKind]!, own, node, moduleSymbol, exportedDecl(node))
              : symbolOf(TYPE_NODE_KIND[declKind]!, own, node, container, exportedDecl(node), 'nested');
        const decl: TypeDecl = { node, kind: declKind, name: holder !== undefined ? `${holder.name}.${own}` : own, symbol, outer: type };
        types.set(node.id, decl);
        inner = innerContainer = innerOwner = symbol;
        innerType = decl;
      }
    } else if (node.type === 'class_body' && ANONYMOUS_HOLDERS.has(node.parent?.type ?? '')) {
      // An anonymous class (15.9.5) is a type with no name: no node of its own.
      innerType = { node, kind: null, name: '', symbol: container, outer: type };
    } else if (CALLABLES.has(node.type)) {
      const own = node.childForFieldName('name')?.text;
      if (own) {
        // A method is named through its type; a constructor by its class's name (8.8). A method of an
        // anonymous class is a member no name reaches from outside it: it is held by the node around it.
        const place = placeOf(node);
        const holder = place.kind === 'member' ? types.get(place.type.id) : undefined;
        const symbol =
          holder !== undefined
            ? symbolOf('method', `${holder.name}.${own}`, node, holder.symbol, exportedDecl(node))
            : symbolOf('method', own, node, container, exportedDecl(node), 'member');
        callables.set(node.id, symbol);
        inner = innerContainer = innerOwner = symbol;
      }
    } else if (node.type === 'lambda_expression') {
      // A lambda (15.27) is a function with no name, owned by the nearest named node.
      inner = innerContainer = out.symbol(
        {
          kind: 'function',
          qualified_name: lambdaLabel(node),
          signature: signatureOf(node, src),
          doc: '',
          start_line: startLine(node),
          end_line: endLine(node),
          body_hash: normalizedHash(node, JAVA_COMMENTS),
          exported: 0,
          parent: container,
          unnamed: 1,
          owner,
        },
        `lambda\u0000${node.startIndex}`,
      );
    } else if (node.type === 'method_invocation' || node.type === 'object_creation_expression' || node.type === 'explicit_constructor_invocation') {
      pending.push({ call: node, scope, type });
    }
    for (const c of named(node)) visit(c, inner, innerContainer, innerOwner, innerType);
  };
  visit(root, moduleSymbol, moduleSymbol, moduleSymbol, null);

  const imports = importsOf(root);
  const variables = variablesOf(root);
  // A type declared in a block or an anonymous class, and a type parameter, hide a type of the same
  // name in the blocks they are in (6.4.1); the rules do not follow which blocks, so such a name is never proven.
  const hiding = new Set<string>();
  for (const t of types.values()) {
    const place = placeOf(t.node);
    if (place.kind === 'local' || place.kind === 'anonymous') hiding.add(t.name);
  }
  for (const p of root.descendantsOfType('type_parameter')) {
    const name = p ? named(p).find((c) => c.type === 'type_identifier' || c.type === 'identifier') : undefined;
    if (name) hiding.add(name.text);
  }
  const topTypes = new Map<string, TypeDecl>();
  for (const t of types.values()) if (placeOf(t.node).kind === 'top') topTypes.set(t.name, t);

  /** The member types of a type (8.5): its own and those it inherits, with the names its built-in supertype gives; null when a supertype is no type of the file. */
  type Members = { types: Map<string, TypeDecl[]>; builtin: Set<string> };
  const membersOf = (t: TypeDecl, seen: ReadonlySet<TypeDecl>): Members | null => {
    if (t.kind === null || seen.has(t)) return null;
    const result: Members = { types: new Map(), builtin: new Set() };
    for (const m of bodyMembers(t.node)) {
      const decl = types.get(m.id);
      if (!decl) continue;
      const name = m.childForFieldName('name')?.text ?? '';
      result.types.set(name, [...(result.types.get(name) ?? []), decl]);
    }
    // A class that names no superclass extends the one its kind gives it (8.1.4, 8.9, 8.10); an interface has Object's public members (9.2).
    if (superclassOf(t.node) === null) {
      const given = INHERITED[t.kind];
      for (const n of [...(given?.types ?? []), ...(given?.fields ?? [])]) result.builtin.add(n);
    }
    const inSeen = new Set(seen).add(t);
    for (const sup of supertypesOf(t.node)) {
      const name = simpleTypeName(sup);
      const found = name === null ? null : typeNamed(name, t.outer, inSeen);
      if (found === null || found === 'builtin') return null;
      const inherited = membersOf(found, inSeen);
      if (inherited === null) return null;
      for (const [n, ds] of inherited.types) result.types.set(n, [...(result.types.get(n) ?? []), ...ds]);
      for (const n of inherited.builtin) result.builtin.add(n);
    }
    return result;
  };

  // The type a simple name means where `from` is the innermost type around it (6.5.5.1, 6.4.1): a
  // member type of a type around it, from the innermost out, then a top-level type of the file,
  // then a single-type import, then `java.lang`, which every file imports on demand (7.3). A type of
  // the file, `builtin` for java.lang's, or null when the rules cannot prove which.
  const typeNamed = (name: string, from: TypeDecl | null, seen: ReadonlySet<TypeDecl> = new Set()): TypeDecl | 'builtin' | null => {
    if (hiding.has(name)) return null;
    for (let t = from; t !== null; t = t.outer) {
      const members = membersOf(t, seen);
      if (members === null || members.builtin.has(name)) return null;
      const found = members.types.get(name);
      if (found) return found.length === 1 ? found[0]! : null;
    }
    const top = topTypes.get(name);
    if (top) return top;
    if (imports.types.has(name) || imports.statics.has(name)) return null;
    return JAVA_LANG_TYPES.has(name) ? 'builtin' : null;
  };

  /** The methods a type declares by `name`, as nodes. */
  const declaredMethods = (t: TypeDecl, name: string): number[] =>
    bodyMembers(t.node)
      .filter((m) => INVOKED.has(m.type) && m.childForFieldName('name')?.text === name)
      .map((m) => callables.get(m.id))
      .filter((s): s is number => s !== undefined);

  /** The names of a record's components, each of which has an accessor of that name (8.10.3). */
  const componentsOf = (t: TypeDecl): Set<string> =>
    new Set(
      named(t.node.childForFieldName('parameters') ?? t.node)
        .filter((p) => p.type === 'formal_parameter')
        .map((p) => p.childForFieldName('name')?.text ?? ''),
    );

  // The method a simple method name calls (15.12.1): the innermost type around the call of which a
  // method of that name is a member, from the innermost out. With no supertype named, a type's
  // methods are what it declares and what its kind's built-in supertype gives it. One method it
  // declares by that name is the call's method, when nothing it inherits has the name (15.12.2 chooses
  // among several by the arguments' types); a name only the built-in supertype gives is outside.
  const methodNamed = (name: string, from: TypeDecl | null, thisOnly: boolean): CallMark => {
    for (let t = from; t !== null; t = thisOnly ? null : t.outer) {
      if (t.kind === null || supertypesOf(t.node).length > 0) return {};
      const declared = declaredMethods(t, name);
      if (t.kind === 'enum' && ENUM_IMPLICIT_METHODS.has(name)) return {};
      if (t.kind === 'record' && declared.length === 0 && (componentsOf(t).has(name) || RECORD_IMPLICIT_METHODS.has(name))) return {};
      const given = INHERITED[t.kind]?.methods;
      if (declared.length > 0) return declared.length === 1 && !given?.has(name) ? { target: declared[0]! } : {};
      if (given?.has(name)) return { outside: { kind: 'builtin', name } };
    }
    return {};
  };

  const markOf = (call: Node, from: TypeDecl | null): { name: Node; hint: string | null; mark: CallMark } | null => {
    if (call.type === 'method_invocation') {
      const name = call.childForFieldName('name');
      if (!name) return null;
      const object = call.childForFieldName('object');
      if (!object) return { name, hint: null, mark: methodNamed(name.text, from, false) };
      const hint = memberHint(object.text);
      if (object.type === 'this') return { name, hint, mark: methodNamed(name.text, from, true) };
      // `T.m()`: a simple name that is no variable is a type (6.5.2); java.lang's type is outside.
      if (object.type === 'identifier' && !variables.has(object.text) && !imports.statics.has(object.text) && !imports.staticOnDemand) {
        const type = typeNamed(object.text, from);
        if (type === 'builtin') return { name, hint, mark: { outside: { kind: 'builtin', name: object.text } } };
      }
      return { name, hint, mark: {} };
    }
    if (call.type === 'explicit_constructor_invocation') {
      const name = call.childForFieldName('constructor');
      if (!name || call.childForFieldName('object') || from === null || from.kind === null) return name ? { name, hint: null, mark: {} } : null;
      // `this(…)` invokes a constructor of the class itself, `super(…)` one of its superclass (8.8.7.1).
      if (name.type === 'this') return { name, hint: null, mark: { target: from.symbol } };
      const sup = superclassOf(from.node);
      if (sup === null) return { name, hint: null, mark: from.kind === 'class' ? { outside: { kind: 'builtin', name: OBJECT } } : {} };
      const supName = simpleTypeName(sup);
      // The superclass is named in the scope around the class, not in its own body (6.3).
      const found = supName === null ? null : typeNamed(supName, from.outer);
      const mark: CallMark = found === null ? {} : found === 'builtin' ? { outside: { kind: 'builtin', name: supName! } } : { target: found.symbol };
      return { name, hint: null, mark };
    }
    // A class instance creation (15.9) calls the class it names, unless it makes an anonymous class
    // or names its class through an outer object (15.9.1).
    const name = createdName(call);
    if (!name) return null;
    const plain = call.childForFieldName('body') === null && named(call).every((c) => c.type !== 'class_body') && call.child(0)?.type === 'new';
    const simple = call.childForFieldName('type')?.type !== 'scoped_type_identifier' && simpleTypeName(call.childForFieldName('type')) !== null;
    if (!plain || !simple) return { name, hint: null, mark: {} };
    const found = typeNamed(name.text, from);
    const mark: CallMark = found === null ? {} : found === 'builtin' ? { outside: { kind: 'builtin', name: name.text } } : { target: found.symbol };
    return { name, hint: null, mark };
  };

  for (const { call, scope, type } of pending) {
    const c = markOf(call, type);
    if (!c) continue;
    // No call is linked by its name alone: what the language's rules prove is its target.
    out.edge(scope, 'calls', c.name.text, startLine(c.name), c.hint, 'value', undefined, { pos: c.name.startIndex, ...c.mark });
  }
}

export const java: LanguageModule = {
  name: 'java',
  extensions: ['java'],
  grammar: javaWasm,
  comment: 'slash',
  extract: (file, out) => extractJava(syntaxTree(file), file.src, out, file.module),
};
