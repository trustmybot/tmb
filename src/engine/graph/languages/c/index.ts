// C, read through tree-sitter (trustmybot/tmb#355): its functions, its structures, unions and
// enumerations, its file-level variables, and the calls each function makes. The rules are in
// family.ts, which C++ shares; each names the section of the C standard (ISO/IEC 9899:2011) it reads.
// Way A links only what those rules prove inside one file; the rest is the tool's.
import cWasm from 'tree-sitter-c/tree-sitter-c.wasm' with { type: 'file' };
import type { LanguageModule } from '../contract.ts';
import { syntaxTree } from '../kit.ts';
import { clangdTool } from './clangd.ts';
import { extractFamily, parseFamily } from './family.ts';

export const c: LanguageModule = {
  name: 'c',
  // A `.h` file is C, C++ or Objective-C by Linguist's heuristics for the ending (trustmybot/tmb#154).
  linguist: ['C'],
  grammar: cWasm,
  comment: 'slash',
  parse: parseFamily('c'),
  // Way B: clangd, which C++ shares (clangd.ts).
  tool: clangdTool,
  extract: (file, out) => extractFamily('c', syntaxTree(file), file.src, out, file.module),
};
