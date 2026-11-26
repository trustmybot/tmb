// Step 4 of the Python A/B test (trustmybot/tmb#338): the tables. For each repo, each candidate's
// call states and scores in each environment, beside way A's, and how its links compare with way
// A's and with the other candidates'.
//
//   bun tests/benchmark/candidates/python/report.ts <scratch> <repo>...
//
// Reads <scratch>/out/<repo>.dump.json and every <scratch>/out/<repo>.<candidate>.<env>.json.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Asked, CANDIDATES } from "./ask.ts";
import type { Dump } from "./dump.ts";
import { agreement, counts, type Resolved, resolveAll, wayA } from "./score.ts";

const pct = (n: number, of: number): string => (of === 0 ? "none" : `${((n / of) * 100).toFixed(1)}% (${n}/${of})`);
const secs = (ms: number): string => (ms / 1000).toFixed(1);

export type Loaded = { dump: Dump; runs: { candidate: string; env: string; asked: Asked; resolved: Resolved[] }[]; repoCopy: string };

export function load(scratch: string, repo: string, strict = true): Loaded {
  const dump = JSON.parse(readFileSync(path.join(scratch, "out", `${repo}.dump.json`), "utf8")) as Dump;
  const repoCopy = path.join(scratch, "repos", repo);
  const runs: Loaded["runs"] = [];
  for (const candidate of CANDIDATES) {
    for (const env of ["empty", `${repo}-deps`]) {
      const file = path.join(scratch, "out", `${repo}.${candidate}.${env}.json`);
      if (!existsSync(file)) continue;
      const asked = JSON.parse(readFileSync(file, "utf8")) as Asked;
      runs.push({ candidate, env, asked, resolved: resolveAll(dump, asked, repoCopy, strict) });
    }
  }
  return { dump, runs, repoCopy };
}

const envName = (env: string): string => (env === "empty" ? "no deps" : "deps");

export function tables(l: Loaded, repo: string): string {
  const out: string[] = [];
  const a = wayA(l.dump);
  const ca = counts(a);
  out.push(`### ${repo} at ${l.dump.sha.slice(0, 7)}`, "");
  out.push(`Same for every way: functions found ${pct(l.dump.functionsFound.n, l.dump.functionsFound.of)}, calls accounted for ${pct(l.dump.callsAccountedFor.n, l.dump.callsAccountedFor.of)} against ${l.dump.referenceVersion}; ${l.dump.calls.length} calls with a state; graph built in ${secs(l.dump.graphMs)} s.`, "");
  out.push("| Way | Env | Version | Linked | Outside | Not known | Links found, by call state | Errors | Start s | Answers s | Total s |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  out.push(`| way A | n/a | built-in | ${ca.linked} | ${ca.outside} | ${ca.not_known} | ${pct(ca.linked, ca.linked + ca.not_known)} | 0 | 0 | 0 | ${secs(l.dump.graphMs)} (graph) |`);
  for (const r of l.runs) {
    const c = counts(r.resolved);
    const errors = r.asked.answers.filter((x) => "error" in x).length;
    out.push(
      `| ${r.candidate} | ${envName(r.env)} | ${r.asked.version} | ${c.linked} | ${c.outside} | ${c.not_known} | ${pct(c.linked, c.linked + c.not_known)} | ${errors} | ${secs(r.asked.startMs)} | ${secs(r.asked.answerMs)} | ${secs(r.asked.totalMs)} |`,
    );
  }
  out.push("", "Not known, by why:", "", "| Way | Env | " + ["no declaration", "a declaration in the repo that is no node", "declarations matching more than one node", "the tool failed on the call", "the callee is no name"].join(" | ") + " |", "|---|---|---|---|---|---|---|");
  for (const r of l.runs) {
    const w = counts(r.resolved).why;
    out.push(`| ${r.candidate} | ${envName(r.env)} | ${w["no declaration"] ?? 0} | ${w["a declaration in the repo that is no node"] ?? 0} | ${w["declarations matching more than one node"] ?? 0} | ${w["the tool failed on the call"] ?? 0} | ${w["the callee is no name"] ?? 0} |`);
  }
  out.push("", "Against way A: of way A's links, those the candidate links to the same node, to another node, or leaves unlinked; and the candidate's links way A lacks.", "");
  out.push("| Way | Env | Same node | Other node | Way A only | of which candidate says outside | Candidate only | of which way A says outside |", "|---|---|---|---|---|---|---|---|");
  for (const r of l.runs) {
    const g = agreement(a, r.resolved);
    out.push(`| ${r.candidate} | ${envName(r.env)} | ${g.bothSame} | ${g.bothDiffer} | ${g.onlyA} | ${g.aLinkedBOutside} | ${g.onlyB} | ${g.aOutsideBLinked} |`);
  }
  return out.join("\n");
}

/** Candidate against candidate in one environment: calls both link to the same node / to different nodes, and links one has that the other places outside. */
export function pairwise(l: Loaded, env: string): string {
  const runs = l.runs.filter((r) => r.env === env);
  const out = [`Pairwise, ${envName(env)}: same node / different node / row links where column says outside.`, "", `| | ${runs.map((r) => r.candidate).join(" | ")} |`, `|---|${runs.map(() => "---").join("|")}|`];
  for (const x of runs) {
    const cells = runs.map((y) => {
      if (x === y) return "";
      const g = agreement(x.resolved, y.resolved);
      return `${g.bothSame} / ${g.bothDiffer} / ${g.aLinkedBOutside}`;
    });
    out.push(`| ${x.candidate} | ${cells.join(" | ")} |`);
  }
  return out.join("\n");
}

if (import.meta.main) {
  const [scratch, ...repos] = process.argv.slice(2);
  if (scratch === undefined) throw new Error("usage: report.ts <scratch> <repo>...");
  const strict = !process.argv.includes("--loose");
  for (const repo of repos.filter((r) => !r.startsWith("--"))) {
    const l = load(scratch, repo, strict);
    console.log(tables(l, repo));
    console.log("");
    console.log(pairwise(l, "empty"));
    console.log("");
    console.log(pairwise(l, `${repo}-deps`));
    console.log("");
  }
}
