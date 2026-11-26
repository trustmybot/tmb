// The calls the candidates answer differently, for the hand check (trustmybot/tmb#346). Reads the
// states.json run.ts writes and prints each differing call with its source line, grouped by which
// candidates differ, and a seeded sample of calls on which every candidate agrees.
//
// Usage: bun tests/benchmark/candidates/java/disagree.ts <repo> <work dir> <tag: deps|nodeps> [sample size]
import { join } from "node:path";

const [repo, work, tag, sizeArg] = Bun.argv.slice(2);
if (!repo || !work || !tag) throw new Error("usage: bun disagree.ts <repo> <work dir> <deps|nodeps> [sample size]");
const size = Number(sizeArg ?? "20");
type J = { state: string; nodes: string[]; why: string };
const data = (await Bun.file(join(work, "states.json")).json()) as {
  calls: { file: string; pos: number; line: number; name: string; form: string }[];
  states: Record<string, Record<string, J>>;
};
const runs = Object.keys(data.states).filter((k) => k.endsWith(`-${tag}`));
const texts = new Map<string, string[]>();
const lineOf = async (file: string, line: number) => {
  if (!texts.has(file)) texts.set(file, (await Bun.file(join(repo, file)).text()).split(/\r\n|\r|\n/));
  return (texts.get(file) as string[])[line - 1]?.trim() ?? "";
};
/** An answer as compared: the state and the nodes; why a call is not known is shown, not compared. */
const same = (j: J | undefined) => (!j ? "-" : j.state === "linked" ? j.nodes.join(" + ") : j.state);
const show = (j: J | undefined) => (j?.state === "notKnown" ? `not known (${j.why})` : same(j));

const groups = new Map<string, string[]>();
const agree: string[] = [];
for (const c of data.calls) {
  const key = `${c.file}@${c.pos}`;
  const answers = runs.map((r) => same(data.states[r]?.[key]));
  const distinct = new Set(answers);
  const row = `${c.file}:${c.line} \`${c.name}\` | ${runs.map((r) => `${r}: ${show(data.states[r]?.[key])}`).join(" | ")} | ${await lineOf(c.file, c.line)}`;
  if (distinct.size === 1) {
    if (data.states[runs[0] as string]?.[key]?.state === "linked") agree.push(row);
    continue;
  }
  // Which candidates differ from the first (the reference): the group's name.
  const ref = answers[0];
  const g = runs.filter((_, i) => answers[i] !== ref).join(",");
  groups.set(g, [...(groups.get(g) ?? []), row]);
}
for (const [g, rows] of groups) {
  console.log(`\n## differ from ${runs[0]}: ${g} (${rows.length})`);
  for (const r of rows) console.log(r);
}
// A fixed stride through the agreeing links, so the sample is spread over the repo and the same on every run.
const stride = Math.max(1, Math.floor(agree.length / size));
console.log(`\n## agree, linked (${agree.length}); every ${stride}th`);
for (let i = 0; i < agree.length && i / stride < size; i += stride) console.log(agree[i]);
