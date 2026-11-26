// SQL (CODE_GRAPH.md, "Data sources"): the tables a statement reads and writes, from the SQL parser
// tmb carries (parser.ts), in an .sql file and in a string in code, which the other languages hand
// to sqlInCode. Whatever a statement names as a table is a table, by the last part of its name; a
// name the code does not state links to the store alone. A statement of an .sql file the parser
// cannot read gives no link and is counted.
import type { Collector, LanguageModule } from '../contract.ts';
import { md5 } from '../kit.ts';
import { readSql, type SqlRef, type SqlStatement } from './parser.ts';

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

/** The kinds of data source SQL reaches: a table by its name, and the store alone when the code states no table's name. */
export const SQL_DATA = { table: 'table', store: 'database' } as const;

/** Whether a string starts like a statement that reads or writes a table. */
export function startsLikeStatement(text: string): boolean {
  const first = /^\s*([A-Za-z]+)\b/.exec(text)?.[1];
  return first !== undefined && STATEMENT_STARTS.has(first.toUpperCase());
}

function link(out: Collector, src: number, ref: SqlRef, line: number): void {
  const kind = ref.op === 'read' ? 'reads_data' : 'writes_data';
  if (ref.at.to === 'table') out.dataLink(src, kind, SQL_DATA.table, ref.at.name, line);
  else out.dataLink(src, kind, SQL_DATA.store, '', line);
}

/** One read statement's links, from `owner`; `lineOf` turns its lines into the file's. */
function addStatement(out: Collector, owner: number, statement: SqlStatement, lineOf: (line: number) => number): void {
  const line = lineOf(statement.line);
  const end = lineOf(statement.end);
  for (const ref of statement.refs ?? []) link(out, owner, ref, line);
  for (const trigger of statement.triggers ?? []) {
    // A trigger is code that runs in the store: a node where it is written, and its body's links start at it.
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
        parent: owner,
      },
      `sql_trigger\u0000${trigger.name}\u0000${line}`,
    );
    if (trigger.on?.to === 'table') out.dataLink(id, 'triggers_on', SQL_DATA.table, trigger.on.name, line);
    for (const ref of trigger.refs) link(out, id, ref, line);
  }
}

/**
 * The tables of the SQL in a string of code, linked from `owner`. `text` is the string's value,
 * each interpolated value replaced by SQL_HOLE; `first` and `last` are the lines the string spans
 * in the file. The string does not say its dialect: every dialect is tried, and a statement counts
 * when every dialect that parses it names the same tables. One that does not gives nothing and is
 * not counted, since a string that starts like a statement may be a label.
 */
export function sqlInCode(text: string, owner: number, first: number, last: number, out: Collector): void {
  if (!startsLikeStatement(text)) return;
  const lineOf = (line: number) => Math.min(last, first + line - 1);
  for (const statement of readSql(text, SQL_HOLE)) if (statement.read) addStatement(out, owner, statement, lineOf);
}

export const sql: LanguageModule = {
  name: 'sql',
  linguist: ['SQL'],
  // Linguist's names for the dialects of Postgres, SQL Server, Oracle and DB2, which its rules tell apart in an `.sql` file.
  dialects: ['PLpgSQL', 'TSQL', 'PLSQL', 'SQLPL'],
  comment: 'hash',
  extract: (file, out) => {
    for (const statement of readSql(file.src, '')) {
      if (statement.read) addStatement(out, file.module, statement, (line) => line);
      else out.statementsNotRead++;
    }
  },
};
