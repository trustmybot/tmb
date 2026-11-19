// Tells a file written in a programming language from prose, markup and data, by its name alone,
// with the language table of GitHub's Linguist (MIT, see LICENSE here). The table is regenerated
// with scripts/linguist.ts; tmb keeps no list of its own.
import table from "./languages.json" with { type: "json" };

type Language = { type: string; extensions?: string[]; filenames?: string[] };

export type LanguageMatch = { languages: string[]; programming: boolean };

const byFilename = new Map<string, Language[]>();
const byExtension = new Map<string, { name: string; language: Language; primary: boolean }[]>();
const named = new Map<Language, string>();

for (const [name, language] of Object.entries(table.languages as Record<string, Language>)) {
  named.set(language, name);
  for (const filename of language.filenames ?? []) byFilename.set(filename, [...(byFilename.get(filename) ?? []), language]);
  (language.extensions ?? []).forEach((extension, index) => {
    const key = extension.toLowerCase();
    byExtension.set(key, [...(byExtension.get(key) ?? []), { name, language, primary: index === 0 }]);
  });
}

/** The extensions a base name could carry, longest first: `a.d.ts` gives `.d.ts`, then `.ts`. A leading dot starts no extension. */
function extensionsOf(base: string): string[] {
  const lower = base.toLowerCase();
  const found: string[] = [];
  for (let at = lower.indexOf(".", 1); at !== -1; at = lower.indexOf(".", at + 1)) found.push(lower.slice(at));
  return found;
}

function matchOf(languages: Language[]): LanguageMatch {
  return { languages: languages.map((language) => named.get(language)!), programming: languages.every((language) => language.type === "programming") };
}

/**
 * The languages Linguist names for a path, by its exact file name, else by its longest known
 * extension, or null when the table knows neither. An extension that several languages list is
 * narrowed to those whose first extension it is, when any are. `programming` is true only when
 * every language left is a programming language, so a name the table cannot settle is not one.
 */
export function languageOf(filePath: string): LanguageMatch | null {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const byName = byFilename.get(base);
  if (byName) return matchOf(byName);
  for (const extension of extensionsOf(base)) {
    const candidates = byExtension.get(extension);
    if (!candidates) continue;
    const primary = candidates.filter((candidate) => candidate.primary);
    return matchOf((primary.length > 0 ? primary : candidates).map((candidate) => candidate.language));
  }
  return null;
}

/** Whether Linguist marks the file as written in a programming language; a file it does not know is not. */
export function isProgrammingFile(filePath: string): boolean {
  return languageOf(filePath)?.programming ?? false;
}

/** Which Linguist commit the table came from. */
export const LINGUIST_SOURCE: string = table.source;
