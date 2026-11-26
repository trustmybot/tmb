// SQL (CODE_GRAPH.md, "Data sources"): the tables a statement reads and writes, from the SQL parser
// tmb carries (parser.ts), in an .sql file and in a string in code, which the other languages hand
// to sqlInCode. Whatever a statement names as a table is a table node, by the last part of its
// name; a name the code does not state links to the store alone. A statement of an .sql file the
// parser cannot read gives no link and is counted.
import type { Collector, LanguageModule } from '../contract.ts';
import { md5 } from '../kit.ts';
import { readSql, type SqlPlace, type SqlRef, type SqlStatement } from './parser.ts';

/**
 * The word a language puts in a string where code interpolates a value, so the statement still
 * parses: as a value it is a name like any other, and as a table's name it says the name is not
 * stated.
 */
export const SQL_HOLE = 'tmb_hole_';

/**
 * The first words of the statements that read or write a table, as SQL writes them. A string in
 * code is given to the parser only when it starts with one, in any letter case.
 */
const STATEMENT_STARTS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'INSERT',
  'REPLACE',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'COPY',
]);

/** The kind of a data source a statement reaches without naming a table: its node's name when it states no name of its own. */
export const STORE_KINDS = { database: 'database', bucket: 'object storage' } as const;

/** Whether a string starts like a statement that reads or writes a table. */
export function startsLikeStatement(text: string): boolean {
  const first = /^\s*([A-Za-z]+)\b/.exec(text)?.[1];
  return first !== undefined && STATEMENT_STARTS.has(first.toUpperCase());
}

function tableNode(out: Collector, name: string, line: number, defined?: { kind: string; end: number }): void {
  const index = out.symbol({
    kind: 'sql_table',
    qualified_name: name,
    signature: `table ${name}`,
    doc: '',
    start_line: line,
    end_line: line,
    body_hash: md5(name),
    exported: 0,
  });
  const node = out.symbols[index]!;
  if (defined && node.defined !== 1) {
    node.defined = 1;
    node.signature = `${defined.kind} ${name}`;
    node.start_line = line;
    node.end_line = defined.end;
  }
}

function storeNode(out: Collector, name: string, signature: string, line: number): void {
  out.symbol({ kind: 'data_source', qualified_name: name, signature, doc: '', start_line: line, end_line: line, body_hash: md5(signature), exported: 0 });
}

function link(out: Collector, src: number, ref: SqlRef, line: number): void {
  const read = ref.op === 'read';
  const at: SqlPlace = ref.at;
  if (at.to === 'table') {
    tableNode(out, at.name, line);
    out.edge(src, read ? 'reads_table' : 'writes_table', at.name, line);
    return;
  }
  const name = at.to === 'store' ? STORE_KINDS.database : (at.name ?? STORE_KINDS.bucket);
  storeNode(out, name, at.to === 'bucket' && at.name !== undefined ? `${STORE_KINDS.bucket} ${at.name}` : name, line);
  out.edge(src, read ? 'reads_store' : 'writes_store', name, line);
}

/** One read statement's nodes and links; `lineOf` turns its lines into the file's. */
function addStatement(out: Collector, owner: number, statement: SqlStatement, lineOf: (line: number) => number): void {
  const line = lineOf(statement.line);
  const end = lineOf(statement.end);
  for (const d of statement.defines ?? []) tableNode(out, d.name, line, { kind: d.kind, end });
  for (const ref of statement.refs ?? []) link(out, owner, ref, line);
  for (const trigger of statement.triggers ?? []) {
    // A trigger is code that runs in the store: a node of its own, and its body's links start at it.
    const id = out.symbol(
      {
        kind: 'sql_trigger',
        qualified_name: trigger.name,
        signature: `trigger ${trigger.name}`,
        doc: '',
        start_line: line,
        end_line: end,
        body_hash: md5(JSON.stringify(trigger)),
        exported: 0,
      },
      `sql_trigger\u0000${trigger.name}\u0000${line}`,
    );
    if (trigger.on?.to === 'table') {
      tableNode(out, trigger.on.name, line);
      out.edge(id, 'triggers_on', trigger.on.name, line);
    }
    for (const ref of trigger.refs) link(out, id, ref, line);
  }
}

/**
 * The tables of the SQL in a string of code, linked from `owner`. `text` is the string's value,
 * each interpolated value replaced by SQL_HOLE; `first` and `last` are the lines the string spans
 * in the file. A statement that does not parse gives nothing and is not counted: a string that
 * starts like a statement may be a label.
 */
export function sqlInCode(text: string, owner: number, first: number, last: number, out: Collector): void {
  if (!startsLikeStatement(text)) return;
  const lineOf = (line: number) => Math.min(last, first + line - 1);
  for (const statement of readSql(text, SQL_HOLE)) if (statement.read) addStatement(out, owner, statement, lineOf);
}

export const sql: LanguageModule = {
  name: 'sql',
  extensions: ['sql'],
  comment: 'hash',
  extract: (file, out) => {
    for (const statement of readSql(file.src, '')) {
      if (statement.read) addStatement(out, file.module, statement, (line) => line);
      else out.statementsNotRead++;
    }
  },
};
