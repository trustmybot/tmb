# SQL

The code graph's rules for `.sql` files. SQL has no grammar here; its rules are patterns ([index.ts](index.ts)).

## What it reads

- Each `CREATE TABLE` is a table node, with its columns.
- Each `CREATE INDEX` is an index node, linked to its table.
- Each `CREATE TRIGGER` is a trigger node, linked to the table it fires on and to the tables its body reads and writes.
- An `ALTER TABLE` writes its table.

The other languages call `sqlRefs` and `extractSqlDdl` to read SQL held in their strings, so a TypeScript or bash file that writes a table is linked to it.

Its fixtures and a coverage test of its own come with trustmybot/tmb#141.
