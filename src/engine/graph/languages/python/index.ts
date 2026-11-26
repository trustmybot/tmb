// Python, read through tree-sitter: classes, functions and methods, imports and calls.
import pythonWasm from 'tree-sitter-python/tree-sitter-python.wasm' with { type: 'file' };
import type { Node } from 'web-tree-sitter';
import type { CallMark, Collector, LanguageModule, SymbolKind } from '../contract.ts';
import { clip, DOC_MAX, docOf, memberHint, named, normalizedHash, oneLine, signatureOf, syntaxTree } from '../kit.ts';
import { BUILTINS } from './builtins.ts';

// The string a body opens with, Python's docstring; '' when it opens with
// anything else.
function pyDocstring(body: Node | null): string {
  const first = body ? named(body).find((c) => c.type !== 'comment') : undefined;
  const str = first?.type === 'expression_statement' ? first.namedChildren[0] : null;
  if (str?.type !== 'string') return '';
  const text = named(str)
    .filter((c) => c.type === 'string_content')
    .map((c) => c.text)
    .join('');
  return clip(oneLine(text), DOC_MAX);
}

const PY_RECEIVERS_OF_CLASS = new Set(['self', 'cls']);
/** The longest a call's text is kept as its name when its callee is no name. */
const CALLEE_TEXT_MAX = 80;

type PyPlace = 'module' | 'class' | 'nested';

// Python's own scopes, each with names of its own: a function, a lambda and a comprehension.
// A class body is none for the functions inside it.
const PY_SCOPES = new Set(['function_definition', 'lambda', 'list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

/** Whether a node sits inside a function or a class, where an import binds no name of the module. */
const insideDefinition = (node: Node): boolean => {
  for (let a = node.parent; a; a = a.parent) if (PY_SCOPES.has(a.type) || a.type === 'class_definition') return true;
  return false;
};

// Imports become module-level 'imports' edges whose hint is the dotted module
// ('.a', '..', 'pkg.mod') and whose dst_name is the imported name, or the
// module itself for `import pkg.mod`. One made inside a function or class is
// marked so, since it holds only there (trustmybot/tmb#246). Returns each
// module-level `as` alias's original name and every name those imports bind.
function pyImports(root: Node, out: Collector, moduleSymbol: number): { aliases: Map<string, string>; bound: Set<string> } {
  const aliases = new Map<string, string>();
  const bound = new Set<string>();
  for (const stmt of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (!stmt) continue;
    const line = stmt.startPosition.row + 1;
    const from = stmt.type === 'import_from_statement' ? stmt.childForFieldName('module_name')?.text : undefined;
    if (stmt.type === 'import_from_statement' && !from) continue;
    const local = insideDefinition(stmt);
    for (const n of stmt.childrenForFieldName('name')) {
      if (!n) continue;
      const original = (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text;
      if (!original) continue;
      const alias = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : undefined;
      if (!local) {
        if (alias) aliases.set(alias, original);
        bound.add(alias ?? original);
      }
      out.edge(moduleSymbol, 'imports', original, line, from ?? original, local ? 'import' : undefined);
    }
    if (from && named(stmt).some((c) => c.type === 'wildcard_import')) out.edge(moduleSymbol, 'imports', '*', line, from, local ? 'import' : undefined);
  }
  return { aliases, bound };
}

/** How a scope binds a name: an import of `name` from `module`, a function defined there, or any other value. */
type PyBinding = { kind: 'import'; name: string; module: string } | { kind: 'function'; line: number } | { kind: 'value' };

// The names a target binds: a plain name, or each name of a tuple or list of targets; an
// attribute or a subscript binds none.
function targetNames(node: Node | null, into: string[]): void {
  if (!node || node.type === 'attribute' || node.type === 'subscript') return;
  if (node.type === 'identifier') into.push(node.text);
  else for (const c of named(node)) targetNames(c, into);
}

// A parameter's name: plain, defaulted, typed, or `*args` and `**kwargs`.
function paramName(p: Node): string | null {
  if (p.type === 'identifier') return p.text;
  if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') return p.childForFieldName('name')?.text ?? null;
  if (p.type === 'typed_parameter' || p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') {
    const inner = named(p)[0];
    return inner ? paramName(inner) : null;
  }
  return null;
}

// Every name a scope binds, and how (trustmybot/tmb#246): its parameters, and in its body each
// assignment, loop, `with … as`, `except … as`, `:=`, import, and function or class defined
// there. Scopes inside it are not entered. A name declared `global` or `nonlocal` is not its
// own. A name bound more than once is a value, unless each time by the same import: no one
// place proves it.
function pyScopeBindings(scope: Node): Map<string, PyBinding> {
  const found = new Map<string, PyBinding[]>();
  const add = (name: string, b: PyBinding): void => {
    const list = found.get(name);
    if (list) list.push(b);
    else found.set(name, [b]);
  };
  const notOwn = new Set<string>();
  const params = scope.childForFieldName('parameters');
  for (const p of params ? named(params) : []) {
    const n = paramName(p);
    if (n) add(n, { kind: 'value' });
  }
  const walk = (node: Node): void => {
    for (const c of named(node)) {
      switch (c.type) {
        case 'function_definition':
        case 'class_definition': {
          const n = c.childForFieldName('name')?.text;
          if (n) add(n, c.type === 'function_definition' ? { kind: 'function', line: (c.parent?.type === 'decorated_definition' ? c.parent : c).startPosition.row + 1 } : { kind: 'value' });
          continue;
        }
        case 'lambda':
        case 'list_comprehension':
        case 'set_comprehension':
        case 'dictionary_comprehension':
        case 'generator_expression':
          continue;
        case 'assignment':
        case 'augmented_assignment':
        case 'for_statement': {
          const names: string[] = [];
          targetNames(c.childForFieldName('left'), names);
          for (const n of names) add(n, { kind: 'value' });
          break;
        }
        case 'as_pattern_target':
        case 'named_expression': {
          const names: string[] = [];
          targetNames(c.type === 'named_expression' ? c.childForFieldName('name') : c, names);
          for (const n of names) add(n, { kind: 'value' });
          break;
        }
        case 'global_statement':
        case 'nonlocal_statement':
          for (const n of named(c)) if (n.type === 'identifier') notOwn.add(n.text);
          continue;
        case 'import_statement':
          for (const n of c.childrenForFieldName('name')) {
            if (!n) continue;
            const alias = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : undefined;
            const name = alias ?? (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text.split('.')[0];
            if (name) add(name, { kind: 'value' });
          }
          continue;
        case 'import_from_statement': {
          const module = c.childForFieldName('module_name')?.text;
          for (const n of c.childrenForFieldName('name')) {
            if (!n) continue;
            const original = (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text;
            const alias = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : undefined;
            if (original && module) add(alias ?? original, { kind: 'import', name: original, module });
          }
          continue;
        }
      }
      walk(c);
    }
  };
  if (scope.type === 'function_definition') {
    const body = scope.childForFieldName('body');
    if (body) walk(body);
  } else if (scope.type === 'lambda') {
    // A lambda binds only its parameters.
  } else {
    for (const clause of named(scope).filter((c) => c.type === 'for_in_clause')) {
      const names: string[] = [];
      targetNames(clause.childForFieldName('left'), names);
      for (const n of names) add(n, { kind: 'value' });
    }
  }
  const bindings = new Map<string, PyBinding>();
  for (const [name, list] of found) {
    if (notOwn.has(name)) continue;
    const first = list[0]!;
    const same = list.length === 1 || list.every((b) => b.kind === 'import' && first.kind === 'import' && b.name === first.name && b.module === first.module);
    bindings.set(name, same ? first : { kind: 'value' });
  }
  return bindings;
}

// A plain string literal's text: no f-string, no bytes, no implicit concatenation.
function plainString(node: Node): string | null {
  if (node.type !== 'string') return null;
  const parts = named(node);
  if (parts.some((c) => !['string_start', 'string_content', 'string_end'].includes(c.type))) return null;
  if (/[fb]/i.test(parts.find((c) => c.type === 'string_start')?.text ?? '')) return null;
  return parts
    .filter((c) => c.type === 'string_content')
    .map((c) => c.text)
    .join('');
}

// The names a module gives other modules without declaring them (trustmybot/tmb#233): each
// name a top-level `from m import f [as g]` binds, each top-level `from m import *`, and its
// `__all__`. An import under `if` or `try` binds a name only on some runs, so it is not one.
// `__all__` is followed only when it is assigned once, at the top level, a list or tuple of
// plain strings, and named nowhere else; else code builds it, and its names are null.
function pyExports(root: Node, out: Collector): void {
  for (const stmt of named(root)) {
    if (stmt.type !== 'import_from_statement') continue;
    const from = stmt.childForFieldName('module_name')?.text;
    if (!from) continue;
    for (const n of stmt.childrenForFieldName('name')) {
      if (!n) continue;
      const original = (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text;
      if (!original || original.includes('.')) continue;
      const name = n.type === 'aliased_import' ? (n.childForFieldName('alias')?.text ?? original) : original;
      out.export({ kind: 'name', name, original, source: from });
    }
    if (named(stmt).some((c) => c.type === 'wildcard_import')) out.export({ kind: 'star', source: from });
  }
  const mentions = root.descendantsOfType('identifier').filter((n): n is Node => n?.text === '__all__');
  if (mentions.length === 0) return;
  let names: string[] | null = null;
  const assignment = mentions.length === 1 ? mentions[0]!.parent : null;
  const right = assignment?.type === 'assignment' && assignment.parent?.parent?.type === 'module' ? assignment.childForFieldName('right') : null;
  if (right && assignment!.childForFieldName('left')?.id === mentions[0]!.id && (right.type === 'list' || right.type === 'tuple')) {
    const items = named(right).filter((c) => c.type !== 'comment').map(plainString);
    if (items.every((i): i is string => i !== null)) names = items;
  }
  out.export({ kind: 'all', names });
}

// A class's bases as the module names them; '' for one that is no plain name, such as
// `mod.Base` or `Generic[T]`. A keyword such as `metaclass=` is no base, nor is `object`.
function pyBases(superclasses: Node | null, target: (name: string) => string): string[] {
  const bases: string[] = [];
  for (const c of superclasses ? named(superclasses) : []) {
    if (c.type === 'keyword_argument' || c.type === 'comment') continue;
    if (c.type === 'identifier') {
      if (c.text !== 'object') bases.push(target(c.text));
    } else bases.push('');
  }
  return bases;
}

// The names a module's or a class's own body binds (trustmybot/tmb#252), which Python looks in
// before its builtins: each assignment, loop, `with … as`, `except … as`, `:=`, import, and
// function or class defined there, under `if`, `try`, `for`, `while` and `with` too. Functions,
// lambdas, classes and comprehensions inside it are not entered; their own names are bound.
// `imports` holds each name bound only once, and by an import: its module as the file writes
// it, the first part of `import a.b`. `star` is set by `from m import *`, which may bind any name.
// A call through an import of `module` (trustmybot/tmb#252). A relative import names the repo's
// own code. An absolute one is found as `a/b.py` or the package folder `a/b/` in any folder on
// Python's search path, so the resolver calls it outside only when the repo has neither.
function importMark(module: string): CallMark {
  if (module.startsWith('.')) return {};
  const base = module.split('.').join('/');
  return { outside: { kind: 'import', module, searched: [`${base}.py`, `${base}/`] } };
}

type BodyNames = { bound: Set<string>; imports: Map<string, string>; star: boolean };

function bodyNames(body: Node): BodyNames {
  const bound = new Set<string>();
  const once = new Map<string, string | null>();
  const bind = (name: string, module: string | null): void => {
    bound.add(name);
    once.set(name, once.has(name) ? null : module);
  };
  let star = false;
  const walk = (node: Node): void => {
    for (const c of named(node)) {
      switch (c.type) {
        case 'function_definition':
        case 'class_definition': {
          const n = c.childForFieldName('name')?.text;
          if (n) bind(n, null);
          continue;
        }
        case 'lambda':
        case 'list_comprehension':
        case 'set_comprehension':
        case 'dictionary_comprehension':
        case 'generator_expression':
          continue;
        case 'assignment':
        case 'augmented_assignment':
        case 'for_statement':
        case 'as_pattern_target':
        case 'named_expression': {
          const names: string[] = [];
          targetNames(c.type === 'named_expression' ? c.childForFieldName('name') : c.type === 'as_pattern_target' ? c : c.childForFieldName('left'), names);
          for (const n of names) bind(n, null);
          break;
        }
        case 'import_statement':
          for (const n of c.childrenForFieldName('name')) {
            if (!n) continue;
            const module = (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text;
            const alias = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : undefined;
            const first = module?.split('.')[0];
            if (alias && module) bind(alias, module);
            else if (first) bind(first, first);
          }
          continue;
        case 'import_from_statement': {
          const module = c.childForFieldName('module_name')?.text ?? null;
          if (named(c).some((n) => n.type === 'wildcard_import')) star = true;
          for (const n of c.childrenForFieldName('name')) {
            if (!n) continue;
            const name = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : n.text;
            if (name) bind(name, module);
          }
          continue;
        }
      }
      walk(c);
    }
  };
  walk(body);
  const imports = new Map<string, string>();
  for (const [name, module] of once) if (module !== null) imports.set(name, module);
  return { bound, imports, star };
}

// The names `global` statements anywhere in a module make the module's own.
function globalNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const g of root.descendantsOfType('global_statement')) for (const n of g ? named(g) : []) if (n.type === 'identifier') names.add(n.text);
  return names;
}

// Module-level classes, functions and `NAME = …` constants, methods of those
// classes, and the calls each makes. A call of a class the file defines, or
// of an imported CapWords name (PEP 8 class naming), is 'instantiates'; a
// call on self/cls carries the enclosing class as its receiver hint.
function extractPython(root: Node, src: string, out: Collector, moduleSymbol: number): void {
  const moduleDocstring = pyDocstring(root);
  const moduleRow = out.symbols[moduleSymbol];
  if (moduleRow && moduleDocstring) moduleRow.doc = moduleDocstring;
  const { aliases, bound } = pyImports(root, out, moduleSymbol);
  pyExports(root, out);
  const classes = new Set(
    root
      .descendantsOfType('class_definition')
      .map((c) => c?.childForFieldName('name')?.text)
      .filter((n): n is string => n !== undefined),
  );
  const target = (name: string): string => aliases.get(name) ?? name;
  const isClass = (name: string): boolean => classes.has(name) || (bound.has(name) && /^[A-Z]/.test(target(name)));
  // How the scopes around a node bind a name, the innermost first (trustmybot/tmb#246); undefined
  // when none does, so the module's own names and imports answer for it.
  const scopes = new Map<number, Map<string, PyBinding>>();
  const localBinding = (node: Node, name: string): PyBinding | undefined => {
    for (let a = node.parent; a; a = a.parent) {
      if (!PY_SCOPES.has(a.type)) continue;
      let bindings = scopes.get(a.id);
      if (!bindings) {
        bindings = pyScopeBindings(a);
        scopes.set(a.id, bindings);
      }
      const b = bindings.get(name);
      if (b) return b;
    }
    return undefined;
  };
  // Where a call's lookup ends past the functions around it (trustmybot/tmb#252): the class body
  // the call is written in directly, then the module, then Python's builtins. `member` is the
  // name called on the object, which the builtin must have as a callable attribute.
  const moduleNames = bodyNames(root);
  const globals = globalNames(root);
  const classNames = new Map<number, BodyNames>();
  const outside = (at: Node, name: string, member?: string): CallMark => {
    for (let a = at.parent; a && !PY_SCOPES.has(a.type); a = a.parent) {
      if (a.type !== 'class_definition') continue;
      const body = a.childForFieldName('body');
      let names = classNames.get(a.id);
      if (!names && body) classNames.set(a.id, (names = bodyNames(body)));
      if (names?.bound.has(name) || names?.star) return {};
    }
    const module = moduleNames.imports.get(name);
    if (module !== undefined && !globals.has(name)) return importMark(module);
    if (moduleNames.bound.has(name) || moduleNames.star || globals.has(name)) return {};
    const builtin = BUILTINS.get(name);
    return builtin !== undefined && (member === undefined || builtin.has(member)) ? { outside: { kind: 'builtin', name } } : {};
  };
  const exportedName = (name: string): number => (name.startsWith('_') ? 0 : 1);
  const definition = (node: Node, kind: SymbolKind, qualifiedName: string, exported: number, parent: number): number => {
    const anchor = node.parent?.type === 'decorated_definition' ? node.parent : node;
    return out.symbol({
      kind,
      qualified_name: qualifiedName,
      signature: signatureOf(node, src),
      doc: pyDocstring(node.childForFieldName('body')) || docOf(anchor),
      start_line: anchor.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      body_hash: normalizedHash(anchor),
      exported,
      parent,
    });
  };

  const visit = (node: Node, scope: number, cls: string | null, place: PyPlace): void => {
    let inner = scope;
    let innerCls = cls;
    let innerPlace = place;
    const t = node.type;
    if (t === 'import_statement' || t === 'import_from_statement' || t === 'future_import_statement') return;
    if (t === 'class_definition') {
      const n = node.childForFieldName('name')?.text;
      innerPlace = 'nested';
      innerCls = null;
      if (n && place === 'module') {
        inner = definition(node, 'class', n, exportedName(n), scope);
        innerCls = n;
        innerPlace = 'class';
        const superclasses = node.childForFieldName('superclasses');
        for (const base of superclasses ? named(superclasses).filter((c) => c.type === 'identifier') : []) {
          out.edge(inner, 'instantiates', target(base.text), base.startPosition.row + 1);
        }
        const bases = pyBases(superclasses, target);
        if (bases.length > 0) out.symbols[inner]!.bases = bases;
      }
    } else if (t === 'function_definition') {
      const n = node.childForFieldName('name')?.text;
      innerPlace = 'nested';
      if (n && place === 'module') inner = definition(node, 'function', n, exportedName(n), scope);
      else if (n && place === 'class' && cls) inner = definition(node, 'method', `${cls}.${n}`, 0, scope);
    } else if (t === 'expression_statement' && node.parent?.type === 'module') {
      const assignment = node.namedChildren[0];
      const hasValue = assignment?.type === 'assignment' && assignment.childForFieldName('right') !== null;
      const left = hasValue ? assignment.childForFieldName('left') : null;
      if (left?.type === 'identifier') {
        inner = out.symbol({
          kind: 'const',
          qualified_name: left.text,
          signature: clip(oneLine(src.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 140))), 200),
          doc: docOf(node),
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: exportedName(left.text),
        });
      }
    } else if (t === 'call') {
      const fn = node.childForFieldName('function');
      const line = node.startPosition.row + 1;
      let written = false;
      if (fn?.type === 'identifier') {
        const b = localBinding(fn, fn.text);
        if (b === undefined) out.edge(scope, isClass(fn.text) ? 'instantiates' : 'calls', target(fn.text), line, null, undefined, outside(fn, fn.text));
        else if (b.kind === 'import') out.edge(scope, /^[A-Z]/.test(b.name) ? 'instantiates' : 'calls', b.name, line, b.module, 'import', importMark(b.module));
        else out.edge(scope, 'calls', fn.text, line, b.kind === 'function' ? String(b.line) : null, b.kind, {});
        written = true;
      } else if (fn?.type === 'attribute') {
        const callee = fn.childForFieldName('attribute')?.text;
        const object = fn.childForFieldName('object');
        if (callee && object) {
          const ofClass = object.type === 'identifier' && PY_RECEIVERS_OF_CLASS.has(object.text) && cls;
          // A receiver bound in the function around the call is no class or module the file names.
          const local = !ofClass && object.type === 'identifier' && localBinding(object, object.text) !== undefined;
          const mark = !ofClass && !local && object.type === 'identifier' ? outside(object, object.text, callee) : {};
          if (ofClass) out.edge(scope, 'calls', callee, line, cls, 'self', mark);
          else out.edge(scope, 'calls', callee, line, memberHint(local ? object.text : target(object.text)), local ? 'value' : undefined, mark);
          written = true;
        }
      }
      // A call whose callee is no name, such as `f()()` or `handlers[k]()`, is a call all the same:
      // it is named by its callee's text and is not known.
      if (!written) out.edge(scope, 'calls', clip(oneLine((fn ?? node).text), CALLEE_TEXT_MAX), line, null, undefined, {});
    }
    for (const c of named(node)) visit(c, inner, innerCls, innerPlace);
  };
  visit(root, moduleSymbol, null, 'module');
}

export const python: LanguageModule = {
  name: 'python',
  extensions: ['py'],
  grammar: pythonWasm,
  comment: 'hash',
  extract: (file, out) => extractPython(syntaxTree(file), file.src, out, file.module),
};
