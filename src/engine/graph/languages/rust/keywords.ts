// Rust's keywords, for the words of a macro's input, which the parser reads as tokens.
import type { Node } from 'web-tree-sitter';

/**
 * Rust's strict and reserved keywords (The Rust Reference, "Keywords"), from the 2018 edition on:
 * no name. A weak keyword, such as `union`, and a word the parser takes as a keyword that Rust does
 * not, such as `default`, is a name.
 */
export const RUST_KEYWORDS: ReadonlySet<string> = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
  'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type',
  'unsafe', 'use', 'where', 'while', 'async', 'await', 'dyn',
  'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try', 'gen',
  // `_` is no name either (The Rust Reference, "Identifiers").
  '_',
]);

/** A word of a token tree that is a name: an identifier, or a word the parser makes a keyword that is none of Rust's. */
export const isNameToken = (token: Node): boolean =>
  token.type === 'identifier' || (token.childCount === 0 && token.type === token.text && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text) && !RUST_KEYWORDS.has(token.text));
