// Python, read through tree-sitter: classes, functions and methods, imports and calls.
import pythonWasm from 'tree-sitter-python/tree-sitter-python.wasm' with { type: 'file' };
import type { Node } from 'web-tree-sitter';
import type { Collector, LanguageModule, SymbolKind } from '../contract.ts';
import { clip, DOC_MAX, docOf, memberHint, named, normalizedHash, oneLine, signatureOf, syntaxTree } from '../kit.ts';

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

type PyPlace = 'module' | 'class' | 'nested';

// Imports become module-level 'imports' edges whose hint is the dotted module
// ('.a', '..', 'pkg.mod') and whose dst_name is the imported name, or the
// module itself for `import pkg.mod`. Returns each `as` alias's original name
// and every name the imports bind.
function pyImports(root: Node, out: Collector, moduleSymbol: number): { aliases: Map<string, string>; bound: Set<string> } {
  const aliases = new Map<string, string>();
  const bound = new Set<string>();
  for (const stmt of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (!stmt) continue;
    const line = stmt.startPosition.row + 1;
    const from = stmt.type === 'import_from_statement' ? stmt.childForFieldName('module_name')?.text : undefined;
    if (stmt.type === 'import_from_statement' && !from) continue;
    for (const n of stmt.childrenForFieldName('name')) {
      if (!n) continue;
      const original = (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text;
      if (!original) continue;
      const alias = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : undefined;
      if (alias) aliases.set(alias, original);
      bound.add(alias ?? original);
      out.edge(moduleSymbol, 'imports', original, line, from ?? original);
    }
    if (from && named(stmt).some((c) => c.type === 'wildcard_import')) out.edge(moduleSymbol, 'imports', '*', line, from);
  }
  return { aliases, bound };
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
        for (const base of named(node.childForFieldName('superclasses') ?? node).filter((c) => c.type === 'identifier')) {
          out.edge(inner, 'instantiates', target(base.text), base.startPosition.row + 1);
        }
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
      if (fn?.type === 'identifier') {
        out.edge(scope, isClass(fn.text) ? 'instantiates' : 'calls', target(fn.text), line);
      } else if (fn?.type === 'attribute') {
        const callee = fn.childForFieldName('attribute')?.text;
        const object = fn.childForFieldName('object');
        if (callee && object) {
          const ofClass = object.type === 'identifier' && PY_RECEIVERS_OF_CLASS.has(object.text) && cls;
          out.edge(scope, 'calls', callee, line, ofClass ? cls : memberHint(target(object.text)));
        }
      }
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
