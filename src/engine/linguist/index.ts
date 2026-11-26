// GitHub Linguist's language list (MIT, see data/LICENSE), carried in data/ at the release
// data/RELEASE.json names, unedited, and put into the compiled tmb by the build as the bug form is
// (trustmybot/tmb#154). scripts/linguist.ts copies a new release in; tmb keeps no list of its own.
// A data file the build cannot find fails the build; one it cannot read fails at the first use.
import generic from "./data/generic.yml" with { type: "text" };
import heuristics from "./data/heuristics.yml" with { type: "text" };
import languages from "./data/languages.yml" with { type: "text" };
import release from "./data/RELEASE.json" with { type: "json" };
import { Linguist } from "./table.ts";

export { type Detection, HEURISTICS_CONSIDER, interpreterOf, Linguist, type LinguistLanguage, type LinguistTexts } from "./table.ts";

/** The Linguist release the data came from. */
export const LINGUIST_RELEASE: { repo: string; tag: string; commit: string; licence: string; files: Record<string, string> } = release;

/** Which Linguist commit the data came from. */
export const LINGUIST_SOURCE = `${release.repo}@${release.commit}`;

let table: Linguist | null = null;

/** Linguist's list, read once, at the first use. */
export function linguist(): Linguist {
  table ??= new Linguist({ languages, heuristics, generic });
  return table;
}

export type LanguageMatch = { languages: string[]; programming: boolean };

/**
 * The languages Linguist names for a path by its name alone (a docs task's check, trustmybot/tmb#88):
 * by its exact file name, else by its longest known extension, or null when the list knows neither.
 * An extension that several languages list is narrowed to those whose first extension it is, when
 * any are. `programming` is true only when every language left is a programming language, so a name
 * the list cannot settle is not one.
 */
export function languageOf(filePath: string): LanguageMatch | null {
  const list = linguist();
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const match = (names: string[]): LanguageMatch => ({ languages: names, programming: names.every((name) => list.languages.get(name)?.type === "programming") });
  const byName = [...list.languages.values()].filter((l) => l.filenames.includes(base)).map((l) => l.name);
  if (byName.length > 0) return match(byName);
  const lower = base.toLowerCase();
  for (let at = lower.indexOf(".", 1); at !== -1; at = lower.indexOf(".", at + 1)) {
    const extension = lower.slice(at);
    const found = [...list.languages.values()].filter((l) => l.extensions.some((e) => e.toLowerCase() === extension));
    if (found.length === 0) continue;
    const primary = found.filter((l) => l.extensions[0]?.toLowerCase() === extension);
    return match((primary.length > 0 ? primary : found).map((l) => l.name));
  }
  return null;
}

/** Whether Linguist marks the file as written in a programming language; a file it does not know is not. */
export function isProgrammingFile(filePath: string): boolean {
  return languageOf(filePath)?.programming ?? false;
}
