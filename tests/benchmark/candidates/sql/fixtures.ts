// Research harness for trustmybot/tmb#339: every candidate on the hand-written fixture set.
//   bun tests/benchmark/candidates/sql/fixtures.ts [--json out.json]
// Prints, per candidate: parsed, cases right in full, and table pairs found, missed and false.
import { writeFileSync } from "node:fs";
import { type Answer, CANDIDATES, dialectFor, sqlglot, today } from "./candidates.ts";
import { type Fixture, fixtures } from "./corpus.ts";

export type Score = { cases: number; parsed: number; exact: number; tp: number; fn: number; fp: number; nameTp: number; nameFn: number; nameFp: number };

export function score(expect: string[], got: Answer, s: Score): void {
  s.cases++;
  if (got.ok) s.parsed++;
  const e = new Set(expect);
  const g = new Set(got.refs);
  const names = (x: Set<string>) => new Set([...x].map((r) => r.slice(r.indexOf(":") + 1)));
  const en = names(e);
  const gn = names(g);
  if (e.size === g.size && [...e].every((x) => g.has(x))) s.exact++;
  for (const x of e) (g.has(x) ? s.tp++ : s.fn++);
  for (const x of g) if (!e.has(x)) s.fp++;
  for (const x of en) (gn.has(x) ? s.nameTp++ : s.nameFn++);
  for (const x of gn) if (!en.has(x)) s.nameFp++;
}
const blank = (): Score => ({ cases: 0, parsed: 0, exact: 0, tp: 0, fn: 0, fp: 0, nameTp: 0, nameFn: 0, nameFp: 0 });

export async function runFixtures(): Promise<{ scores: Record<string, Score>; rows: Array<{ fixture: Fixture; answers: Record<string, Answer> }> }> {
  const fx = fixtures();
  const rows = fx.map((fixture) => ({ fixture, answers: {} as Record<string, Answer> }));
  for (const r of rows) {
    const from = r.fixture.inString ? "typescript" : "file";
    r.answers["today (.sql file)"] = today({ from, sql: r.fixture.sql });
    r.answers["today (string in TS)"] = today({ from: "typescript", sql: r.fixture.sql });
    for (const c of CANDIDATES) r.answers[c.name] = await c.run(r.fixture.sql, dialectFor(c, r.fixture.dialect));
  }
  const glot = sqlglot.batch(rows.map((r) => ({ sql: r.fixture.sql, dialect: dialectFor(sqlglot, r.fixture.dialect) })));
  rows.forEach((r, i) => (r.answers[sqlglot.name] = glot[i]!));
  const scores: Record<string, Score> = {};
  for (const r of rows) for (const [name, a] of Object.entries(r.answers)) score(r.fixture.expect, a, (scores[name] ??= blank()));
  return { scores, rows };
}

if (import.meta.main) {
  const { scores, rows } = await runFixtures();
  const out = process.argv.indexOf("--json");
  if (out > 0) writeFileSync(process.argv[out + 1]!, JSON.stringify({ scores, rows }, null, 1));
  console.log("| Candidate | Parsed | Cases right in full | Pairs right | Missed | False | Names found | Names missed | Names false |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const [n, s] of Object.entries(scores)) {
    console.log(`| ${n} | ${s.parsed}/${s.cases} | ${s.exact}/${s.cases} | ${s.tp}/${s.tp + s.fn} | ${s.fn} | ${s.fp} | ${s.nameTp}/${s.nameTp + s.nameFn} | ${s.nameFn} | ${s.nameFp} |`);
  }
  if (process.argv.includes("--cases")) {
    for (const r of rows) {
      console.log(`\n${r.fixture.id} [${r.fixture.dialect}] expect ${r.fixture.expect.join(" ")}`);
      for (const [n, a] of Object.entries(r.answers)) {
        const right = a.refs.length === r.fixture.expect.length && r.fixture.expect.every((x) => a.refs.includes(x));
        console.log(`  ${right ? "ok " : "BAD"} ${n}: ${a.ok ? "" : `(fail: ${a.error?.slice(0, 70)}) `}${a.refs.join(" ")}`);
      }
    }
  }
}
