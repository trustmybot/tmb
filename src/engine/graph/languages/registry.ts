// Every language the code graph reads (trustmybot/tmb#157). Adding one is a folder under
// languages/ and one line here. Each is built into the compiled tmb; none is downloaded.
import type { LanguageModule } from './contract.ts';
import { bash } from './bash/index.ts';
import { go } from './go/index.ts';
import { java } from './java/index.ts';
import { perl } from './perl/index.ts';
import { python } from './python/index.ts';
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
];

/** The language module named `name`, or null. */
export function languageNamed(name: string): LanguageModule | null {
  return LANGUAGES.find((l) => l.name === name) ?? null;
}

/** The language of an extension (lowercase, no dot), or null. */
export function languageOfExtension(ext: string): LanguageModule | null {
  return LANGUAGES.find((l) => l.extensions.includes(ext)) ?? null;
}

/** The language an extensionless file's first line names by its shebang, or null. */
export function languageOfShebang(head: string): LanguageModule | null {
  return LANGUAGES.find((l) => l.shebang?.test(head)) ?? null;
}
