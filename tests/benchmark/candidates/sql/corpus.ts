// Research harness for trustmybot/tmb#339: the corpus every SQL candidate reads. Each benchmark
// repo at its pin (tmb, flask, datasette; hono holds no SQL), read with the graph's own file rules,
// plus the fixture set in fixtures/, whose expected tables were written by hand from the SQL.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { languageOf } from "../../../../src/engine/graph/extract.ts";
import { PINNED_DATASETTE, PINNED_FLASK } from "../../../lib/pinned-repo.ts";
import { languageTexts } from "../../graph.ts";
import { BENCH_REPOS, locate } from "../../repos.ts";
import { stringUnits, type Unit } from "./strings.ts";

const CODE_LANGUAGES = new Map<string, Unit["from"]>([
  ["typescript", "typescript"],
  ["tsx", "typescript"],
  ["javascript", "typescript"],
  ["python", "python"],
  ["bash", "bash"],
]);
const SQL_LANGUAGE = "sql";

const REPOS = new Set(["tmb", PINNED_FLASK.name, PINNED_DATASETTE.name]);

/** Every unit of the benchmark repos that hold SQL. */
export async function repoUnits(): Promise<Unit[]> {
  const out: Unit[] = [];
  for (const r of BENCH_REPOS.filter((b) => REPOS.has(b.repo))) {
    const at = locate(r);
    if ("error" in at) throw new Error(`${r.repo}: ${at.error}`);
    const texts = languageTexts(at.folder, at.ref, new Set([...CODE_LANGUAGES.keys(), SQL_LANGUAGE]));
    for (const [file, text] of texts) {
      if (file.endsWith(".sql")) {
        out.push({ repo: r.repo, path: file, line: 1, from: "file", sql: text, raw: text, holes: 0, startsLikeSql: true });
        continue;
      }
      const lang = CODE_LANGUAGES.get(languageOf(file, () => text) ?? "");
      if (lang) out.push(...(await stringUnits(r.repo, file, text, lang)));
    }
  }
  return out;
}

export const FIXTURES = path.join(import.meta.dir, "fixtures");

/** A fixture statement and the tables a reader of the SQL gives it, written by hand. */
export type Fixture = {
  id: string;
  dialect: string;
  /** What the case covers. */
  covers: string;
  sql: string;
  /** "op:name" for each table, op one of define, read, write, trigger; a hole table is "op:?". */
  expect: string[];
  /** A unit taken from code, with holes, rather than a .sql statement. */
  inString?: boolean;
};

export function fixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const f of readdirSync(FIXTURES).filter((n) => n.endsWith(".json")).sort()) {
    out.push(...(JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as Fixture[]));
  }
  return out;
}
