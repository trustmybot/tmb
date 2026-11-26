// C, read through tree-sitter (trustmybot/tmb#355): its functions, its structures, unions and
// enumerations, its file-level variables, and the calls each function makes. The rules are in
// family.ts, which C++ shares; each names the section of the C standard (ISO/IEC 9899:2011) it reads.
// Way A links only what those rules prove inside one file; the rest is the tool's.
import cWasm from 'tree-sitter-c/tree-sitter-c.wasm' with { type: 'file' };
import type { LanguageModule } from '../contract.ts';
import { syntaxTree } from '../kit.ts';
import { extractFamily, parseFamily } from './family.ts';

export const c: LanguageModule = {
  name: 'c',
  // Linguist's endings for C (languages.yml, commit cfd7a0113aa1). C++ shares `.h`, and reads a
  // header whose text it claims (cpp/index.ts); C reads the rest.
  extensions: ['c', 'cats', 'h', 'idc'],
  grammar: cWasm,
  comment: 'slash',
  parse: parseFamily('c'),
  extract: (file, out) => extractFamily('c', syntaxTree(file), file.src, out, file.module),
};
