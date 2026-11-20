// bash and Python, read through tree-sitter, and SQL DDL and Perl, read by patterns: the
// languages that move into folders of their own with trustmybot/tmb#141. Until then their rules
// share this file, behind the same contract as every other language.
import bashWasm from 'tree-sitter-bash/tree-sitter-bash.wasm' with { type: 'file' };
import pythonWasm from 'tree-sitter-python/tree-sitter-python.wasm' with { type: 'file' };
import { basename } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { Collector, EdgeKind, LanguageModule, SourceFile, SymbolKind } from '../contract.ts';
import { afterLastBanner, clip, DOC_MAX, docOf, md5, memberHint, named, normalizedHash, oneLine, signatureOf } from '../kit.ts';

const SH_BUILTINS = new Set(
  'echo printf local export declare readonly return exit set unset shift cd test [ [[ true false read eval exec trap wait source . if then else fi for do done while case esac cat grep sed awk tr cut head tail sort uniq wc mkdir rm cp mv ln chmod touch date sleep command type jq git basename dirname xargs find tee env mktemp pwd kill ps sqlite3 node bash sh python3 curl gh'.split(
    ' ',
  ),
);
const SQL_HINT = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|REPLACE)\b/;

export function sqlRefs(text: string): Array<[EdgeKind, string]> {
  if (!SQL_HINT.test(text)) return [];
  const out: Array<[EdgeKind, string]> = [];
  for (const m of text.matchAll(
    /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([A-Za-z_]\w*)/g,
  )) {
    out.push(['writes_table', m[1]!]);
  }
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+["`]?([A-Za-z_]\w*)/g)) out.push(['reads_table', m[1]!]);
  for (const m of text.matchAll(/\bALTER\s+TABLE\s+["`]?([A-Za-z_]\w*)/g)) out.push(['writes_table', m[1]!]);
  return out;
}
function lineCounter(text: string, lineBase: number): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lineBase + lo + 1;
  };
}

function statementEnd(text: string, start: number, virtual: boolean): number {
  if (virtual) return text.indexOf(';', start);
  let depth = 0;
  let i = text.indexOf('(', start);
  for (; i >= 0 && i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) break;
  }
  return i;
}

function columnNames(stmt: string): string[] {
  const inner = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
  const cols: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      cols.push(cur);
      cur = '';
    } else cur += ch;
  }
  cols.push(cur);
  return cols
    .map((c) => c.trim().split(/\s+/)[0] ?? '')
    .filter((c) => c && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|content|content_rowid|tokenize|--)/i.test(c));
}

export function extractSqlDdl(text: string, out: Collector, moduleSymbol: number | null, lineBase = 0): void {
  const lineAt = lineCounter(text, lineBase);
  for (const m of text.matchAll(/CREATE\s+(VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
    const start = m.index;
    let end = statementEnd(text, start, Boolean(m[1]));
    if (end < 0) end = Math.min(text.length, start + 400);
    const stmt = text.slice(start, end + 1);
    const name = m[2]!;
    out.symbol({
      kind: 'sql_table',
      qualified_name: name,
      signature: clip(`${name}(${columnNames(stmt).join(', ')})`, 240),
      doc: '',
      start_line: lineAt(start),
      end_line: lineAt(end),
      body_hash: md5(oneLine(stmt)),
      exported: 0,
    });
  }
  for (const m of text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)/gi)) {
    const line = lineAt(m.index);
    const id = out.symbol({
      kind: 'sql_index',
      qualified_name: m[1]!,
      signature: oneLine(m[0]),
      doc: '',
      start_line: line,
      end_line: line,
      body_hash: md5(m[0]),
      exported: 0,
    });
    out.edge(id, 'indexes', m[2]!, line);
  }
  for (const m of text.matchAll(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+([\s\S]*?)\bON\s+(\w+)([\s\S]*?)\bEND\b/gi)) {
    const line = lineAt(m.index);
    const id = out.symbol({
      kind: 'sql_trigger',
      qualified_name: m[1]!,
      signature: clip(oneLine(`${m[1]} ${m[2]} ON ${m[3]}`), 200),
      doc: '',
      start_line: line,
      end_line: lineAt(m.index + m[0].length),
      body_hash: md5(oneLine(m[0])),
      exported: 0,
    });
    out.edge(id, 'triggers_on', m[3]!, line);
    for (const [kind, table] of sqlRefs(m[4]!)) out.edge(id, kind, table, line);
  }
  if (moduleSymbol !== null) {
    for (const m of text.matchAll(/\bALTER\s+TABLE\s+(\w+)/gi)) out.edge(moduleSymbol, 'writes_table', m[1]!, lineAt(m.index));
  }
}
function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function extractBash(root: Node, out: Collector, moduleSymbol: number): void {
  const visit = (node: Node, scope: number): void => {
    let inner = scope;
    const t = node.type;
    if (t === 'function_definition') {
      const n = node.childForFieldName('name')?.text;
      if (n) {
        inner = out.symbol({
          kind: 'sh_function',
          qualified_name: n,
          signature: `${n}()`,
          doc: docOf(node),
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          body_hash: normalizedHash(node),
          exported: 1,
          parent: scope,
        });
      }
    } else if (t === 'command') {
      const name = node.childForFieldName('name')?.text;
      const args = named(node)
        .filter((c) => c.type !== 'command_name')
        .map((c) => stripQuotes(c.text));
      const line = node.startPosition.row + 1;
      if (name === 'source' || name === '.') {
        if (args[0]) out.edge(scope, 'sources', basename(args[0]), line);
      } else if (name && /\.sh$/.test(name)) out.edge(scope, 'runs', basename(name), line);
      else if ((name === 'bash' || name === 'sh') && args[0] && /\.sh$/.test(args[0])) {
        out.edge(scope, 'runs', basename(args[0]), line);
      } else if (name && /^[A-Za-z_][\w-]*$/.test(name) && !SH_BUILTINS.has(name)) out.edge(scope, 'calls', name, line);
    } else if (t === 'string' || t === 'raw_string' || t === 'heredoc_body') {
      const line = node.startPosition.row + 1;
      for (const [kind, table] of sqlRefs(node.text)) out.edge(scope, kind, table, line);
    }
    for (const c of named(node)) visit(c, inner);
  };
  visit(root, moduleSymbol);
}

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

// Module-level classes, functions and `NAME = …` constants, methods of those
// classes, and the calls each makes. A call of a class the file defines, or
// of an imported CapWords name (PEP 8 class naming), is 'instantiates'; a
// call on self/cls carries the enclosing class as its receiver hint.
function extractPython(root: Node, src: string, out: Collector, moduleSymbol: number): void {
  const moduleDocstring = pyDocstring(root);
  const moduleRow = out.symbols[moduleSymbol];
  if (moduleRow && moduleDocstring) moduleRow.doc = moduleDocstring;
  const { aliases, bound } = pyImports(root, out, moduleSymbol);
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

// The '#' comment block whose last row is right above row `at` (0-based),
// with no blank row between, from after its last banner line on; never the
// shebang.
function hashCommentDoc(lines: string[], at: number): string {
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && /^\s*#/.test(lines[i]!) && !/^#!/.test(lines[i]!); i--) block.unshift(lines[i]!);
  return clip(oneLine(afterLastBanner(block).map((l) => l.replace(/^\s*#+/, ' ')).join(' ')), DOC_MAX);
}

// The rows of Perl code: POD blocks and everything after __END__/__DATA__
// blank out, so line numbers still match the file.
function perlCodeLines(src: string): string[] {
  const lines = src.split('\n');
  let pod = false;
  let done = false;
  return lines.map((l) => {
    if (done) return '';
    if (/^__(END|DATA)__\s*$/.test(l)) {
      done = true;
      return '';
    }
    if (pod) {
      if (/^=cut\b/.test(l)) pod = false;
      return '';
    }
    if (/^=[a-zA-Z]/.test(l)) {
      pod = !/^=cut\b/.test(l);
      return '';
    }
    return l;
  });
}

const PERL_SUB = /^(\s*)sub\s+([A-Za-z_][\w:]*)\b([^{]*)/;
const PERL_CONST = /^\s*use\s+constant\s+(?:([A-Za-z_]\w*)\s*=>|(\{))/;
const PERL_BLOCK_KEY = /\s*['"]?([A-Za-z_]\w*)['"]?\s*=>/y;

// A forward declaration (`sub name;`) declares no body and is no symbol.
function perlForwardDecl(line: string): boolean {
  return /^[^{#]*;\s*(#.*)?$/.test(line);
}

// The column of the `]` closing the `[` at `open` on the same line, so a
// regex class such as `[^}]` hides its braces; `open` when none does.
function bracketEnd(line: string, open: number): number {
  for (let j = open + 1; j < line.length; j++) {
    if (line[j] === '\\') j++;
    else if (line[j] === ']') return j;
  }
  return open;
}

// The row a sub ends on: the row where its braces, counted from its first `{`
// outside '#' comments, quoted strings, same-line `[...]` and backslash
// escapes, balance; when
// they never do, the first later row that opens with `}` at or left of the
// sub's indent.
function perlSubEnd(lines: string[], start: number, indent: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    let quote: string | null = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (ch === '\\') {
        j++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '#' && line[j - 1] !== '$') break;
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') j = bracketEnd(line, j);
      else if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}' && opened && --depth === 0) return i;
    }
  }
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(\s*)\}/.exec(lines[i]!);
    if (m && m[1]!.length <= indent) return i;
  }
  return start;
}

// The keys of a `use constant { A => ..., B => ... };` block opened at
// (row, col), each with its row: a key is a bareword or quoted name before
// `=>` at brace depth 1, first in the block or after a comma.
function perlConstantKeys(lines: string[], row: number, col: number): { keys: Array<[string, number]>; end: number } {
  const keys: Array<[string, number]> = [];
  let depth = 0;
  let expectKey = false;
  for (let i = row; i < lines.length; i++) {
    const line = lines[i]!;
    let quote: string | null = null;
    for (let j = i === row ? col : 0; j < line.length; j++) {
      const ch = line[j]!;
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '#') break;
      if (depth === 1 && expectKey) {
        PERL_BLOCK_KEY.lastIndex = j;
        const m = PERL_BLOCK_KEY.exec(line);
        if (m) {
          keys.push([m[1]!, i]);
          j = PERL_BLOCK_KEY.lastIndex - 1;
          expectKey = false;
          continue;
        }
        if (!/\s/.test(ch)) expectKey = false;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '(' || ch === '[') {
        depth++;
        if (depth === 1) expectKey = true;
      } else if (ch === '}' || ch === ')' || ch === ']') {
        if (--depth === 0) return { keys, end: i };
      } else if (ch === ',' && depth === 1) expectKey = true;
    }
  }
  return { keys, end: lines.length - 1 };
}

// Perl, line by line: each named `sub NAME` is a 'function' and each
// `use constant NAME => ...` or `use constant { A => ..., B => ... }` name a
// 'const'. A leading underscore marks a name private (exported 0).
function extractPerl(src: string, out: Collector): void {
  const lines = perlCodeLines(src);
  const body = (from: number, to: number) =>
    md5(oneLine(lines.slice(from, to + 1).filter((l) => !/^\s*#/.test(l)).join('\n')));
  const exported = (name: string) => (/^_|::_/.test(name) ? 0 : 1);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sub = PERL_SUB.exec(line);
    if (sub) {
      if (perlForwardDecl(line)) continue;
      const name = sub[2]!;
      const end = perlSubEnd(lines, i, sub[1]!.length);
      out.symbol({
        kind: 'function',
        qualified_name: name,
        signature: clip(oneLine(`sub ${name}${sub[3]!.replace(/;.*$/, '')}`), 200),
        doc: hashCommentDoc(lines, i),
        start_line: i + 1,
        end_line: end + 1,
        body_hash: body(i, end),
        exported: exported(name),
      });
      continue;
    }
    const constant = PERL_CONST.exec(line);
    if (!constant) continue;
    if (constant[1]) {
      const name = constant[1];
      let end = i;
      while (end < lines.length - 1 && !/;\s*(#.*)?$/.test(lines[end]!)) end++;
      out.symbol({
        kind: 'const',
        qualified_name: name,
        signature: clip(oneLine(lines.slice(i, end + 1).join(' ').replace(/^\s*use\s+constant\s+/, '').replace(/;\s*(#.*)?$/, '')), 200),
        doc: hashCommentDoc(lines, i),
        start_line: i + 1,
        end_line: end + 1,
        body_hash: body(i, end),
        exported: exported(name),
      });
      continue;
    }
    const block = perlConstantKeys(lines, i, line.indexOf('{', constant.index + constant[0].length - 1));
    for (const [name, row] of block.keys) {
      out.symbol({
        kind: 'const',
        qualified_name: name,
        signature: clip(oneLine(lines[row]!).replace(/,$/, ''), 200),
        doc: hashCommentDoc(lines, row) || hashCommentDoc(lines, i),
        start_line: row + 1,
        end_line: row + 1,
        body_hash: md5(oneLine(lines[row]!)),
        exported: exported(name),
      });
    }
    i = block.end;
  }
}

const tree = (file: SourceFile): Node => {
  if (!file.root) throw new Error(`no syntax tree for ${file.relPath}`);
  return file.root;
};

export const bash: LanguageModule = {
  name: 'bash',
  extensions: ['sh', 'bash'],
  shebang: /^#!.*\b(bash|sh)\b/,
  grammar: bashWasm,
  comment: 'hash',
  extract: (file, out) => extractBash(tree(file), out, file.module),
};

export const python: LanguageModule = {
  name: 'python',
  extensions: ['py'],
  grammar: pythonWasm,
  comment: 'hash',
  extract: (file, out) => extractPython(tree(file), file.src, out, file.module),
};

export const sql: LanguageModule = {
  name: 'sql',
  extensions: ['sql'],
  comment: 'hash',
  extract: (file, out) => extractSqlDdl(file.src, out, file.module),
};

export const perl: LanguageModule = {
  name: 'perl',
  extensions: ['pl', 'pm'],
  shebang: /^#!.*\bperl\b/,
  comment: 'hash',
  extract: (file, out) => extractPerl(file.src, out),
};
