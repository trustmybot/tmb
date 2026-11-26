// The A/B test of way B's tool for TypeScript and JavaScript (trustmybot/tmb#338). Research only:
// it writes nothing into the repo and changes no stored score.
//
//   TMB_CANDIDATE_TS7=<typescript@7 package folder> TMB_PINNED_HONO=<hono> \
//     bun tests/benchmark/candidates/typescript/ab.ts <out-folder> [candidate ids…]
//
// For each TypeScript repo of the benchmark (repos.ts) and each candidate (candidates.ts), the
// graph is built by way B with that candidate as the tool, and scored by the benchmark's own
// measure (typescript.ts, score.ts): the same nodes, the same definitions. Beside it:
// - every link the candidate makes, same file included, is judged by the TypeScript 5.9
//   compiler's answer for the call at the same position (the benchmark's reference program,
//   links.ts): right when one of its declarations is in the link's file and overlaps the
//   target's lines; wrong when it names declarations and none is, or only one outside the repo;
//   not judged when it has no answer;
// - every call two candidates answer differently is listed with that judge's verdict, for the
//   sample checked by hand.
// The out folder gets one JSON file per repo, and the tables are printed.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveCommit } from "../../../../src/engine/graph/git-source.ts";
import type { ToolAnswer } from "../../../../src/engine/graph/languages/contract.ts";
import { type CompilerCall, commitTexts, compilerProgram } from "../../../../src/engine/graph/languages/typescript/links.ts";
import { BENCH_REPOS, locate } from "../../repos.ts";
import { format, SCORE_NAMES, type WayScores } from "../../score.ts";
import { measureTypescript } from "../../typescript.ts";
import { CANDIDATES, type Recorded, recording, withTool } from "./candidates.ts";
import { lastTs7Timing } from "./ts7.ts";

type Verdict = "right" | "wrong" | "not judged";

/** One call as the A/B report shows it: its place, and each candidate's answer as text. */
type CallRow = { file: string; line: number; pos: number; name: string; answers: Record<string, string>; judge: string; verdicts: Record<string, Verdict> };

type CandidateResult = {
  id: string;
  label: string;
  scores: WayScores;
  graphMs: number;
  toolMs: { open: number; answer: number };
  bridge: unknown;
  detail: string[];
  states: { linked: number; outside: number; notKnown: number };
  allLinks: { links: number; right: number; wrong: number; notJudged: number; sameFile: number };
  wrong: string[];
};

const lineOfPos = (text: string, pos: number): number => {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** The reference's declarations for a call, as text. */
function describeReference(call: CompilerCall | undefined): string {
  if (call === undefined) return "no call at this position";
  const a = call.answer;
  if (a.kind === "unknown") return "no answer";
  if (a.kind === "external") return "outside the repo";
  return a.decls.map((d) => `${d.file}:${d.spans.map((s) => `${s.start}-${s.end}`).join(",")}`).join(" | ");
}

/** The judge's verdict on one answer of a candidate: a link is right or wrong; any other state is not a link. */
function verdictOf(answer: ToolAnswer, node: { path: string; start: number; end: number } | undefined, ref: CompilerCall | undefined): Verdict {
  if (!("node" in answer) || node === undefined) return "not judged";
  if (ref === undefined || ref.answer.kind === "unknown") return "not judged";
  if (ref.answer.kind === "external") return "wrong";
  const hit = ref.answer.decls.some((d) => d.file === node.path && d.spans.some((s) => s.start <= node.end && s.end >= node.start));
  return hit ? "right" : "wrong";
}

async function measureRepo(repo: string, folder: string, sha: string, ids: readonly string[]) {
  console.error(`${repo}: the reference program (TypeScript 5.9)…`);
  const texts = commitTexts(folder, sha);
  const reference = compilerProgram(folder, sha, texts);
  const refAt = new Map<string, CompilerCall>();
  const refFiles = new Set<string>();
  const refOf = (file: string, pos: number, name: string): CompilerCall | undefined => {
    if (!refFiles.has(file)) {
      refFiles.add(file);
      for (const c of reference.calls(file)) for (const n of c.names) refAt.set(`${file}:${c.pos}:${n}`, c);
    }
    return refAt.get(`${file}:${pos}:${name}`);
  };

  const results: CandidateResult[] = [];
  const recorded = new Map<string, Recorded>();
  for (const candidate of CANDIDATES.filter((c) => ids.includes(c.id))) {
    console.error(`${repo}: way B with ${candidate.label}…`);
    const into: { value: Recorded | null } = { value: null };
    lastTs7Timing.value = null;
    const m = await withTool(recording(candidate.tool, into), () => measureTypescript(folder, sha, "B"));
    const rec = into.value;
    if (rec === null) throw new Error(`${candidate.id} was never asked: ${m.detail.join("; ")}`);
    recorded.set(candidate.id, rec);
    const states = { linked: 0, outside: 0, notKnown: 0 };
    const all = { links: 0, right: 0, wrong: 0, notJudged: 0, sameFile: 0 };
    const wrong: string[] = [];
    rec.calls.forEach((call, i) => {
      const a = rec.answers[i]!;
      if ("node" in a) states.linked++;
      else if (a.state === "outside") states.outside++;
      else states.notKnown++;
      if (!("node" in a)) return;
      const node = rec.nodes[a.node]!;
      all.links++;
      if (node.path === call.path) all.sameFile++;
      const ref = refOf(call.path, call.pos, call.name);
      const v = verdictOf(a, node, ref);
      if (v === "right") all.right++;
      else if (v === "wrong") {
        all.wrong++;
        wrong.push(`${call.path}:${lineOfPos(texts.get(call.path) ?? "", call.pos)} \`${call.name}\` -> ${node.path}:${node.start}-${node.end} ${node.name}; TypeScript 5.9: ${describeReference(ref)}`);
      } else all.notJudged++;
    });
    results.push({
      id: candidate.id,
      label: candidate.label,
      scores: m.scores,
      graphMs: m.ms.graph,
      toolMs: rec.ms,
      bridge: lastTs7Timing.value,
      detail: m.detail.filter((d) => !d.startsWith("missed")),
      states,
      allLinks: all,
      wrong,
    });
  }

  // Every call the candidates answer differently.
  const differ: CallRow[] = [];
  const [first] = recorded.values();
  if (first !== undefined && recorded.size > 1) {
    const show = (rec: Recorded, a: ToolAnswer): string => {
      if (!("node" in a)) return a.state;
      const n = rec.nodes[a.node]!;
      return `${n.path}:${n.start}-${n.end} ${n.name}`;
    };
    first.calls.forEach((call, i) => {
      const answers: Record<string, string> = {};
      const verdicts: Record<string, Verdict> = {};
      const ref = refOf(call.path, call.pos, call.name);
      for (const [id, rec] of recorded) {
        const a = rec.answers[i]!;
        answers[id] = show(rec, a);
        verdicts[id] = verdictOf(a, "node" in a ? rec.nodes[a.node] : undefined, ref);
      }
      if (new Set(Object.values(answers)).size > 1) {
        differ.push({ file: call.path, line: lineOfPos(texts.get(call.path) ?? "", call.pos), pos: call.pos, name: call.name, answers, judge: describeReference(ref), verdicts });
      }
    });
  }
  return { repo, commit: sha, results, differ };
}

function table(repo: string, r: CandidateResult): string {
  const s = r.scores;
  const rows = [
    ...SCORE_NAMES.map((n) => `| ${n} | ${format(s[n])} |`),
    `| links, all (same file included), judged by TypeScript 5.9 by position | ${r.allLinks.links} links: ${r.allLinks.right} right, ${r.allLinks.wrong} wrong, ${r.allLinks.notJudged} not judged (${r.allLinks.sameFile} in the same file) |`,
    `| call states | ${r.states.linked} linked, ${r.states.outside} outside, ${r.states.notKnown} not known |`,
    `| graph built (time to index), way B | ${(r.graphMs / 1000).toFixed(1)} s |`,
    `| the tool alone: open, answer | ${(r.toolMs.open / 1000).toFixed(2)} s, ${(r.toolMs.answer / 1000).toFixed(1)} s |`,
  ];
  return [`#### ${repo}: ${r.label}`, "", "| Measure | Value |", "|---|---|", ...rows].join("\n");
}

async function main(args: string[]): Promise<number> {
  const [out, ...rest] = args;
  if (out === undefined) {
    console.error("usage: bun tests/benchmark/candidates/typescript/ab.ts <out-folder> [candidate ids…]");
    return 2;
  }
  const ids = rest.length > 0 ? rest : CANDIDATES.map((c) => c.id);
  mkdirSync(out, { recursive: true });
  for (const r of BENCH_REPOS.filter((b) => b.language === "typescript")) {
    const where = locate(r);
    if ("error" in where) throw new Error(`${r.repo}: ${where.error}`);
    const sha = resolveCommit(where.folder, where.ref);
    if (sha === null) throw new Error(`${r.repo}: no commit ${where.ref}`);
    const m = await measureRepo(r.repo, where.folder, sha, ids);
    writeFileSync(path.join(out, `${r.repo}.json`), JSON.stringify(m, null, 1));
    for (const c of m.results) {
      console.log(`\n${table(r.repo, c)}\n`);
      for (const d of c.detail) console.log(`- ${d}`);
      for (const w of c.wrong.slice(0, 20)) console.log(`- judged wrong: ${w}`);
    }
    console.log(`\n${r.repo}: ${m.differ.length} calls the candidates answer differently`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
