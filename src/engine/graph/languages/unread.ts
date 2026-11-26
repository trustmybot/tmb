// The code tmb has no module for, named by GitHub Linguist's list (trustmybot/tmb#154): a file is
// counted under its language when Linguist types that language as programming. Vue and Svelte count
// although Linguist types them as markup, because they hold script. When Linguist's rules leave a
// file several languages and no module reads any of them, it is counted as "one of" them, never
// guessed (CODE_GRAPH.md).
import { linguist } from '../../linguist/index.ts';
import { fileLanguages } from '../extract.ts';
import { moduleReading } from './registry.ts';

/** Linguist's type of a language that is code. */
const CODE_TYPE = 'programming';

/** Languages Linguist types as markup that hold script, so their files count as code. */
const SCRIPT_MARKUP: ReadonlySet<string> = new Set(['Vue', 'Svelte']);

/** How a file Linguist's rules leave several languages is named. */
export function oneOf(languages: readonly string[]): string {
  return `one of ${languages.join(', ')}`;
}

function isCode(name: string): boolean {
  return linguist().languages.get(name)?.type === CODE_TYPE || SCRIPT_MARKUP.has(name);
}

/**
 * The language tmb does not read that a file at `relPath` is in, from the languages Linguist's rules
 * leave it: null when a module reads one of them, and for prose, data, markup and files Linguist
 * does not know.
 */
export function unreadLanguage(languages: readonly string[], relPath = ''): string | null {
  if (languages.length === 0 || languages.some((name) => moduleReading(relPath, name) !== null)) return null;
  if (!languages.some(isCode)) return null;
  return languages.length === 1 ? languages[0]! : oneOf(languages);
}

/**
 * The language tmb does not read that a path is in, by its name alone, among the languages a layer
 * counted as not read: a name Linguist's rules leave several languages for needs the text to settle
 * it, and the layer's count already settled each file's text. The name the layer counted it under
 * when there is one, else the first of the name's languages the layer counted; null when it counted
 * none of them.
 */
export function unreadLanguageOf(relPath: string, counted: ReadonlySet<string>): string | null {
  const languages = fileLanguages(relPath, null);
  if (languages.length > 1 && counted.has(oneOf(languages))) return oneOf(languages);
  return languages.find((name) => counted.has(name)) ?? null;
}
