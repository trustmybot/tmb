// TypeScript, TSX and JavaScript (trustmybot/tmb#157): which definitions each file holds, the
// container of each, and the calls, imports and value references each makes, in one walk of
// the tree. What counts as a function here is in README.md beside this file.
import type { Node } from 'web-tree-sitter';
import { type Collector, type EdgeKind, type ExtractedSymbol, type FunctionParams, type ParamInfo, type SourceFile, type SymbolKind } from '../contract.ts';
import { clip, DOC_MAX, docOf, memberHint, named, normalizedHash, oneLine, signatureOf } from '../kit.ts';
import { extractSqlDdl, sqlRefs } from '../others/index.ts';

const STRING_PARTS = new Set(['string_fragment', 'escape_sequence']);

// The text of a `description:` value built from string literals, joined
// across `+` concatenation and template parts; null for any other value.
function descriptionText(pair: Node): string | null {
  if (pair.childForFieldName('key')?.text.replace(/['"]/g, '') !== 'description') return null;
  const value = pair.childForFieldName('value');
  if (!value || !['string', 'template_string', 'binary_expression', 'parenthesized_expression'].includes(value.type)) {
    return null;
  }
  const parts = value
    .descendantsOfType([...STRING_PARTS])
    .filter((n): n is Node => n !== null)
    .map((n) => n.text);
  const text = oneLine(parts.join(''));
  return /[a-z]{3}/i.test(text) ? text : null;
}
const PARAM_NAME_MAX = 80;
const PARAM_TEXT_MAX = 120;

// A type annotation's text without its leading colon, on one line.
const annotationText = (annotation: Node | null): string | null =>
  annotation ? clip(oneLine(annotation.text.replace(/^\s*:/, '')), PARAM_TEXT_MAX) : null;

function paramInfo(name: Node, type: Node | null, questionMark: boolean, value: Node | null): ParamInfo {
  return {
    name: clip(oneLine(name.text), PARAM_NAME_MAX),
    type: annotationText(type),
    // A defaulted parameter may be omitted by a caller, as TypeScript's own
    // declaration output marks it.
    optional: questionMark || value !== null,
    ...(value ? { default: clip(oneLine(value.text), PARAM_TEXT_MAX) } : {}),
  };
}

// One entry of a formal_parameters list: TS required_parameter and
// optional_parameter, or a bare JS pattern. A TS `this` parameter is not an
// argument a caller passes, so it and comments give null.
function paramOf(node: Node): ParamInfo | null {
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    const pattern = node.childForFieldName('pattern');
    if (!pattern || pattern.type === 'this') return null;
    return paramInfo(pattern, node.childForFieldName('type'), node.type === 'optional_parameter', node.childForFieldName('value'));
  }
  if (node.type === 'assignment_pattern') {
    const left = node.childForFieldName('left');
    return left ? paramInfo(left, null, false, node.childForFieldName('right')) : null;
  }
  if (node.type === 'comment') return null;
  return paramInfo(node, null, false, null);
}

// The declared parameters and return type of a function-like node (GH 3176),
// as stored in wm_symbols.params_json. Declared types only: nothing is inferred.
export function functionParams(fn: Node): FunctionParams {
  const single = fn.childForFieldName('parameter');
  const list = fn.childForFieldName('parameters');
  const nodes = single ? [single] : list ? named(list) : [];
  return {
    params: nodes.map(paramOf).filter((p): p is ParamInfo => p !== null),
    returns: annotationText(fn.childForFieldName('return_type')),
  };
}
const literalText = (node: Node): string | null =>
  node.type === 'string' || (node.type === 'template_string' && !named(node).some((c) => c.type === 'template_substitution'))
    ? node.text.slice(1, -1)
    : null;
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function']);
const annotatedType = (node: Node): string | undefined => {
  const t = node.childForFieldName('type')?.namedChildren[0];
  return t?.type === 'type_identifier' ? t.text : undefined;
};


// Receiver text to its declared or constructed class, per file, ignoring
// scope; a receiver seen with two different types is dropped.
function receiverTypes(root: Node): Map<string, string> {
  const seen = new Map<string, string | null>();
  const add = (key: string, type: string | undefined): void => {
    if (!type) return;
    const prev = seen.get(key);
    seen.set(key, prev === undefined || prev === type ? type : null);
  };
  for (const d of root.descendantsOfType('variable_declarator')) {
    const n = d?.childForFieldName('name');
    if (n?.type !== 'identifier') continue;
    const value = d!.childForFieldName('value');
    const ctor = value?.type === 'new_expression' ? value.childForFieldName('constructor') : null;
    add(n.text, annotatedType(d!) ?? (ctor?.type === 'identifier' ? ctor.text : undefined));
  }
  for (const p of root.descendantsOfType(['required_parameter', 'optional_parameter'])) {
    const n = p?.childForFieldName('pattern');
    if (n?.type !== 'identifier') continue;
    const type = annotatedType(p!);
    add(n.text, type);
    if (named(p!).some((c) => c.type === 'accessibility_modifier' || c.type === 'override_modifier') || /^readonly\b/.test(p!.text)) {
      add(`this.${n.text}`, type);
    }
  }
  for (const f of root.descendantsOfType('public_field_definition')) {
    const n = f?.childForFieldName('name');
    if (n?.type === 'property_identifier' || n?.type === 'private_property_identifier') add(`this.${n.text}`, annotatedType(f!));
  }
  const types = new Map<string, string>();
  for (const [k, v] of seen) if (v) types.set(k, v);
  return types;
}

interface ModuleBindings {
  aliases: Map<string, string>;
  names: Set<string>;
}

const importSource = (specifier: Node): string | undefined => {
  let stmt: Node | null = specifier.parent;
  while (stmt && stmt.type !== 'import_statement') stmt = stmt.parent;
  return stmt?.childForFieldName('source')?.text.slice(1, -1);
};

// The names an identifier may reference by value (GH 1988): each named import
// binding and each module-level function, class or function-valued const. An
// `import { A as B }` alias maps back to `A` only for a relative import of a
// name the file does not declare itself, so the edge resolves through the
// `imports` hint and never to an external module's name or a same-file `A`.
function moduleBindings(root: Node): ModuleBindings {
  const aliases = new Map<string, string>();
  const names = new Set<string>();
  const declared = new Set<string>();
  for (const s of root.descendantsOfType('import_specifier')) {
    const n = s?.childForFieldName('name')?.text;
    if (!n) continue;
    const alias = s!.childForFieldName('alias')?.text;
    names.add(alias ?? n);
    if (alias && importSource(s!)?.startsWith('.')) aliases.set(alias, n);
  }
  for (const top of named(root)) {
    const decl = top.type === 'export_statement' ? top.childForFieldName('declaration') : top;
    if (!decl) continue;
    if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
      for (const d of named(decl)) {
        const n = d.childForFieldName('name');
        if (n?.type !== 'identifier') continue;
        declared.add(n.text);
        const value = d.childForFieldName('value');
        if (value && FUNCTION_VALUES.has(value.type)) names.add(n.text);
      }
      continue;
    }
    const n = decl.childForFieldName('name')?.text;
    if (!n) continue;
    declared.add(n);
    if (MODULE_CALLABLES.has(decl.type)) names.add(n);
  }
  for (const [alias, original] of aliases) if (declared.has(original)) aliases.delete(alias);
  return { aliases, names };
}

const MODULE_CALLABLES = new Set(['function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration']);
const FUNCTION_SCOPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
const BLOCK_SCOPES = new Set(['statement_block', 'switch_case', 'switch_default']);
const PATTERN_NAMES = ['identifier', 'shorthand_property_identifier_pattern'];

const bindsName = (pattern: Node | null, name: string): boolean =>
  pattern !== null &&
  (PATTERN_NAMES.includes(pattern.type) ? pattern.text === name : pattern.descendantsOfType(PATTERN_NAMES).some((p) => p?.text === name));

const declaresName = (stmt: Node, name: string): boolean => {
  if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
    return named(stmt).some((d) => d.type === 'variable_declarator' && bindsName(d.childForFieldName('name'), name));
  }
  return MODULE_CALLABLES.has(stmt.type) && stmt.childForFieldName('name')?.text === name;
};

// Whether a parameter or a declaration in an enclosing function or block,
// below the module, binds the name `node` reads.
function shadowed(node: Node, name: string): boolean {
  for (let a = node.parent; a && a.type !== 'program'; a = a.parent) {
    if (FUNCTION_SCOPES.has(a.type)) {
      if (bindsName(a.childForFieldName('parameters') ?? a.childForFieldName('parameter'), name)) return true;
      if (a.type !== 'function_declaration' && a.type !== 'generator_function_declaration' && a.childForFieldName('name')?.text === name) return true;
    } else if (BLOCK_SCOPES.has(a.type)) {
      if (named(a).some((s) => declaresName(s, name))) return true;
    } else if (a.type === 'for_statement') {
      const init = a.childForFieldName('initializer');
      if (init && declaresName(init, name)) return true;
    } else if (a.type === 'for_in_statement') {
      if (a.childForFieldName('kind') && bindsName(a.childForFieldName('left'), name)) return true;
    } else if (a.type === 'catch_clause') {
      if (bindsName(a.childForFieldName('parameter'), name)) return true;
    }
  }
  return false;
}

const isField = (parent: Node, field: string, node: Node): boolean => parent.childForFieldName(field)?.id === node.id;

// Whether an identifier sits where it is read as a value (GH 1988): a call
// argument, an object property value, an array element, an assigned or
// initial value, a return value, a local export specifier or a default export.
function inValuePosition(node: Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (node.type === 'shorthand_property_identifier') return p.type === 'object';
  switch (p.type) {
    case 'arguments':
    case 'array':
    case 'return_statement':
      return true;
    case 'pair':
    case 'variable_declarator':
      return isField(p, 'value', node);
    case 'assignment_expression':
      return isField(p, 'right', node);
    case 'export_statement':
      return isField(p, 'value', node);
    case 'export_specifier':
      return isField(p, 'name', node) && !p.parent?.parent?.childForFieldName('source');
    default:
      return false;
  }
}

// Every node that is one function when it has a body (trustmybot/tmb#140): a
// declaration, an expression, an arrow, a generator, and a method of a class
// or of an object, its constructor, getters and setters included. A signature
// with no body parses as another node type, so it is never one.
const FUNCTION_NODES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
// Expressions that wrap a value without changing which value it is.
const VALUE_WRAPPERS = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion']);
const UNNAMED_LABEL_MAX = 80;

type FunctionName = {
  kind: 'function' | 'method';
  name: string;
  unnamed: boolean;
  reach?: 'member';
  // Where its doc comment and signature start: the declaration that binds it.
  anchor: Node;
};

// The name a call's callee goes by: an identifier, or a member's property.
function calleeName(call: Node): string | null {
  const fn = call.childForFieldName(call.type === 'new_expression' ? 'constructor' : 'function');
  if (fn?.type === 'identifier') return fn.text;
  if (fn?.type === 'member_expression') return fn.childForFieldName('property')?.text ?? null;
  return null;
}

// A key's name: an identifier, a string literal, or a computed `["literal"]`; else its text.
function keyText(key: Node): string {
  if (key.type === 'property_identifier') return key.text;
  const inner = key.type === 'computed_property_name' ? named(key)[0] : key;
  return (inner ? literalText(inner) : null) ?? oneLine(key.text);
}

// A function's name: the name it binds or is bound to (`const f = …`, an
// object's `key: …`, a class field, an assignment's target), else its own
// name, else where it is used: "callback of `map`", and with a string first
// argument, "callback of `test` 'lists open tasks'"; else "function at line N".
function functionName(fn: Node, cls: string | null): FunctionName {
  const own = fn.childForFieldName('name');
  if (fn.type === 'method_definition') {
    const name = own ? keyText(own) : `method at line ${fn.startPosition.row + 1}`;
    if (fn.parent?.type === 'class_body') return { kind: 'method', name: cls ? `${cls}.${name}` : name, unnamed: false, anchor: fn };
    return { kind: 'function', name, unnamed: false, reach: 'member', anchor: fn };
  }
  let at = fn;
  let p = fn.parent;
  while (p && VALUE_WRAPPERS.has(p.type)) {
    at = p;
    p = p.parent;
  }
  if (p?.type === 'variable_declarator' && isField(p, 'value', at)) {
    const n = p.childForFieldName('name');
    if (n?.type === 'identifier') return { kind: 'function', name: n.text, unnamed: false, anchor: p.parent ?? p };
  } else if (p?.type === 'pair' && isField(p, 'value', at)) {
    const key = p.childForFieldName('key');
    if (key) return { kind: 'function', name: keyText(key), unnamed: false, reach: 'member', anchor: p };
  } else if ((p?.type === 'public_field_definition' || p?.type === 'field_definition') && isField(p, 'value', at)) {
    const n = p.childForFieldName('name') ?? p.childForFieldName('property');
    if (n) return { kind: 'method', name: cls ? `${cls}.${keyText(n)}` : keyText(n), unnamed: false, anchor: p };
  } else if (p?.type === 'assignment_expression' && isField(p, 'right', at)) {
    const left = p.childForFieldName('left');
    const n = left?.type === 'member_expression' ? left.childForFieldName('property') : left?.type === 'identifier' ? left : null;
    if (n) return { kind: 'function', name: n.text, unnamed: false, ...(left?.type === 'member_expression' ? { reach: 'member' as const } : {}), anchor: p.parent ?? p };
  }
  if (own) return { kind: 'function', name: own.text, unnamed: false, anchor: fn };
  const unnamed = (name: string): FunctionName => ({ kind: 'function', name: clip(name, UNNAMED_LABEL_MAX + 40), unnamed: true, anchor: fn });
  if (p?.type === 'arguments' && p.parent) {
    const callee = calleeName(p.parent);
    if (callee) {
      const first = named(p)[0];
      const label = first && first.id !== at.id ? literalText(first) : null;
      return unnamed(`callback of \`${callee}\`${label === null ? '' : ` '${clip(oneLine(label), UNNAMED_LABEL_MAX)}'`}`);
    }
  }
  if (p?.type === 'jsx_expression' && p.parent?.type === 'jsx_attribute') {
    const attr = named(p.parent)[0]?.text;
    if (attr) return unnamed(`callback of \`${attr}\``);
  }
  if (p?.type === 'export_statement') return unnamed('default export');
  return unnamed(`function at line ${fn.startPosition.row + 1}`);
}

// TS/JS, in one walk. `scope` is the symbol a reference made here starts at:
// the innermost function, unnamed ones included, or a class or module-level
// const. `container` is what contains a symbol defined here (a function, a
// class or the file), and `owner` the nearest named scope, which lookups name
// for the unnamed functions inside it.
export function extractTs(file: SourceFile, out: Collector): void {
  const { src, module: moduleSymbol } = file;
  const root = file.root;
  if (!root) throw new Error(`no syntax tree for ${file.relPath}`);
  const types = receiverTypes(root);
  const bindings = moduleBindings(root);
  const target = (name: string): string => bindings.aliases.get(name) ?? name;
  const referenced = new Set<string>();
  const reference = (scope: number, kind: EdgeKind, name: string, at: Node): void => {
    const dst = target(name);
    const key = `${scope}\u0000${kind}\u0000${dst}`;
    if (referenced.has(key)) return;
    referenced.add(key);
    out.edge(scope, kind, dst, at.startPosition.row + 1);
  };
  const boundValue = (node: Node, name: string): boolean => bindings.names.has(name) && !shadowed(node, name);
  const definition = (node: Node, kind: SymbolKind, qualifiedName: string, parent: number): number =>
    out.symbol({
      kind,
      qualified_name: qualifiedName,
      signature: signatureOf(node, src),
      doc: docOf(node),
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      body_hash: normalizedHash(node),
      exported: node.parent?.type === 'export_statement' ? 1 : 0,
      parent,
      ...(kind === 'function' || kind === 'method' ? { params_json: JSON.stringify(functionParams(node)) } : {}),
    });
  // Functions whose symbol was made before the walk reached them: a module-level
  // `const f = () => …`, and a registration's handler.
  const made = new Map<number, number>();
  const fnKey = (fn: Node): string => `fn\u0000${fn.startIndex}`;

  const visit = (node: Node, scope: number, cls: string | null, container: number, owner: number): void => {
    let inner = scope;
    let innerCls = cls;
    let innerContainer = container;
    let innerOwner = owner;
    const t = node.type;
    const name = (): string | undefined => node.childForFieldName('name')?.text;
    if (FUNCTION_NODES.has(t)) {
      const known = made.get(node.id);
      if (known !== undefined) {
        inner = known;
        innerContainer = known;
      } else {
        const fn = functionName(node, cls);
        const body = node.childForFieldName('body');
        const anchor = fn.unnamed ? node : fn.anchor;
        inner = out.symbol(
          {
            kind: fn.kind,
            qualified_name: fn.name,
            signature: clip(oneLine(src.slice(anchor.startIndex, body ? body.startIndex : Math.min(node.endIndex, anchor.startIndex + 160))), 200),
            doc: fn.unnamed ? '' : docOf(anchor),
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
            body_hash: normalizedHash(node),
            exported: anchor.parent?.type === 'export_statement' || node.parent?.type === 'export_statement' ? 1 : 0,
            params_json: JSON.stringify(functionParams(node)),
            parent: container,
            ...(fn.unnamed ? { unnamed: 1, owner } : {}),
            ...(fn.reach ? { reach: fn.reach } : container !== moduleSymbol && out.symbols[container]?.kind !== 'class' ? { reach: 'nested' as const } : {}),
          },
          fnKey(node),
        );
        innerContainer = inner;
        if (!fn.unnamed) innerOwner = inner;
      }
    } else if (t === 'class_declaration' || t === 'abstract_class_declaration') {
      const n = name();
      if (n) {
        inner = definition(node, 'class', n, container);
        innerCls = n;
        innerContainer = inner;
        innerOwner = inner;
      }
    } else if (t === 'class') {
      innerCls = null;
    } else if (t === 'interface_declaration') {
      const n = name();
      if (n) definition(node, 'interface', n, container);
    } else if (t === 'type_alias_declaration' || t === 'enum_declaration') {
      const n = name();
      if (n) definition(node, 'type', n, container);
    } else if (t === 'variable_declarator' && scope === moduleSymbol) {
      const decl = node.parent;
      const holder = decl?.parent?.type;
      const n = node.childForFieldName('name');
      if (decl && (holder === 'program' || holder === 'export_statement') && n?.type === 'identifier') {
        let value = node.childForFieldName('value');
        while (value && VALUE_WRAPPERS.has(value.type)) value = value.namedChildren[0] ?? null;
        const isFn = value !== null && FUNCTION_NODES.has(value.type);
        const bodyStart = value?.type === 'arrow_function' ? value.childForFieldName('body')?.startIndex : undefined;
        const symbol: ExtractedSymbol = {
          kind: isFn ? 'function' : 'const',
          qualified_name: n.text,
          signature: clip(oneLine(src.slice(decl.startIndex, bodyStart ?? Math.min(decl.endIndex, decl.startIndex + 140))), 200),
          doc: docOf(decl),
          start_line: (isFn ? value! : decl).startPosition.row + 1,
          end_line: (isFn ? value! : decl).endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: holder === 'export_statement' ? 1 : 0,
          parent: moduleSymbol,
          ...(isFn ? { params_json: JSON.stringify(functionParams(value!)) } : {}),
        };
        inner = isFn ? out.symbol(symbol, fnKey(value!)) : out.symbol(symbol);
        innerOwner = inner;
        if (isFn) made.set(value!.id, inner);
      }
    } else if (t === 'call_expression' || t === 'new_expression') {
      const fn = node.childForFieldName(t === 'call_expression' ? 'function' : 'constructor');
      let callee: string | undefined;
      let receiver: string | undefined;
      if (fn?.type === 'identifier') callee = target(fn.text);
      else if (fn?.type === 'member_expression') {
        callee = fn.childForFieldName('property')?.text;
        const objectNode = fn.childForFieldName('object');
        const object = objectNode?.text;
        if (objectNode?.type === 'identifier' && object !== undefined) {
          receiver = types.get(object) ?? target(object);
          if (/^[A-Z]/.test(object) && boundValue(objectNode, object)) reference(scope, 'calls', object, objectNode);
        } else receiver = object !== undefined ? (types.get(object) ?? object) : undefined;
      }
      if (callee) {
        out.edge(
          scope,
          t === 'call_expression' ? 'calls' : 'instantiates',
          callee,
          node.startPosition.row + 1,
          receiver === undefined ? null : memberHint(receiver),
        );
      }
    } else if (t === 'import_statement') {
      const spec = node.childForFieldName('source')?.text.slice(1, -1) ?? null;
      for (const s of node.descendantsOfType('import_specifier')) {
        const n = s?.childForFieldName('name')?.text;
        if (n) out.edge(moduleSymbol, 'imports', n, node.startPosition.row + 1, spec);
      }
      return;
    } else if (t === 'pair') {
      if (owner !== moduleSymbol) {
        const text = descriptionText(node);
        const ownerRow = out.symbols[owner];
        if (text && ownerRow) ownerRow.doc = clip(ownerRow.doc ? `${ownerRow.doc} ${text}` : text, DOC_MAX);
      }
    } else if (t === 'identifier' || t === 'shorthand_property_identifier') {
      if (inValuePosition(node) && boundValue(node, node.text)) reference(scope, 'calls', node.text, node);
    } else if (t === 'extends_clause') {
      const base = node.childForFieldName('value');
      if (base?.type === 'identifier') out.edge(scope, 'instantiates', target(base.text), base.startPosition.row + 1);
    } else if (t === 'jsx_opening_element' || t === 'jsx_self_closing_element') {
      const tag = node.childForFieldName('name');
      if (tag?.type === 'identifier' && /^[A-Z]/.test(tag.text)) reference(scope, 'instantiates', tag.text, tag);
    } else if (t === 'string' || t === 'template_string') {
      const text = node.text;
      const line = node.startPosition.row + 1;
      for (const [kind, table] of sqlRefs(text)) out.edge(scope, kind, table, line);
      if (/CREATE\s+(VIRTUAL\s+)?TABLE/i.test(text)) extractSqlDdl(text, out, null, node.startPosition.row);
    }
    for (const c of named(node)) visit(c, inner, innerCls, innerContainer, innerOwner);
  };
  visit(root, moduleSymbol, null, moduleSymbol, moduleSymbol);
}
