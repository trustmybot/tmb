// Python's links a second tool finds that pyright does not (trustmybot/tmb#427): the call sites where
// the judge, Jedi, names a node of the graph and pyright, way B's source and the reference, gives no
// answer or answers outside the repo. Each is counted by the kind of code the call is and by what
// pyright said, and the share of calls way B would link if it took them too is shown beside way B's
// links found from the call states, as stored in scores.json. It measures; it scores nothing.
//
//   bun tests/benchmark/python-extras.ts                  flask and datasette at their pins
//   bun tests/benchmark/python-extras.ts --sample 20      also a seeded sample of the calls, to check by hand
//
// The repos are fetched as for the benchmark (`bun tests/lib/pinned-repo.ts flask`); Jedi runs as the
// judge runs (python_judge.ts, TMB_JUDGE_PYTHON).
import { languageTexts } from "./graph.ts";
import { type CheckerAnswer, checkerAnswers, pythonReference, referenceLinks } from "./python.ts";
import { JUDGE, judgeDeclarations } from "./python_judge.ts";
import { BENCH_REPOS, locate } from "./repos.ts";
import { SCORES_FILE } from "./run.ts";
import { isRatio, type ReferenceCall, type Stored } from "./score.ts";

/** What pyright said at a call the other tool links: no answer, or only places outside the repo. */
export type PyrightSaid = "no answer" | "outside the repo";

/** A call the other tool links to a node, where pyright gives no answer or answers outside the repo. */
export type ExtraCall = ReferenceCall & { pyright: PyrightSaid };

/**
 * The calls `other` links to a node of the graph by the reference's rules, in the files `read`,
 * where pyright gives no answer or places the name only outside the repo. A call pyright places in
 * the repo, as a node or not, is no extra.
 */
export function extraCalls(ref: Parameters<typeof referenceLinks>[0], pyright: ReadonlyMap<string, CheckerAnswer>, other: ReadonlyMap<string, CheckerAnswer>, read: ReadonlySet<string>): ExtraCall[] {
  const said = new Map(
    [...pyright].flatMap(([key, a]): [string, PyrightSaid][] => {
      if (!a.answered) return [[key, "no answer"]];
      return a.nodes.length === 0 && a.inRepo === 0 ? [[key, "outside the repo"]] : [];
    }),
  );
  return referenceLinks(ref, other, read).calls.flatMap((c) => {
    const p = said.get(`${c.file}:${c.pos}`);
    return p === undefined ? [] : [{ ...c, pyright: p }];
  });
}

/**
 * Way B's links found from the call states if it also linked the extra calls: a call pyright gave
 * no answer for is a call not known, now linked; one it placed outside is a call outside, now linked.
 */
export function withExtras(state: { n: number; of: number }, extras: readonly ExtraCall[]): { n: number; of: number } {
  const outside = extras.filter((e) => e.pyright === "outside the repo").length;
  return { n: state.n + extras.length, of: state.of + outside };
}

/** A seeded pick of `k` items, the same for the same seed. */
export function seededSample<T>(items: readonly T[], k: number, seed: number): T[] {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, k);
}

/** The seed of the sample, so a sample checked by hand can be drawn again. */
export const SAMPLE_SEED = 427;
/** How many calls of each kind the output shows. */
const EXAMPLES = 3;

const percent = (r: { n: number; of: number }) => `${((100 * r.n) / r.of).toFixed(1)}% (${r.n}/${r.of})`;

async function main(args: string[]): Promise<number> {
  const at = args.indexOf("--sample");
  const sample = at >= 0 ? Number(args[at + 1]) : 0;
  const stored = JSON.parse(await Bun.file(SCORES_FILE).text()) as Stored;
  for (const r of BENCH_REPOS.filter((b) => b.language === "python")) {
    const found = locate(r);
    if ("error" in found) {
      console.error(`${r.repo}: ${found.error}`);
      return 1;
    }
    const texts = languageTexts(found.folder, found.ref, new Set(["python"]));
    const ref = pythonReference(texts);
    const read = new Set(Object.keys(ref.files));
    const pyright = await checkerAnswers(found.folder, found.ref, texts, ref, []);
    const jedi = await checkerAnswers(found.folder, found.ref, texts, ref, [], { tool: judgeDeclarations });
    const extras = extraCalls(ref, pyright, jedi, read);
    const byCause = new Map<string, ExtraCall[]>();
    for (const e of extras) byCause.set(e.cause, [...(byCause.get(e.cause) ?? []), e]);
    const bySaid = (p: PyrightSaid) => extras.filter((e) => e.pyright === p).length;
    console.log(`${r.repo}: ${extras.length} calls ${JUDGE} links to a node where pyright gives no answer (${bySaid("no answer")}) or answers outside the repo (${bySaid("outside the repo")})`);
    for (const [cause, list] of byCause) console.log(`  ${cause}: ${list.length}, such as ${list.slice(0, EXAMPLES).map((e) => `${e.file}:${e.line} \`${e.names[0]}\``).join(", ")}`);
    const state = stored.entries.find((e) => e.repo === r.repo)?.ways.B.linksFoundByState;
    if (state !== undefined && isRatio(state)) console.log(`  way B's links found from the call states: ${percent(state)}; with these: ${percent(withExtras(state, extras))}`);
    if (sample > 0) {
      console.log(`  a sample of ${sample}, seed ${SAMPLE_SEED}, to check by hand:`);
      for (const e of seededSample(extras, sample, SAMPLE_SEED)) {
        const to = e.decls.map((d) => `${d.file}:${d.spans.map((s) => s.start).join(",")}`).join(" ");
        console.log(`    ${e.file}:${e.line} \`${e.names[0]}\` (${e.cause}; pyright: ${e.pyright}) -> ${to}`);
      }
    }
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
