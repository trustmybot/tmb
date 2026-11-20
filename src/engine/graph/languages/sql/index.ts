// SQL DDL, read by patterns: tables and their columns, and the tables a statement reads or
// writes, which the other languages call to read SQL held in their strings.
import type { Collector, EdgeKind, LanguageModule } from '../contract.ts';
import { clip, md5, oneLine } from '../kit.ts';

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

export const sql: LanguageModule = {
  name: 'sql',
  extensions: ['sql'],
  comment: 'hash',
  extract: (file, out) => extractSqlDdl(file.src, out, file.module),
};
