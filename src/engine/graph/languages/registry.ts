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

/**
 * The language of an extension (lowercase, no dot), or null. An ending several languages share is
 * decided by the file's text: the language that claims it, else the one that claims nothing.
 */
export function languageOfExtension(ext: string, text: () => string): LanguageModule | null {
  const all = LANGUAGES.filter((l) => l.extensions.includes(ext));
  if (all.length <= 1) return all[0] ?? null;
  const body = text();
  return all.find((l) => l.claims?.(body) === true) ?? all.find((l) => l.claims === undefined) ?? null;
}

/** The language an extensionless file's first line names by its shebang, or null. */
export function languageOfShebang(head: string): LanguageModule | null {
  return LANGUAGES.find((l) => l.shebang?.test(head)) ?? null;
}
