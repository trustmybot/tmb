// The code graph's benchmark (trustmybot/tmb#244): each repo of the set, measured against its
// language's own tool, with the four scores of CODE_GRAPH.md's Benchmark section per way, per
// language and per repo.
//
//   bun tests/benchmark/run.ts           measure, print the scores, and say which stored ones fell or rose
//   bun tests/benchmark/run.ts --check   the same, and fail when an enforced stored score fell (the heavy test)
//   bun tests/benchmark/run.ts --write   measure and store the scores in scores.json, refused when one fell
//   bun tests/benchmark/run.ts --write --accept-fall <issue>
//                                        the same, but a fall in links found is stored with the issue
//                                        that caused it, refused unless links right is 100% for that
//                                        repo and way; `--check` then passes on the recorded score
//
// Each language's reference has a version, stored with the scores. A change to the reference raises
// it; the run against the new reference is then that language's new baseline when no enforced score
// misses more than before. With the same version, a lower share is a fall.
//
// scores.json is written by `--write` alone, never by hand. A pull request that raises a stored
// score shows the run's output. Every repo is at a fixed commit: tmb at its pin in repos.ts, read
// from its own history; the public repos at theirs, fetched with `bun tests/lib/pinned-repo.ts <name>`.
// A pin moves only in a pull request that runs `--write`, which still refuses when a score fell.
// Links found against the reference is the score of record; links found from the call states is
// shown and stored beside it, and never fails the run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveCommit } from "../../src/engine/graph/git-source.ts";
import { compileDatabase, measureC, REFERENCE_VERSION as C_REFERENCE_VERSION, WAY_B_NOT_BUILT as C_WAY_B_NOT_BUILT } from "./c.ts";
import { measureGo, REFERENCE_VERSION as GO_REFERENCE_VERSION } from "./go.ts";
import { measureJava, REFERENCE_VERSION as JAVA_REFERENCE_VERSION, WAY_B_NOT_BUILT as JAVA_WAY_B_NOT_BUILT } from "./java.ts";
import { measurePython, REFERENCE_VERSION as PY_REFERENCE_VERSION } from "./python.ts";
import { BENCH_REPOS, locate } from "./repos.ts";
import { acceptFallIssue, acceptFalls, carryAccepted, type Entry, entry, falls, format, isNotScored, notBuilt, rises, SCORE_NAMES, type ScoreName, type Stored, type Way, WAYS } from "./score.ts";
import { measureTypescript, REFERENCE as TS_REFERENCE, REFERENCE_VERSION as TS_REFERENCE_VERSION } from "./typescript.ts";

export const SCORES_FILE = path.join(import.meta.dir, "scores.json");
const COMMAND = "bun tests/benchmark/run.ts --write";

const TITLES: Record<ScoreName, string> = {
  functionsFound: "Functions found",
  linksRight: "Links right",
  linksFoundByState: "Links found, by call state (shown, not enforced)",
  linksFoundByReference: "Links found, against the reference",
  callsAccountedFor: "Calls accounted for",
};

/** What each way needs installed, by language, for the reader of the scores. */
const INSTALLED: Record<string, Record<Way, string>> = {
  typescript: {
    A: "nothing: tmb's own parser",
    B: "nothing for the compiler: tmb carries it; the repo's packages installed, for its calls of them to be outside",
  },
  python: {
    A: "nothing: tmb's own parser",
    B: "nothing for pyright: tmb carries it; the repo's own virtual environment, for its calls of packages to be outside",
  },
  go: { A: "nothing: tmb's own parser", B: "the user's own `go`, which runs the helper tmb carries; the repo's modules in the module cache, for its calls of them to be known (measured with none)" },
  java: { A: "nothing: tmb's own parser", B: JAVA_WAY_B_NOT_BUILT },
  c: { A: "nothing: tmb's own parser", B: C_WAY_B_NOT_BUILT },
  cpp: { A: "nothing: tmb's own parser", B: C_WAY_B_NOT_BUILT },
};

type Seconds = { graph: number; reference: number };
type Run = { stored: Stored; seconds: Record<string, Partial<Record<Way, Seconds>>>; detail: Record<string, string[]> };

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
    // C and C++ are measured against the compiler, which reads the repo by its compile database.
    const database = r.language === "c" || r.language === "cpp" ? compileDatabase(where.folder, r.fetched?.env ?? "") : null;
    if (database !== null && "error" in database) {
      errors.push(`${r.repo}: ${database.error}`);
      continue;
    }
    console.error(`measuring ${r.repo} (${r.language}) at ${sha.slice(0, 7)}…`);
    const secs = (ms: { graph: number; reference: number }): Seconds => ({ graph: ms.graph / 1000, reference: ms.reference / 1000 });
    const measure = async (way: Way) =>
      r.language === "typescript"
        ? { ...(await measureTypescript(where.folder, sha, way)), reference: TS_REFERENCE }
        : r.language === "python"
          ? await measurePython(where.folder, sha, way)
          : r.language === "go"
            ? await measureGo(where.folder, sha, way)
            : database !== null
              ? way === "A"
                ? await measureC(where.folder, sha, database.file)
                : { scores: notBuilt(C_WAY_B_NOT_BUILT), ms: { graph: 0, reference: 0 }, detail: [], reference: "" }
              : way === "A"
                ? await measureJava(where.folder, sha)
                : { scores: notBuilt(JAVA_WAY_B_NOT_BUILT), ms: { graph: 0, reference: 0 }, detail: [], reference: "" };
    const a = await measure("A");
    const b = await measure("B");
    entries.push(entry({ repo: r.repo, language: r.language, commit: sha, reference: a.reference }, { A: a.scores, B: b.scores }));
    seconds[r.repo] = { A: secs(a.ms), B: secs(b.ms) };
    detail[r.repo] = [...a.detail.map((d) => `way A, ${d}`), ...b.detail.map((d) => `way B, ${d}`)];
  }
  if (errors.length > 0) throw new Error(`the benchmark cannot measure:\n${errors.join("\n")}`);
  return { stored: { command: COMMAND, referenceVersions: { typescript: TS_REFERENCE_VERSION, python: PY_REFERENCE_VERSION, go: GO_REFERENCE_VERSION, java: JAVA_REFERENCE_VERSION, c: C_REFERENCE_VERSION, cpp: C_REFERENCE_VERSION }, entries }, seconds, detail };
}

/** The scores as Markdown tables, for the terminal and for a pull request. */
export function report(run: Run): string {
  const out: string[] = [];
  out.push(`| Repo | Language | Commit | Way | ${SCORE_NAMES.map((n) => TITLES[n]).join(" | ")} |`);
  out.push(`|---|---|---|---|${SCORE_NAMES.map(() => "---").join("|")}|`);
  for (const e of run.stored.entries) {
    for (const way of WAYS) out.push(`| ${e.repo} | ${e.language} | ${e.commit.slice(0, 7)} | ${way} | ${SCORE_NAMES.map((n) => format(e.ways[way][n])).join(" | ")} |`);
  }
  out.push("", "Time, in seconds: the graph built (time to index) and the reference and scoring, per way.", "", "| Repo | Reference | Way | Graph built | Reference and scoring |", "|---|---|---|---|---|");
  for (const e of run.stored.entries) {
    for (const way of WAYS) {
      const s = run.seconds[e.repo]?.[way];
      if (s !== undefined) out.push(`| ${e.repo} | ${e.reference} | ${way} | ${s.graph.toFixed(1)} | ${s.reference.toFixed(1)} |`);
    }
  }
  for (const way of WAYS) {
    out.push("", `Misses by cause, way ${way}: the reference's links the graph does not have, by the kind of code that hides them.`);
    for (const e of run.stored.entries) {
      const causes = e.ways[way].missesByCause;
      out.push("", `${e.repo} (${e.language}):${isNotScored(causes) ? ` ${causes.notScored}` : ""}`);
      if (!isNotScored(causes)) for (const [cause, n] of Object.entries(causes)) out.push(`- ${n}: ${cause}`);
    }
  }
  out.push("", "What each way needs installed:", "", "| Language | Way | Installed |", "|---|---|---|");
  for (const language of [...new Set(run.stored.entries.map((e) => e.language))]) for (const way of WAYS) out.push(`| ${language} | ${way} | ${INSTALLED[language]?.[way] ?? ""} |`);
  return out.join("\n");
}

function readStored(): Stored | null {
  return existsSync(SCORES_FILE) ? (JSON.parse(readFileSync(SCORES_FILE, "utf8")) as Stored) : null;
}

async function main(args: string[]): Promise<number> {
  const write = args.includes("--write");
  const check = args.includes("--check");
  const issue = acceptFallIssue(args);
  if (issue !== null && typeof issue === "object") {
    console.error(issue.error);
    return 2;
  }
  const run = await measureAll();
  console.log(report(run));
  for (const [repo, lines] of Object.entries(run.detail)) for (const line of lines) console.log(`${repo}: ${line}`);
  const stored = readStored();
  const fell = stored === null ? [] : falls(stored, run.stored);
  const rose = stored === null ? [] : rises(stored, run.stored);
  if (stored === null) console.log(`\nno stored scores yet in ${SCORES_FILE}`);
  for (const r of rose) console.log(`rose: ${r}`);
  for (const f of fell) console.log(`FELL: ${f}`);
  let toWrite = stored === null ? run.stored : carryAccepted(stored, run.stored);
  if (fell.length > 0 && write && issue !== null && stored !== null) {
    const accepted = acceptFalls(stored, run.stored, issue);
    if ("refused" in accepted) {
      for (const r of accepted.refused) console.error(`REFUSED: ${r}`);
      console.error("\nthe falls are not accepted, and the scores are not written.");
      return 1;
    }
    for (const a of accepted.accepted) console.log(`accepted: ${a}`);
    toWrite = accepted.stored;
  } else if (fell.length > 0 && (check || write)) {
    console.error(`\n${fell.length} stored scores fell; the benchmark fails${write ? ", and the scores are not written" : ""}.`);
    return 1;
  }
  if (write) {
    writeFileSync(SCORES_FILE, `${JSON.stringify(toWrite, null, 2)}\n`);
    console.log(`\nwrote ${SCORES_FILE}`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
