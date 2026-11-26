// Research harness for trustmybot/tmb#339: the hand check of the corpus units where sources disagree.
//   bun tests/benchmark/candidates/sql/handcheck.ts <corpus-out.json> pick <N> > sample.txt
//   bun tests/benchmark/candidates/sql/handcheck.ts <corpus-out.json> score <gold.json>
// "pick" takes a fixed stride over two pools so the sample is spread and not chosen: (a) units where
// the parsers disagree among themselves, (b) units where today's patterns (run in every language)
// disagree with the parsers' majority. Each unit is keyed by its index in corpus-out.json.
// "score" reads a gold file {key: string[]} written by hand from reading each statement, and counts,
// per source, statements right in full and table pairs found, missed and false. A source whose parse
// failed counts with the refs it still gave, and again with none (the "links on proof" reading).
import { readFileSync } from "node:fs";
import type { Row } from "./run.ts";

const PARSERS = ["node-sql-parser", "sqlparser-rs (wasm)", "polyglot-sql", "tree-sitter-sql", "sqlglot (Python, judge)"];
const TODAY = "today's patterns, every language";
const key = (rows: Row[], r: Row): string => String(rows.indexOf(r));
const sig = (r: Row, s: string): string => JSON.stringify([...r.answers[s]!.refs].sort());

const rows = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Row[];
const mode = process.argv[3];

function majority(r: Row): string {
  const n = new Map<string, number>();
  for (const s of PARSERS) n.set(sig(r, s), (n.get(sig(r, s)) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}
function stride<T>(xs: T[], want: number): T[] {
  const step = Math.max(1, Math.floor(xs.length / want));
  return xs.filter((_, i) => i % step === 0).slice(0, want);
}

if (mode === "pick") {
  const want = Number(process.argv[4] ?? "20");
  const a = rows.filter((r) => new Set(PARSERS.map((s) => sig(r, s))).size > 1);
  const b = rows.filter((r) => !a.includes(r) && sig(r, TODAY) !== majority(r));
  console.log(`pool a (parsers disagree): ${a.length}; pool b (today's patterns against the parsers, parsers agree): ${b.length}`);
  for (const [pool, rs] of [["a", stride(a, want)], ["b", stride(b, want)]] as const) {
    for (const r of rs) {
      console.log(`\n#${key(rows, r)} [${pool}] ${r.unit.repo} ${r.unit.path}:${r.unit.line} (${r.unit.from})`);
      console.log(r.unit.sql.length > 900 ? `${r.unit.sql.slice(0, 900)} …` : r.unit.sql);
      for (const s of ["today", TODAY, ...PARSERS]) console.log(`  ${s}: ${r.answers[s]!.ok ? "" : "(fail) "}${r.answers[s]!.refs.join(" ")}`);
    }
  }
} else if (mode === "score") {
  const gold = JSON.parse(readFileSync(process.argv[4]!, "utf8")) as Record<string, { pool: string; expect: string[]; note?: string }>;
  console.log("| Source | Reading | Statements right in full | Pairs right | Missed | False |");
  console.log("|---|---|---|---|---|---|");
  for (const s of ["today", TODAY, ...PARSERS]) {
    for (const proof of [false, true]) {
      if (proof && (s === "today" || s === TODAY)) continue;
      let exact = 0, tp = 0, fn = 0, fp = 0;
      for (const [k, g] of Object.entries(gold)) {
        const a = rows[Number(k)]!.answers[s]!;
        const got = new Set(proof && !a.ok ? [] : a.refs);
        const e = new Set(g.expect);
        if (e.size === got.size && [...e].every((x) => got.has(x))) exact++;
        for (const x of e) (got.has(x) ? tp++ : fn++);
        for (const x of got) if (!e.has(x)) fp++;
      }
      const n = Object.keys(gold).length;
      console.log(`| ${s} | ${proof ? "refs only from a clean parse" : "every ref"} | ${exact}/${n} | ${tp}/${tp + fn} | ${fn} | ${fp} |`);
    }
  }
} else throw new Error("usage: handcheck.ts <corpus-out.json> pick <N> | score <gold.json>");
