// Every language the code graph reads (trustmybot/tmb#157). Adding one is a folder under
// languages/ and one line here. Each is built into the compiled tmb; none is downloaded.
import { extensionsOf } from '../../linguist/index.ts';
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

/** The module that names a path's ending as its own, by its longest ending one names, or null. */
export function endingOwner(relPath: string): LanguageModule | null {
  for (const ending of extensionsOf(relPath.split(/[\\/]/).pop() ?? '')) {
    const owner = LANGUAGES.find((l) => l.endings.includes(ending));
    if (owner !== undefined) return owner;
  }
  return null;
}

/** The module that reads a file Linguist names `name`: its language's, or the one whose dialect it is when the file's ending is that module's own. */
export function moduleReading(relPath: string, name: string): LanguageModule | null {
  const own = languageOfLinguist(name);
  if (own !== null) return own;
  const owner = endingOwner(relPath);
  return owner?.dialects?.includes(name) === true ? owner : null;
}
