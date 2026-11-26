// The samples to judge by hand (trustmybot/tmb#346), from a measure.ts output:
//   bun tests/benchmark/candidates/go/handcheck.ts <out.json> <repo dir> [disagree count] [agree count]
// - disagree: calls where the candidates do not give the same state and node, at least one of them
//   linking; every one when there are fewer than asked, else a sample spread evenly over the list;
// - agree: calls every candidate links to the same node, spread evenly over the list;
// - states differ: calls no candidate links whose states differ (outside, not known, conversion).
// Each is printed with its line of code and the go/types declaration, for a reader to judge.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Row } from "./measure.ts";

/** The default sizes, as the brief for #346 asks: at least 30 disagreements and 20 agreements. */
const DISAGREE = 30;
const AGREE = 20;

const [outPath, repo, dn, an] = process.argv.slice(2);
if (!outPath || !repo) throw new Error("usage: handcheck.ts <out.json> <repo> [disagree] [agree]");
const out = JSON.parse(readFileSync(outPath, "utf8")) as { results: Record<string, { default: { rows: Row[] } }>; referenceCalls: { file: string; pos: number; decl?: { file: string; line: number; kind: string } }[] };
const names = Object.keys(out.results);
const rows = names.map((n) => out.results[n]?.default.rows ?? []);
const ref = new Map(out.referenceCalls.map((c) => [`${c.file}:${c.pos}`, c]));
const lines = new Map<string, string[]>();
const code = (file: string, line: number) => {
  let l = lines.get(file);
  if (!l) {
    l = readFileSync(join(repo, file), "utf8").split("\n");
    lines.set(file, l);
  }
  return (l[line - 1] ?? "").trim();
};
const say = (r: Row) => (r.state === "linked" ? `${r.node?.qualified} (${r.node?.file}:${r.node?.start})` : r.state);

const disagree: number[] = [];
const states: number[] = [];
const agree: number[] = [];
for (let i = 0; i < (rows[0]?.length ?? 0); i++) {
  const here = rows.map((rs) => rs[i] as Row);
  const said = new Set(here.map(say));
  if (said.size > 1 && here.some((r) => r.state === "linked")) disagree.push(i);
  else if (said.size > 1) states.push(i);
  else if (said.size === 1 && here[0]?.state === "linked") agree.push(i);
}
const spread = (list: number[], n: number) => (list.length <= n ? list : Array.from({ length: n }, (_, k) => list[Math.floor((k * list.length) / n)] as number));

for (const [title, list, n] of [
  ["disagree", disagree, Number(dn ?? DISAGREE)],
  ["agree", agree, Number(an ?? AGREE)],
  ["states differ, none linked", states, Number(dn ?? DISAGREE)],
] as const) {
  console.log(`## ${title}: ${list.length} in all, ${Math.min(n, list.length)} shown`);
  for (const i of spread(list, n)) {
    const r0 = rows[0]?.[i] as Row;
    const d = ref.get(`${r0.file}:${r0.pos}`)?.decl;
    console.log(`${r0.file}:${r0.line} \`${r0.name}\` | ${code(r0.file, r0.line)} | go/types decl: ${d ? `${d.file}:${d.line} ${d.kind}` : "none"} | ${names.map((n2, k) => `${n2}: ${say(rows[k]?.[i] as Row)}`).join(" | ")}`);
  }
}
