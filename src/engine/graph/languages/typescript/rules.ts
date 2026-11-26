// TypeScript, TSX and JavaScript (trustmybot/tmb#157): which definitions each file holds, the
// container of each, and the calls, imports and value references each makes, in one walk of
// the tree. What counts as a function here is in README.md beside this file.
import type { Node } from 'web-tree-sitter';
import { type Bound, type CallMark, type Collector, type EdgeKind, type ExtractedSymbol, type FunctionParams, type ParamInfo, type SourceFile, type SymbolKind } from '../contract.ts';
import { clip, DOC_MAX, docOf, memberHint, named, normalizedHash, oneLine, signatureOf } from '../kit.ts';
import { extractSqlDdl, sqlRefs } from '../sql/index.ts';
import { GLOBALS } from './globals.ts';

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
    if (isParameterProperty(p!)) {
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
// Whether a pattern binds `name`: a plain name, or one inside a destructuring, a default or a
// rest. A default value, a key and a type annotation bind nothing.
function bindsName(pattern: Node | null, name: string): boolean {
  if (pattern === null) return false;
  switch (pattern.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      return pattern.text === name;
    case 'required_parameter':
    case 'optional_parameter':
      return bindsName(pattern.childForFieldName('pattern'), name);
    case 'assignment_pattern':
    case 'object_assignment_pattern':
      return bindsName(pattern.childForFieldName('left'), name);
    case 'pair_pattern':
      return bindsName(pattern.childForFieldName('value'), name);
    case 'rest_pattern':
    case 'object_pattern':
    case 'array_pattern':
    case 'formal_parameters':
      return named(pattern).some((c) => bindsName(c, name));
    default:
      return false;
  }
}

/**
 * How a name is bound below the module, where the language looks before the file's own names:
 * a function or class declared there, with the line its symbol starts on, or any other value.
 */
type LocalBinding = { bound: 'function'; line: number } | { bound: 'value' };

const VALUE: LocalBinding = { bound: 'value' };
const lineOf = (node: Node): number => node.startPosition.row + 1;

// How a statement of a block binds `name`, or null when it does not: a function or class
// declared there, or a `const f = () => …`, is a function; any other variable is a value.
const declaredAs = (stmt: Node, name: string): LocalBinding | null => {
  if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
    for (const d of named(stmt)) {
      if (d.type !== 'variable_declarator' || !bindsName(d.childForFieldName('name'), name)) continue;
      const value = unwrapped(d.childForFieldName('value'));
      return d.childForFieldName('name')?.type === 'identifier' && value !== null && FUNCTION_NODES.has(value.type)
        ? { bound: 'function', line: lineOf(value) }
        : VALUE;
    }
    return null;
  }
  return MODULE_CALLABLES.has(stmt.type) && stmt.childForFieldName('name')?.text === name ? { bound: 'function', line: lineOf(stmt) } : null;
};

// How a parameter or a declaration of an enclosing function or block, below the module, binds
// the name `node` reads (trustmybot/tmb#246); null when none does, so the file's own names and
// its imports answer for it. The innermost binding decides.
function localBinding(node: Node, name: string): LocalBinding | null {
  for (let a = node.parent; a && a.type !== 'program'; a = a.parent) {
    if (FUNCTION_SCOPES.has(a.type)) {
      if (bindsName(a.childForFieldName('parameters') ?? a.childForFieldName('parameter'), name)) return VALUE;
      // A declaration's name and a method's name bind nothing inside it; a function expression's own name does.
      if (!NAME_BINDS_OUTSIDE.has(a.type) && a.childForFieldName('name')?.text === name) return { bound: 'function', line: lineOf(a) };
    } else if (BLOCK_SCOPES.has(a.type)) {
      for (const s of named(a)) {
        const bound = declaredAs(s, name);
        if (bound !== null) return bound;
      }
    } else if (a.type === 'for_statement') {
      const init = a.childForFieldName('initializer');
      if (init && declaredAs(init, name) !== null) return VALUE;
    } else if (a.type === 'for_in_statement') {
      if (a.childForFieldName('kind') && bindsName(a.childForFieldName('left'), name)) return VALUE;
    } else if (a.type === 'catch_clause') {
      if (bindsName(a.childForFieldName('parameter'), name)) return VALUE;
    }
  }
  return null;
}

const NAME_BINDS_OUTSIDE = new Set(['function_declaration', 'generator_function_declaration', 'method_definition']);

const unwrapped = (node: Node | null): Node | null => {
  let value = node;
  while (value && VALUE_WRAPPERS.has(value.type)) value = value.namedChildren[0] ?? null;
  return value;
};

// The class a `this` inside it is an instance of: the nearest function around it that is no
// arrow, when that is a method of a class, or a class's field or static block. Null outside
// a class, inside a plain function, and in a class that has no name (trustmybot/tmb#246).
function thisClass(node: Node): Node | null {
  for (let a = node.parent; a; a = a.parent) {
    if (a.type === 'arrow_function') continue;
    if (a.type === 'class_body') {
      const cls = a.parent;
      return cls && (cls.type === 'class_declaration' || cls.type === 'abstract_class_declaration') ? cls : null;
    }
    if (FUNCTION_SCOPES.has(a.type) && !(a.type === 'method_definition' && a.parent?.type === 'class_body')) return null;
    if (a.type === 'program') return null;
  }
  return null;
}

// How a class's own body declares a member: a method, or a field whose value is a function, is
// a function; a field with any other value or none, or a signature with no body, is a value;
// null when the body declares no member of that name.
function memberOf(cls: Node, name: string): 'function' | 'value' | null {
  let bound: 'value' | null = null;
  for (const m of named(cls.childForFieldName('body') ?? cls)) {
    const key = m.childForFieldName('name') ?? m.childForFieldName('property');
    if (!key || keyText(key) !== name) continue;
    if (m.type === 'method_definition') return 'function';
    if (m.type === 'public_field_definition' || m.type === 'field_definition') {
      const value = unwrapped(m.childForFieldName('value'));
      if (value !== null && FUNCTION_NODES.has(value.type)) return 'function';
    }
    bound = 'value';
  }
  return bound;
}

// The bases a class names in its `extends`: a plain name as the file binds it, which the resolver
// looks up through the file's imports (trustmybot/tmb#287), else '' for one that is no plain name.
function basesOf(cls: Node): string[] {
  const heritage = named(cls).find((c) => c.type === 'class_heritage');
  const ext = heritage ? named(heritage).find((c) => c.type === 'extends_clause') : undefined;
  const value = ext?.childForFieldName('value');
  if (!value) return [];
  return [value.type === 'identifier' ? value.text : ''];
}

// Whether a constructor parameter declares a field too: `private x`, `readonly x`, `override x`.
const isParameterProperty = (p: Node): boolean =>
  named(p).some((c) => c.type === 'accessibility_modifier' || c.type === 'override_modifier') || /^readonly\b/.test(p.text);

// The names a class binds on its objects to anything but a method (trustmybot/tmb#287): a member
// of its body that memberOf calls a value, a constructor's parameter property, and a name its own
// methods assign on `this` that its body does not declare. Each hides a parent's method.
function fieldsOf(cls: Node): string[] {
  const body = cls.childForFieldName('body');
  if (!body) return [];
  const declared = new Set<string>();
  const fields = new Set<string>();
  for (const m of named(body)) {
    const key = m.childForFieldName('name') ?? m.childForFieldName('property');
    if (key) declared.add(keyText(key));
    if (m.type !== 'method_definition' || !key || keyText(key) !== 'constructor') continue;
    const params = m.childForFieldName('parameters');
    for (const p of params ? named(params) : []) {
      const n = p.childForFieldName('pattern');
      if (n?.type === 'identifier' && isParameterProperty(p)) fields.add(n.text);
    }
  }
  for (const n of declared) if (memberOf(cls, n) === 'value') fields.add(n);
  for (const a of body.descendantsOfType('assignment_expression')) {
    const left = a?.childForFieldName('left');
    const object = left?.type === 'member_expression' ? left.childForFieldName('object') : null;
    const property = left?.childForFieldName('property');
    if (object?.type !== 'this' || !property || declared.has(property.text) || thisClass(object)?.id !== cls.id) continue;
    fields.add(property.text);
  }
  return [...fields].sort();
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

// The names an export statement gives other files without declaring them (trustmybot/tmb#233):
// `export { f as g } from`, `export * from`, `export * as ns from`, and `export { g }` of a
// name the file imports or declares under another name. `imported` is each named import's
// local name to the name and module it comes from.
function reexports(stmt: Node, imported: Map<string, { name: string; source: string }>, out: Collector): void {
  const source = stmt.childForFieldName('source');
  const spec = source ? literalText(source) : null;
  if (source && spec === null) return;
  const namespace = named(stmt).find((c) => c.type === 'namespace_export');
  if (spec !== null && namespace) {
    const name = named(namespace).find((c) => c.type === 'identifier')?.text;
    if (name) out.export({ kind: 'namespace', name, source: spec });
    return;
  }
  const clause = named(stmt).find((c) => c.type === 'export_clause');
  if (spec !== null && !clause) {
    if (stmt.children.some((c) => c?.type === '*')) out.export({ kind: 'star', source: spec });
    return;
  }
  for (const s of clause ? named(clause) : []) {
    if (s.type !== 'export_specifier') continue;
    const original = s.childForFieldName('name');
    if (original?.type !== 'identifier') continue;
    const name = s.childForFieldName('alias')?.text ?? original.text;
    if (spec !== null) {
      out.export({ kind: 'name', name, original: original.text, source: spec });
      continue;
    }
    const from = imported.get(original.text);
    if (from) out.export({ kind: 'name', name, original: from.name, source: from.source });
    else if (name !== original.text) out.export({ kind: 'name', name, original: original.text, source: null });
  }
}

// What a file binds that a call's lookup reaches after the functions and blocks around it
// (trustmybot/tmb#252): each name an import of the file binds, with its module, and every name
// any declaration of the file binds, wherever it is. A `var` or a function declared in a block
// belongs to the function or file around it, so a name declared anywhere in the file is never
// proven to be a global.
type FileNames = { imports: Map<string, string>; declared: Set<string> };

const DECLARATIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'class_declaration',
  'abstract_class_declaration',
  'enum_declaration',
  'internal_module',
  'module',
  'import_alias',
]);

// Every name a pattern binds: a plain name, or each name inside a destructuring, a default or a rest.
function patternNames(pattern: Node | null, into: Set<string>): void {
  if (pattern === null) return;
  if (pattern.type === 'identifier' || pattern.type === 'shorthand_property_identifier_pattern') into.add(pattern.text);
  else if (pattern.type === 'assignment_pattern' || pattern.type === 'object_assignment_pattern') patternNames(pattern.childForFieldName('left'), into);
  else if (pattern.type === 'pair_pattern') patternNames(pattern.childForFieldName('value'), into);
  else if (pattern.type === 'rest_pattern' || pattern.type === 'object_pattern' || pattern.type === 'array_pattern') for (const c of named(pattern)) patternNames(c, into);
}

function fileNames(root: Node): FileNames {
  const imports = new Map<string, string>();
  const declared = new Set<string>();
  for (const stmt of root.descendantsOfType('import_statement')) {
    const source = stmt?.childForFieldName('source');
    const spec = source ? literalText(source) : null;
    const clause = stmt ? named(stmt).find((c) => c.type === 'import_clause') : undefined;
    for (const c of clause ? named(clause) : []) {
      const local =
        c.type === 'identifier'
          ? [c.text]
          : c.type === 'namespace_import'
            ? named(c).filter((n) => n.type === 'identifier').map((n) => n.text)
            : c.type === 'named_imports'
              ? named(c).flatMap((s) => {
                  const n = s.childForFieldName('alias') ?? s.childForFieldName('name');
                  return n ? [n.text] : [];
                })
              : [];
      for (const name of local) {
        declared.add(name);
        if (spec !== null) imports.set(name, spec);
      }
    }
    for (const n of stmt ? named(stmt).filter((c) => c.type === 'import_require_clause') : []) {
      const name = named(n).find((c) => c.type === 'identifier');
      if (name) declared.add(name.text);
    }
  }
  for (const d of root.descendantsOfType('variable_declarator')) patternNames(d?.childForFieldName('name') ?? null, declared);
  for (const d of root.descendantsOfType([...DECLARATIONS])) {
    const n = d?.childForFieldName('name');
    if (n) declared.add(n.text);
  }
  return { imports, declared };
}

// `import("m")` written in a type, as in `let d: import("m").T`, names the types of a module and
// runs nothing: the TypeScript handbook's import types. The grammar writes it as a call, so it
// is told apart by where it stands: past the member accesses on it, a type holds it.
function importType(call: Node): boolean {
  if (call.childForFieldName('function')?.type !== 'import') return false;
  let up = call.parent;
  while (up?.type === 'member_expression') up = up.parent;
  return up !== null && up.type !== 'type_assertion' && TYPE_HOLDER.test(up.type);
}

/** The grammar's nodes that hold a type: each names one, such as `type_annotation`, `generic_type` or `type_query`. */
const TYPE_HOLDER = /type/;

/** The longest a call's text is kept as its name when its callee is no name. */
const CALLEE_TEXT_MAX = 80;

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
  const names = fileNames(root);
  // Where a call's lookup ends past the functions, blocks and declarations of the file
  // (trustmybot/tmb#252): an import, with its module, or a global of the compiler's library.
  // `member` is the name called on the object, which the global must declare as callable.
  const outside = (name: string, member?: string): CallMark => {
    const module = names.imports.get(name);
    if (module !== undefined) return module.startsWith('.') ? {} : { outside: { kind: 'import', module } };
    if (names.declared.has(name)) return {};
    const global = GLOBALS.get(name);
    return global !== undefined && (member === undefined || global.has(member)) ? { outside: { kind: 'builtin', name } } : {};
  };
  const imported = new Map<string, { name: string; source: string }>();
  for (const s of root.descendantsOfType('import_specifier')) {
    const n = s?.childForFieldName('name');
    const source = s ? importSource(s) : undefined;
    if (n?.type === 'identifier' && source !== undefined) imported.set(s!.childForFieldName('alias')?.text ?? n.text, { name: n.text, source });
  }
  const target = (name: string): string => bindings.aliases.get(name) ?? name;
  // The module an `import { A as B }` alias was imported from: a reference to `B` is looked up
  // there by `A`, never through the file's other imports of an `A` (trustmybot/tmb#242).
  const aliasSource = (name: string): string | undefined => (bindings.aliases.has(name) ? imported.get(name)?.source : undefined);
  const referenced = new Set<string>();
  // A bare name as the language looks it up (trustmybot/tmb#246): a binding around the
  // reference first, else the file's own names and imports, an import alias by its original name.
  const reference = (scope: number, kind: EdgeKind, name: string, at: Node): void => {
    const local = localBinding(at, name);
    const dst = local === null ? target(name) : name;
    const spec = local === null ? aliasSource(name) : undefined;
    const bound: Bound | undefined = spec !== undefined ? 'import' : local?.bound;
    const hint = spec ?? (local?.bound === 'function' ? String(local.line) : null);
    const key = `${scope}\u0000${kind}\u0000${dst}\u0000${bound ?? ''}\u0000${hint ?? ''}`;
    if (referenced.has(key)) return;
    referenced.add(key);
    out.edge(scope, kind, dst, at.startPosition.row + 1, hint, bound);
  };
  const boundValue = (node: Node, name: string): boolean => bindings.names.has(name) && localBinding(node, name) === null;
  const definition = (node: Node, kind: SymbolKind, qualifiedName: string, parent: number, key?: string): number =>
    out.symbol(
      {
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
      },
      key,
    );
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
        // Each class is its own symbol, so two classes of one name in a file stay two (trustmybot/tmb#287).
        inner = definition(node, 'class', n, container, `class\u0000${node.startIndex}`);
        const bases = basesOf(node);
        if (bases.length > 0) out.symbols[inner]!.bases = bases;
        const fields = fieldsOf(node);
        if (fields.length > 0) out.symbols[inner]!.fields = fields;
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
    } else if ((t === 'call_expression' || t === 'new_expression') && !importType(node)) {
      const fn = node.childForFieldName(t === 'call_expression' ? 'function' : 'constructor');
      let callee: string | undefined;
      let receiver: string | undefined;
      let bound: Bound | undefined;
      let spec: string | undefined;
      let mark: CallMark = {};
      if (fn?.type === 'identifier') {
        const local = localBinding(fn, fn.text);
        spec = local === null ? aliasSource(fn.text) : undefined;
        bound = spec !== undefined ? 'import' : local?.bound;
        callee = local === null ? target(fn.text) : fn.text;
        if (local?.bound === 'function') receiver = String(local.line);
        if (local === null) mark = outside(fn.text);
      } else if (fn?.type === 'member_expression') {
        callee = fn.childForFieldName('property')?.text;
        const objectNode = fn.childForFieldName('object');
        const object = objectNode?.text;
        if (objectNode?.type === 'this' && callee !== undefined) {
          // A call on the object itself is looked up in its class and the class's parents only.
          const of = thisClass(objectNode);
          const own = of === null ? null : (of.childForFieldName('name')?.text ?? null);
          receiver = own ?? 'this';
          if (of !== null && own !== null) bound = memberOf(of, callee) === 'value' ? 'value' : 'self';
        } else if (objectNode?.type === 'identifier' && object !== undefined) {
          // The name as the file binds it: the resolver follows an import under a new name to its file.
          receiver = types.get(object) ?? object;
          if (/^[A-Z]/.test(object) && boundValue(objectNode, object)) reference(scope, 'calls', object, objectNode);
          if (callee !== undefined && localBinding(objectNode, object) === null) mark = outside(object, callee);
        } else receiver = object !== undefined ? (types.get(object) ?? object) : undefined;
      }
      // A call whose callee is no name, such as `f()()` or `handlers[k]()`, is a call all the same:
      // it is named by its callee's text and is not known.
      out.edge(
        scope,
        t === 'call_expression' ? 'calls' : 'instantiates',
        callee ?? clip(oneLine(fn?.text ?? node.text), CALLEE_TEXT_MAX),
        node.startPosition.row + 1,
        spec ?? (callee === undefined || receiver === undefined ? null : memberHint(receiver)),
        callee === undefined ? undefined : bound,
        undefined,
        mark,
      );
    } else if (t === 'export_statement' && node.parent?.type === 'program') {
      reexports(node, imported, out);
    } else if (t === 'import_statement') {
      const spec = node.childForFieldName('source')?.text.slice(1, -1) ?? null;
      for (const s of node.descendantsOfType('import_specifier')) {
        const n = s?.childForFieldName('name')?.text;
        if (n) out.edge(moduleSymbol, 'imports', n, node.startPosition.row + 1, spec, undefined, s!.childForFieldName('alias')?.text);
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
      if (base?.type === 'identifier') reference(scope, 'instantiates', base.text, base);
    } else if (t === 'jsx_opening_element' || t === 'jsx_self_closing_element') {
      const tag = node.childForFieldName('name');
      if (tag?.type === 'identifier' && /^[A-Z]/.test(tag.text)) reference(scope, 'instantiates', tag.text, tag);
    } else if (t === 'string' || t === 'template_string') {
      const text = node.text;
      const line = node.startPosition.row + 1;
      for (const [kind, table] of sqlRefs(text)) out.edge(scope, kind, table, line);
      if (/CREATE\s+(VIRTUAL\s+)?TABLE/i.test(text)) extractSqlDdl(text, out, null, node.startPosition.row);
    }
    // A decorator runs when the thing it decorates is defined, so its call belongs to what
    // encloses that thing: the type for a method, the file for a top-level type.
    for (const c of named(node)) {
      if (c.type === 'decorator') visit(c, scope, cls, container, owner);
      else visit(c, inner, innerCls, innerContainer, innerOwner);
    }
  };
  visit(root, moduleSymbol, null, moduleSymbol, moduleSymbol);
}
