// Step 5 of the Python A/B test (trustmybot/tmb#338): the calls to check by hand. Python has no
// reference for links right, so where the ways disagree on a link a sample is opened and judged
// by a person, and so is a sample of the links every candidate agrees on.
//
//   bun tests/benchmark/candidates/python/sample.ts <scratch> <repo> <env> <disagree> <agree> <candidate>...
//
// The sample is drawn with a fixed seed, so it is the same on every run. Disagreements are drawn
// in order of how much they say: two ways linking different nodes first, then a link another way
// puts outside, then a link only some ways make, spread over the ways that make it.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DumpNode } from "./dump.ts";
import { load } from "./report.ts";
import { type Resolved, wayA } from "./score.ts";

/** The seed of the draw. */
const SEED = 338;
/** Lines of code shown before and after the call. */
const CONTEXT = 2;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

if (import.meta.main) {
  const [scratch, repo, env, disagreeN, agreeN, ...candidates] = process.argv.slice(2);
  if (candidates.length === 0) throw new Error("usage: sample.ts <scratch> <repo> <env> <disagree> <agree> <candidate>...");
  const l = load(scratch!, repo!);
  const runs = candidates.map((c) => {
    const r = l.runs.find((x) => x.candidate === c && x.env === env);
    if (r === undefined) throw new Error(`no run of ${c} in ${env}`);
    return r;
  });
  const ways: { name: string; resolved: Resolved[] }[] = [{ name: "way A", resolved: wayA(l.dump) }, ...runs.map((r) => ({ name: r.candidate, resolved: r.resolved }))];
  const nodes = new Map<number, DumpNode>(l.dump.nodes.map((n) => [n.id, n]));
  const label = (r: Resolved) => (r.state === "linked" ? `${nodes.get(r.node!)!.path}:${nodes.get(r.node!)!.start} ${nodes.get(r.node!)!.name} (${nodes.get(r.node!)!.kind})` : r.state);
  // Calls linked to different nodes, by their shape: which ways link which kind of node. One
  // tool's convention (a construction linked to __init__, say) makes many calls of one shape, so
  // the draw spreads over the shapes rather than over the calls.
  const differ = new Map<string, number[]>();
  const shape = (rs: Resolved[]): string => {
    const firsts = new Map<number, string>();
    return ways
      .map((w, k) => {
        const r = rs[k]!;
        if (r.state !== "linked") return `${w.name}:${r.state}`;
        const n = nodes.get(r.node!)!;
        if (!firsts.has(r.node!)) firsts.set(r.node!, String.fromCharCode(65 + firsts.size));
        const own = n.name.startsWith("__") ? ` ${n.name}` : "";
        return `${w.name}:${firsts.get(r.node!)} ${n.kind}${own}`;
      })
      .join(", ");
  };
  const vsOutside: number[] = [];
  const someLink = new Map<string, number[]>();
  const agree: number[] = [];
  l.dump.calls.forEach((_, i) => {
    const rs = ways.map((w) => w.resolved[i]!);
    const linked = new Set(rs.filter((r) => r.state === "linked").map((r) => r.node));
    const cands = rs.slice(1);
    if (cands.every((r) => r.state === "linked" && r.node === cands[0]!.node)) {
      agree.push(i);
      if (rs[0]!.state === "linked" && rs[0]!.node === cands[0]!.node) return;
    }
    if (linked.size === 0) return;
    if (linked.size > 1) {
      const key = shape(rs);
      differ.set(key, [...(differ.get(key) ?? []), i]);
    }
    else if (rs.some((r) => r.state === "outside")) vsOutside.push(i);
    else if (rs.some((r) => r.state !== "linked")) {
      const key = ways.filter((_, k) => rs[k]!.state === "linked").map((w) => w.name).join("+");
      someLink.set(key, [...(someLink.get(key) ?? []), i]);
    }
  });
  const rand = rng(SEED);
  const want = Number(disagreeN);
  const picked: number[] = [];
  const take = (xs: number[], n: number) => {
    for (const i of shuffled(xs, rand).slice(0, n)) if (!picked.includes(i)) picked.push(i);
  };
  // Spread n picks over groups, the smallest groups first, so each group gets its share or all it has.
  const spread = (groups: [string, number[]][], n: number) => {
    const sorted = [...groups].sort((a, b) => a[1].length - b[1].length);
    let left = n;
    sorted.forEach(([, xs], k) => {
      const before = picked.length;
      take(xs, Math.ceil(left / (sorted.length - k)));
      left -= picked.length - before;
    });
  };
  spread([...differ.entries()], Math.ceil(want / 3));
  take(vsOutside, Math.ceil(want / 4));
  // The rest spread over each set of ways that alone link.
  spread([...someLink.entries()], want - picked.length);
  const texts = new Map<string, string[]>();
  const show = (i: number, tag: string) => {
    const c = l.dump.calls[i]!;
    if (!texts.has(c.path)) texts.set(c.path, readFileSync(path.join(l.repoCopy, c.path), "utf8").split("\n"));
    const lines = texts.get(c.path)!;
    console.log(`\n#${tag} ${c.path}:${c.line} \`${c.name}\` (call ${i})`);
    for (let k = Math.max(0, c.line0 - CONTEXT); k <= Math.min(lines.length - 1, c.line0 + CONTEXT); k++) console.log(`${k === c.line0 ? ">" : " "} ${k + 1}: ${lines[k]}`);
    for (const w of ways) console.log(`    ${w.name}: ${label(w.resolved[i]!)}`);
  };
  const differN = [...differ.values()].reduce((s, x) => s + x.length, 0);
  console.log(`${repo} ${env}: ${differN} calls linked to different nodes, ${vsOutside.length} linked by one way and outside by another, ${[...someLink.values()].reduce((s, x) => s + x.length, 0)} linked by some ways only (${[...someLink.entries()].map(([k, v]) => `${k}: ${v.length}`).join(", ")}); ${agree.length} linked to one node by every candidate`);
  console.log("\nLinked to different nodes, by shape:");
  for (const [k, v] of [...differ.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${v.length}: ${k}`);
  picked.forEach((i, k) => show(i, `D${k + 1}`));
  shuffled(agree, rand)
    .slice(0, Number(agreeN))
    .forEach((i, k) => show(i, `S${k + 1}`));
}
