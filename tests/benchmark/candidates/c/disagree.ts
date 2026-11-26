// Lists the calls of a run (calls.jsonl from run.ts) on which the candidates disagree, by kind,
// and draws the samples for the hand checks: links where they disagree and links where all agree.
// The sample is drawn with a fixed seed, so a rerun picks the same calls.
//
//   bun tests/benchmark/candidates/c/disagree.ts <calls.jsonl> [candidates] [sample size]
import { readFileSync } from "node:fs";

const [file, which, size] = process.argv.slice(2);
type Row = Record<string, any> & { key: string; name: string; owner: string | null; ref: { state: string; links: string[]; decls: string[]; dynamic: boolean } | null };
const rows: Row[] = readFileSync(file!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cands = (which ?? "clang,clangd-apple,clangd,scip-clang").split(",").filter((c) => c in rows[0]!);
const n = Number(size ?? 30);

const view = (r: Row, c: string) => `${r[c].state}${r[c].links.length ? " " + r[c].links.join("+") : ""}`;
const kinds = new Map<string, Row[]>();
const agreeLinked: Row[] = [];
for (const r of rows) {
  const views = cands.map((c) => view(r, c));
  if (new Set(views).size === 1) {
    if (r[cands[0]!].state === "linked") agreeLinked.push(r);
    continue;
  }
  const kind = cands.map((c, i) => `${c}=${r[c].state}`).join(" ") + (new Set(views.filter((v) => v.startsWith("linked"))).size > 1 ? " (different links)" : "");
  kinds.set(kind, [...(kinds.get(kind) ?? []), r]);
}
console.log(`calls ${rows.length}; disagree ${[...kinds.values()].reduce((s, x) => s + x.length, 0)}; all agree and linked ${agreeLinked.length}`);
for (const [k, rs] of [...kinds].sort((a, b) => b[1].length - a[1].length)) console.log(`${String(rs.length).padStart(6)}  ${k}`);

let seed = 346;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const sample = <T,>(xs: T[], k: number) => {
  const copy = [...xs];
  const out: T[] = [];
  while (out.length < k && copy.length > 0) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]!);
  return out;
};
// The disagreements that involve a link, spread over the kinds by size.
const linkDisagree = [...kinds.values()].flat().filter((r) => cands.some((c) => r[c].state === "linked"));
console.log(`\nSAMPLE disagree-with-a-link (${linkDisagree.length})`);
for (const r of sample(linkDisagree, n)) console.log(JSON.stringify({ key: r.key, name: r.name, ref: r.ref && `${r.ref.state} ${r.ref.links.join("+")}`, ...Object.fromEntries(cands.map((c) => [c, view(r, c)])) }));
console.log(`\nSAMPLE all-agree-linked (${agreeLinked.length})`);
for (const r of sample(agreeLinked, 20)) console.log(JSON.stringify({ key: r.key, name: r.name, ref: r.ref && `${r.ref.state} ${r.ref.links.join("+")}`, link: view(r, cands[0]!) }));
