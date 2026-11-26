# SQL

The code graph's rules for SQL, in `.sql` files and in strings of code. SQL is read by the parser tmb carries: [sqlparser-rs](https://github.com/apache/datafusion-sqlparser-rs) at the version [parser/Cargo.lock](parser/Cargo.lock) pins, wrapped by the crate in [parser/](parser/) so it gives only the tables each statement reads and writes. It is compiled to [sql-tables.wasm](sql-tables.wasm) by `bun scripts/build-sql-parser.ts`; `--check` rebuilds it and fails when the carried file differs. [parser.ts](parser.ts) loads it the first time a text is read, so a repo with no SQL never loads it.

## What it reads

- Each statement is parsed in every dialect the parser has, the general one first. Its tables count when the dialects that parse it name the same tables. A statement no dialect parses, or one the dialects disagree on, gives no link; in an `.sql` file it is counted in the layer's `not_read` as `statements`.
- A table is named by the last part of its name, so one name is one node. A view and a virtual table are table nodes; the statement that creates one is its definition.
- A query's tables are reads; an insert, update, delete, merge, truncate, `ALTER`, `DROP`, `CREATE` and `COPY` into a table write theirs. An index writes its table and is no node. A foreign key is no link.
- A trigger is a node, linked to the table it fires on; the tables its body reads and writes are linked from it.
- A table name the code does not state, such as one interpolated from a variable, links to the store alone: a `data_source` node, `database`. A `COPY` from object storage reads its bucket, a `data_source` node named by the bucket.

## SQL in strings

The other languages hand `sqlInCode` ([index.ts](index.ts)) the value of a string that starts with a statement's first word, in any letter case: TypeScript and JavaScript strings, template strings and `+` chains of them; Python strings, f-strings, `%` and `.format` templates and their concatenations; bash strings. An interpolated value becomes a placeholder word, `SQL_HOLE`. Only a statement that parses gives links, and a string that does not parse is not counted, since a string that starts like a statement may be a label.

A label that is itself valid SQL still parses: some dialects read `Delete row` as a delete from the table `row`.
