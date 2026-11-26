# SQL

The code graph's rules for SQL, in `.sql` files and in strings of code. SQL is read by the parser tmb carries: [sqlparser-rs](https://github.com/apache/datafusion-sqlparser-rs) at the version [parser/Cargo.lock](parser/Cargo.lock) pins, wrapped by the crate in [parser/](parser/) so it gives only the tables each statement reads and writes. It is compiled to [sql-tables.wasm](sql-tables.wasm) by `bun scripts/build-sql-parser.ts`; `--check` rebuilds it and fails when the carried file differs. [parser.ts](parser.ts) loads it the first time a text is read, so a repo with no SQL never loads it.

## What it reads

- Each statement is parsed in every dialect the parser has, the general one first. Its tables count when the dialects that parse it name the same tables. A statement of an `.sql` file no dialect parses, or one the dialects disagree on, gives no link and is counted in the layer's `not_read` as `statements`, which the answer's freshness shows.
- A table is a data source: one `data_source` node of the repo, in no file, its kind (`table`) as its signature and its name as the last part of the name the statement gives. A view and a virtual table are tables.
- A query's tables are reads; an insert, update, delete, merge, truncate, `ALTER`, `DROP`, `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX` and `COPY` into a table write theirs, as `reads_data` and `writes_data` links. An index is no node. A foreign key is no link. An address a `COPY` names is not read.
- A trigger is a node where it is written, linked to the table it fires on (`triggers_on`); the tables its body reads and writes are linked from it.
- A table name the code does not state, such as one interpolated from a variable, links to the store alone: a `data_source` node of kind `database` with no name.

## SQL in strings

The other languages hand `sqlInCode` ([index.ts](index.ts)) the value of a string that starts with a statement's first word, in any letter case: TypeScript and JavaScript strings, template strings and `+` chains of them; Python strings, f-strings, `%` and `.format` templates and their concatenations; bash strings. An interpolated value becomes a placeholder word, `SQL_HOLE`. The string does not say its dialect, so a statement counts only when the general dialect and more than half of all the dialects parse it, and all that parse it name the same tables. A string that is not SQL by that rule gives nothing and is not counted.

A label every dialect reads as a statement, such as `Select one from the list`, still gives a table: a known gap (trustmybot/tmb#350).
