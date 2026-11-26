// Research harness for trustmybot/tmb#339: the corpus results run.ts wrote, summed.
//   bun tests/benchmark/candidates/sql/summary.ts <corpus-out.json> [--disagree N]
// Per answer source: units it parsed, units it named a table in, table pairs, the share of units
// where it agrees in full with sqlglot (on the units sqlglot parsed), and the start-up and per-unit
// time. With --disagree, prints N units where the carriable candidates disagree, for the hand check.
import { readFileSync } from "node:fs";
import type { Row } from "./run.ts";

const rows = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Row[];
const sources = Object.keys(rows[0]!.answers);
const JUDGE = "sqlglot (Python, judge)";
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.unit.repo} ${r.unit.from}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
groups.set("all", rows);
for (const [g, rs] of groups) {
  console.log(`\n### ${g} (${rs.length} units)\n`);
  console.log("| Source | Parsed | Units with a table | Table pairs | Hole tables | Same as sqlglot (where it parsed) | Median ms per unit |");
  console.log("|---|---|---|---|---|---|---|");
  const judged = rs.filter((r) => r.answers[JUDGE]!.ok);
  for (const s of sources) {
    const parsed = rs.filter((r) => r.answers[s]!.ok).length;
    const withTable = rs.filter((r) => r.answers[s]!.refs.length > 0).length;
    const pairs = rs.reduce((n, r) => n + r.answers[s]!.refs.length, 0);
    const holes = rs.reduce((n, r) => n + r.answers[s]!.refs.filter((x) => x.endsWith(":?")).length, 0);
    const agree = judged.filter((r) => same(r.answers[s]!.refs, r.answers[JUDGE]!.refs)).length;
    const ms = rs.map((r) => r.ms[s]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const med = ms.length ? ms[Math.floor(ms.length / 2)]!.toFixed(2) : "";
    console.log(`| ${s} | ${parsed} | ${withTable} | ${pairs} | ${holes} | ${agree}/${judged.length} | ${med} |`);
  }
}

const n = process.argv.indexOf("--disagree");
if (n > 0) {
  const want = Number(process.argv[n + 1] ?? "40");
  const CARRIABLE = ["today", "node-sql-parser", "sqlparser-rs (wasm)", "polyglot-sql", "tree-sitter-sql", JUDGE];
  const dis = rows.filter((r) => new Set(CARRIABLE.map((s) => JSON.stringify(r.answers[s]!.refs))).size > 1);
  console.log(`\n${dis.length} units where ${CARRIABLE.join(", ")} disagree`);
  // A fixed stride over the disagreements, so the sample is spread over the repos and not picked.
  const stride = Math.max(1, Math.floor(dis.length / want));
  dis
    .filter((_, i) => i % stride === 0)
    .slice(0, want)
    .forEach((r, i) => {
      console.log(`\n#${i + 1} ${r.unit.repo} ${r.unit.path}:${r.unit.line} (${r.unit.from})`);
      console.log(r.unit.sql.length > 700 ? `${r.unit.sql.slice(0, 700)} …` : r.unit.sql);
      for (const s of CARRIABLE) console.log(`  ${s}: ${r.answers[s]!.ok ? "" : "(fail) "}${r.answers[s]!.refs.join(" ")}`);
    });
}
