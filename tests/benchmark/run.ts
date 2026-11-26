// The code graph's benchmark (trustmybot/tmb#244): each repo of the set, measured against its
// language's own tool, with the four scores of CODE_GRAPH.md's Benchmark section per way, per
// language and per repo.
//
//   bun tests/benchmark/run.ts           measure, print the scores, and say which stored ones fell or rose
//   bun tests/benchmark/run.ts --check   the same, and fail when a stored score fell (the heavy test)
//   bun tests/benchmark/run.ts --write   measure and store the scores in scores.json, refused when one fell
//
// scores.json is written by `--write` alone, never by hand. A pull request that raises a stored
// score shows the run's output. tmb is measured at its HEAD commit; the public repos at their
// pinned commits, fetched with `bun tests/lib/pinned-repo.ts <name>`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { measurePython } from "./python.ts";
import { BENCH_REPOS, locate } from "./repos.ts";
import { type Entry, entry, falls, format, isNotScored, rises, SCORE_NAMES, type ScoreName, type Stored, WAYS } from "./score.ts";
import { measureTypescript, REFERENCE as TS_REFERENCE } from "./typescript.ts";

export const SCORES_FILE = path.join(import.meta.dir, "scores.json");
const COMMAND = "bun tests/benchmark/run.ts --write";

const TITLES: Record<ScoreName, string> = {
  functionsFound: "Functions found",
  linksRight: "Links right",
  linksFoundByState: "Links found, by call state",
  linksFoundByReference: "Links found, against the reference",
  callsAccountedFor: "Calls accounted for",
};

type Run = { stored: Stored; seconds: Record<string, { graph: number; reference: number }>; detail: Record<string, string[]> };

/** Measures every repo of the set; throws, naming each, when one cannot be measured. */
async function measureAll(): Promise<Run> {
  const errors: string[] = [];
  const entries: Entry[] = [];
  const seconds: Run["seconds"] = {};
  const detail: Run["detail"] = {};
  for (const r of BENCH_REPOS) {
    const where = locate(r);
    if ("error" in where) {
      errors.push(`${r.repo}: ${where.error}`);
      continue;
    }
    const sha = resolveCommit(where.folder, where.ref);
    if (sha === null) {
      errors.push(`${r.repo}: ${where.folder} has no commit ${where.ref}`);
      continue;
    }
    console.error(`measuring ${r.repo} (${r.language}) at ${sha.slice(0, 7)}…`);
    const m = r.language === "typescript" ? { ...(await measureTypescript(where.folder, sha)), reference: TS_REFERENCE } : await measurePython(where.folder, sha);
    entries.push(entry({ repo: r.repo, language: r.language, commit: sha, reference: m.reference }, m.scores));
    seconds[r.repo] = { graph: m.ms.graph / 1000, reference: m.ms.reference / 1000 };
    detail[r.repo] = m.detail;
  }
  if (errors.length > 0) throw new Error(`the benchmark cannot measure:\n${errors.join("\n")}`);
  return { stored: { command: COMMAND, entries }, seconds, detail };
}

/** The scores as Markdown tables, for the terminal and for a pull request. */
export function report(run: Run): string {
  const out: string[] = [];
  out.push(`| Repo | Language | Commit | Way | ${SCORE_NAMES.map((n) => TITLES[n]).join(" | ")} |`);
  out.push(`|---|---|---|---|${SCORE_NAMES.map(() => "---").join("|")}|`);
  for (const e of run.stored.entries) {
    for (const way of WAYS) out.push(`| ${e.repo} | ${e.language} | ${e.commit.slice(0, 7)} | ${way} | ${SCORE_NAMES.map((n) => format(e.ways[way][n])).join(" | ")} |`);
  }
  out.push("", "Reference and time, in seconds:", "", "| Repo | Reference | Graph built | Reference and scoring |", "|---|---|---|---|");
  for (const e of run.stored.entries) {
    const s = run.seconds[e.repo];
    out.push(`| ${e.repo} | ${e.reference} | ${s?.graph.toFixed(1) ?? ""} | ${s?.reference.toFixed(1) ?? ""} |`);
  }
  out.push("", "Misses by cause, way A: the reference's links the graph does not have, by the kind of code that hides them.");
  for (const e of run.stored.entries) {
    const causes = e.ways.A.missesByCause;
    out.push("", `${e.repo} (${e.language}):${isNotScored(causes) ? ` ${causes.notScored}` : ""}`);
    if (!isNotScored(causes)) for (const [cause, n] of Object.entries(causes)) out.push(`- ${n}: ${cause}`);
  }
  return out.join("\n");
}

function readStored(): Stored | null {
  return existsSync(SCORES_FILE) ? (JSON.parse(readFileSync(SCORES_FILE, "utf8")) as Stored) : null;
}

async function main(args: string[]): Promise<number> {
  const write = args.includes("--write");
  const check = args.includes("--check");
  const run = await measureAll();
  console.log(report(run));
  for (const [repo, lines] of Object.entries(run.detail)) for (const line of lines) console.log(`${repo}: ${line}`);
  const stored = readStored();
  const fell = stored === null ? [] : falls(stored, run.stored);
  const rose = stored === null ? [] : rises(stored, run.stored);
  if (stored === null) console.log(`\nno stored scores yet in ${SCORES_FILE}`);
  for (const r of rose) console.log(`rose: ${r}`);
  for (const f of fell) console.log(`FELL: ${f}`);
  if (fell.length > 0 && (check || write)) {
    console.error(`\n${fell.length} stored scores fell; the benchmark fails${write ? ", and the scores are not written" : ""}.`);
    return 1;
  }
  if (write) {
    writeFileSync(SCORES_FILE, `${JSON.stringify(run.stored, null, 2)}\n`);
    console.log(`\nwrote ${SCORES_FILE}`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
