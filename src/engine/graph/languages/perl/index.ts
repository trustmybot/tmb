// Perl, read by patterns: subs, constants and the packages they sit in.
import type { Collector, LanguageModule } from '../contract.ts';
import { afterLastBanner, clip, DOC_MAX, md5, oneLine } from '../kit.ts';

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

export const perl: LanguageModule = {
  name: 'perl',
  linguist: ['Perl'],
  comment: 'hash',
  extract: (file, out) => extractPerl(file.src, out),
};
