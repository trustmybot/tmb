// Research harness for trustmybot/tmb#339: every candidate, and today's patterns, on the SQL the
// benchmark repos hold.
//   TMB_PINNED_FLASK=… TMB_PINNED_DATASETTE=… bun tests/benchmark/candidates/sql/run.ts <out.json>
// A unit is a .sql file, or a string in code that starts like an SQL statement or that today's
// pattern reads. The three repos use SQLite (bun:sqlite, sqlite3), so each candidate reads them in
// its SQLite dialect; a candidate with none reads them in its generic one.
import { writeFileSync } from "node:fs";
import { type Answer, CANDIDATES, dialectFor, sqlglot, today } from "./candidates.ts";
import { repoUnits } from "./corpus.ts";
import { splitStatements } from "./split.ts";
import type { Unit } from "./strings.ts";

const TODAY_HINT = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|REPLACE)\b/;
const CORPUS_DIALECT = "sqlite";

export type Row = { unit: Unit; answers: Record<string, Answer>; ms: Record<string, number> };

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: run.ts <out.json>");
  // A .sql file is split into statements, and every source reads each statement as a unit.
  const units = (await repoUnits())
    .filter((u) => u.from === "file" || u.startsLikeSql || TODAY_HINT.test(u.sql))
    .flatMap((u) => (u.from === "file" ? splitStatements(u.sql).map((s) => ({ ...u, sql: s.sql, raw: s.sql, line: s.line })) : [u]));
  const rows: Row[] = units.map((unit) => ({ unit, answers: {}, ms: {} }));
  for (const r of rows) {
    r.answers["today"] = today(r.unit);
    r.answers["today's patterns, every language"] = today(r.unit, true);
    for (const c of CANDIDATES) {
      const t = performance.now();
      r.answers[c.name] = await c.run(r.unit.sql, dialectFor(c, CORPUS_DIALECT));
      r.ms[c.name] = performance.now() - t;
    }
  }
  const t = performance.now();
  const glot = sqlglot.batch(rows.map((r) => ({ sql: r.unit.sql, dialect: dialectFor(sqlglot, CORPUS_DIALECT) })));
  const glotMs = (performance.now() - t) / Math.max(rows.length, 1);
  rows.forEach((r, i) => {
    r.answers[sqlglot.name] = glot[i]!;
    r.ms[sqlglot.name] = glotMs;
  });
  writeFileSync(out, JSON.stringify(rows));
  console.log(`${rows.length} units written to ${out}`);
}
