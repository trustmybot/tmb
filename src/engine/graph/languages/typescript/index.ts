// The TypeScript, TSX and JavaScript modules: one set of rules, three grammars.
import typescriptWasm from 'tree-sitter-typescript/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxWasm from 'tree-sitter-typescript/tree-sitter-tsx.wasm' with { type: 'file' };
import javascriptWasm from 'tree-sitter-javascript/tree-sitter-javascript.wasm' with { type: 'file' };
import type { LanguageModule } from '../contract.ts';
import { extractTs } from './rules.ts';

export const typescript: LanguageModule = {
  name: 'typescript',
  extensions: ['ts', 'mts', 'cts'],
  grammar: typescriptWasm,
  comment: 'slash',
  extract: extractTs,
};

export const tsx: LanguageModule = {
  name: 'tsx',
  extensions: ['tsx'],
  grammar: tsxWasm,
  comment: 'slash',
  extract: extractTs,
};

export const javascript: LanguageModule = {
  name: 'javascript',
  extensions: ['js', 'mjs', 'cjs', 'jsx'],
  grammar: javascriptWasm,
  comment: 'slash',
  extract: extractTs,
};
