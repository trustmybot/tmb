// The TypeScript, TSX and JavaScript modules: one set of rules, three grammars.
import typescriptWasm from 'tree-sitter-typescript/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxWasm from 'tree-sitter-typescript/tree-sitter-tsx.wasm' with { type: 'file' };
import javascriptWasm from 'tree-sitter-javascript/tree-sitter-javascript.wasm' with { type: 'file' };
import type { LanguageModule } from '../contract.ts';
import { parseRepaired } from './repair.ts';
import { extractTs } from './rules.ts';
import { typescriptCompiler } from './tool.ts';

// GitHub Linguist's test for a minified JavaScript file: its lines average more than 110
// characters. A bundle is minified whatever its name, so the name alone is not enough.
export function isMinifiedScript(text: string): boolean {
  const lines = text.split('\n');
  return (text.length - (lines.length - 1)) / lines.length > 110;
}

export const typescript: LanguageModule = {
  name: 'typescript',
  linguist: ['TypeScript'],
  endings: ['.ts', '.mts', '.cts'],
  grammar: typescriptWasm,
  comment: 'slash',
  minified: isMinifiedScript,
  parse: parseRepaired,
  extract: extractTs,
  tool: typescriptCompiler,
};

export const tsx: LanguageModule = {
  name: 'tsx',
  linguist: ['TSX'],
  endings: ['.tsx'],
  grammar: tsxWasm,
  comment: 'slash',
  minified: isMinifiedScript,
  parse: parseRepaired,
  extract: extractTs,
  tool: typescriptCompiler,
};

export const javascript: LanguageModule = {
  name: 'javascript',
  linguist: ['JavaScript'],
  endings: ['.js', '.mjs', '.cjs', '.jsx'],
  grammar: javascriptWasm,
  comment: 'slash',
  minified: isMinifiedScript,
  extract: extractTs,
  tool: typescriptCompiler,
};
