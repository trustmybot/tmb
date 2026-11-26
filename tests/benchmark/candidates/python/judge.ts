// Step 6 of the Python A/B test (trustmybot/tmb#338): the hand check, scored. A person read each
// call sample.ts drew and wrote down, in handcheck/<repo>.json, the node it calls ("path:line"
// where the node starts), or "not_known" when no one node is right, and the other answers that
// are defensible under another convention (a construction linked to __init__, an @overload stub,
// the method of a declared type that is outside). Each way's answer is then:
// - right: the node written down, or not known when that is what is written;
// - other convention: one of the defensible answers;
// - missed: not known where a node is right;
// - wrong: another node, outside where a node in the repo is right, or a link where no one node
//   is right.
//
//   bun tests/benchmark/candidates/python/judge.ts <scratch> <repo>
import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "./report.ts";
import { type Resolved, wayA } from "./score.ts";

type Judged = { tag: string; call: number; right: string; alt: string[]; why: string };
type Verdict = "right" | "other convention" | "missed" | "wrong";
const VERDICTS: Verdict[] = ["right", "other convention", "missed", "wrong"];

if (import.meta.main) {
  const [scratch, repo] = process.argv.slice(2);
  if (scratch === undefined || repo === undefined) throw new Error("usage: judge.ts <scratch> <repo>");
  const h = JSON.parse(readFileSync(path.join(import.meta.dir, "handcheck", `${repo}.json`), "utf8")) as { env: string; calls: Judged[] };
  const l = load(scratch, repo);
  const nodes = new Map(l.dump.nodes.map((n) => [n.id, `${n.path}:${n.start}`]));
  const runs = l.runs.filter((r) => r.env === h.env);
  const ways: { name: string; resolved: Resolved[] }[] = [{ name: "way A", resolved: wayA(l.dump) }, ...runs.map((r) => ({ name: r.candidate, resolved: r.resolved }))];
  const answer = (r: Resolved): string => (r.state === "linked" ? nodes.get(r.node!)! : r.state);
  const verdict = (j: Judged, r: Resolved): Verdict => {
    const a = answer(r);
    if (a === j.right) return "right";
    if (j.alt.includes(a)) return "other convention";
    if (j.right === "not_known") return r.state === "linked" ? "wrong" : "right";
    if (r.state === "not_known") return "missed";
    return "wrong";
  };
  for (const part of ["D", "S"]) {
    const js = h.calls.filter((j) => j.tag.startsWith(part));
    console.log(`\n${part === "D" ? "Disagreements" : "Links every candidate agrees on"}, ${repo} ${h.env}: ${js.length} calls`);
    console.log(`\n| Way | ${VERDICTS.join(" | ")} |\n|---|${VERDICTS.map(() => "---").join("|")}|`);
    for (const w of ways) {
      const n = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
      for (const j of js) n[verdict(j, w.resolved[j.call]!)]++;
      console.log(`| ${w.name} | ${VERDICTS.map((v) => n[v]).join(" | ")} |`);
    }
    // The table of calls: where, what is right, and each way's verdict in one letter.
    const letter: Record<Verdict, string> = { right: "R", "other convention": "c", missed: "-", wrong: "X" };
    console.log(`\n| # | Call | Right answer | ${ways.map((w) => w.name).join(" | ")} | Why |\n|---|---|---|${ways.map(() => "---").join("|")}|---|`);
    for (const j of js) {
      const c = l.dump.calls[j.call]!;
      console.log(`| ${j.tag} | ${c.path}:${c.line} \`${c.name}\` | ${j.right} | ${ways.map((w) => letter[verdict(j, w.resolved[j.call]!)]).join(" | ")} | ${j.why} |`);
    }
  }
}
