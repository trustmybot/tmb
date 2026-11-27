// Which tool each language of a repo would be built with now, and whose copy it is (CODE_GRAPH.md,
// "Where a language's tool comes from"; trustmybot/tmb#392), as `tmb tools` lists it. It runs
// the find order (tool-copy.ts) and only that: it downloads and installs nothing.
import type { Database } from "bun:sqlite";
import { BASE_LAYER } from "./db.ts";
import { languageNamed } from "./languages/registry.ts";
import { type CopyPlaces, findCopy, machinePlaces, type Whose } from "./tool-copy.ts";

/** One language of the repo: its tool and the copy the find order finds, or that it has no tool. */
export type ToolRow = {
  language: string;
  /** The language's tool; null when the language has none, and the built-in rules make its links. */
  tool: string | null;
  /** Whose copy the find order finds, or that none is found; null with no tool. */
  whose: Whose | "missing" | null;
  /** The copy's version, as it reports it. */
  version: string | null;
  /** Where the copy is; null for a copy tmb carries in its own program, and when none is found. */
  path: string | null;
  /** Why the tool is missing, or why the copy found is not the first place's. */
  note: string | null;
  /** The program tmb builds to run the tool with the copy found, for a tool that needs one: where it is kept, whether it is built yet, and the tool that builds it. */
  helper?: { name: string; built: boolean; builtBy: string; path: string };
};

/** The languages of the repo's indexed base branch, by name; none when it is not indexed yet. */
export function baseLanguages(db: Database): string[] {
  const rows = db.query("SELECT DISTINCT lang FROM files WHERE layer = ? AND lang IS NOT NULL ORDER BY lang").all(BASE_LAYER) as { lang: string }[];
  return rows.map((row) => row.lang);
}

/** Each language's tool and the copy found for it now, in the order of the languages given. */
export function toolRows(languages: readonly string[], places: CopyPlaces = machinePlaces()): ToolRow[] {
  return languages.map((language): ToolRow => {
    const tool = languageNamed(language)?.tool;
    if (tool === undefined) return { language, tool: null, whose: null, version: null, path: null, note: null };
    const found = findCopy(tool.copy, places);
    if ("missing" in found) return { language, tool: tool.name, whose: "missing", version: null, path: null, note: found.missing };
    const helper = tool.helper?.(found, places.stateDir) ?? null;
    return {
      language,
      tool: tool.name,
      whose: found.whose,
      version: found.version,
      path: found.path,
      note: found.note ?? null,
      ...(helper === null ? {} : { helper: { name: helper.name, built: helper.built, builtBy: helper.builtBy, path: helper.path } }),
    };
  });
}

/** How a whose reads in a line. */
const WHOSE_WORDS: Record<Whose, string> = { setting: "the setting's copy", user: "the user's copy", tmb: "tmb's copy" };

/** One row as a line of `tmb tools`. */
export function toolLine(row: ToolRow): string {
  if (row.tool === null) return `${row.language}: no language tool; the built-in rules make its links`;
  if (row.whose === "missing" || row.whose === null) return `${row.language}: ${row.tool} is missing (${row.note}); the built-in rules make its links`;
  const where = row.path === null ? "carried in tmb" : `at ${row.path}`;
  const line = `${row.language}: ${row.tool}, ${WHOSE_WORDS[row.whose]}, ${row.version}, ${where}${row.note === null ? "" : ` (${row.note})`}`;
  if (row.helper === undefined) return line;
  const { name, built, builtBy, path } = row.helper;
  return built ? `${line}; its helper ${name}, built by ${builtBy}, at ${path}` : `${line}; its helper ${name} is not built yet: the first index of a ${row.language} repo builds it with ${builtBy}`;
}
