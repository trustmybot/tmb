// Every language the code graph reads (trustmybot/tmb#157). Adding one is a folder under
// languages/ and one line here. Each is built into the compiled tmb; none is downloaded.
import type { LanguageModule } from './contract.ts';
import { bash } from './bash/index.ts';
import { c } from './c/index.ts';
import { cpp } from './cpp/index.ts';
import { go } from './go/index.ts';
import { java } from './java/index.ts';
import { perl } from './perl/index.ts';
import { python } from './python/index.ts';
import { rust } from './rust/index.ts';
import { sql } from './sql/index.ts';
import { javascript, tsx, typescript } from './typescript/index.ts';

export const LANGUAGES: LanguageModule[] = [
  typescript,
  tsx,
  javascript,
  perl,
  bash,
  python,
  sql,
  go,
  java,
  c,
  cpp,
  rust,
];

/** The language module named `name`, or null. */
export function languageNamed(name: string): LanguageModule | null {
  return LANGUAGES.find((l) => l.name === name) ?? null;
}

/** The module that reads a language of Linguist's list, by Linguist's name, or null. */
export function languageOfLinguist(name: string): LanguageModule | null {
  return LANGUAGES.find((l) => l.linguist.includes(name)) ?? null;
}
