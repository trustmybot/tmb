// The code tmb has no module for, named by GitHub Linguist's list (trustmybot/tmb#154): a file is
// counted under its language when Linguist types that language as programming. Vue and Svelte count
// although Linguist types them as markup, because they hold script. When Linguist's rules leave a
// file several languages, Linguist's first one names it.
import { linguist } from '../../linguist/index.ts';
import { fileLanguages } from '../extract.ts';
import { languageOfLinguist } from './registry.ts';

/** Linguist's type of a language that is code. */
const CODE_TYPE = 'programming';

/** Languages Linguist types as markup that hold script, so their files count as code. */
const SCRIPT_MARKUP: ReadonlySet<string> = new Set(['Vue', 'Svelte']);

/**
 * The language tmb does not read that a file is in, from the languages Linguist's rules leave it;
 * null for a file a module reads, and for prose, data, markup and files Linguist does not know.
 */
export function unreadLanguage(languages: readonly string[]): string | null {
  const name = languages[0];
  if (name === undefined) return null;
  if (languages.length === 1 && languageOfLinguist(name) !== null) return null;
  return linguist().languages.get(name)?.type === CODE_TYPE || SCRIPT_MARKUP.has(name) ? name : null;
}

/**
 * The language tmb does not read that a path is in, by its name alone, among the languages a layer
 * counted as not read: a name Linguist's rules leave several languages for needs the text to settle
 * it, and the layer's count already settled each file's text. The first of the name's languages that
 * the layer counted names it; null when it counted none of them.
 */
export function unreadLanguageOf(relPath: string, counted: ReadonlySet<string>): string | null {
  return fileLanguages(relPath, null).find((name) => counted.has(name)) ?? null;
}
