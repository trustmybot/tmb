// A file's text in, its symbols and outgoing references out, through the language module the
// registry names for it (trustmybot/tmb#157). This file holds no language's rules: those are in
// languages/, one folder per language.
import { basename } from 'node:path';
import { Collector, type Extraction, type LanguageModule, type SourceLanguage, type SymbolKind } from './languages/contract.ts';
import { clip, DOC_MAX, md5, splitWords, STOPWORDS } from './languages/kit.ts';
import { attributeFlag, type Attributes } from '../linguist/gitattributes.ts';
import { linguist } from '../linguist/index.ts';
import { endingOwner, languageNamed, moduleReading } from './languages/registry.ts';
import type { Parsers } from './loader.ts';

export type {
  Bound,
  CallMark,
  Outside,
  EdgeKind,
  ExtractedEdge,
  ExtractedExport,
  ExtractedSymbol,
  Extraction,
  FunctionParams,
  ParamInfo,
  SourceLanguage,
  SymbolKind,
} from './languages/contract.ts';
export { clip, DOC_MAX, isBannerLine, isRuleLine, md5, oneLine, splitWords, STOPWORDS } from './languages/kit.ts';

// What the graph leaves out by path, each rule named so the index can count it
// (trustmybot/tmb#234): installed or vendored dependencies and build output as GitHub
// Linguist's vendored list names them, source maps, minified bundles and lockfiles. A folder
// named `build` is read: the graph is built from git, so output git ignores is never in it.
// Each rule is of one of Linguist's two kinds, vendored (lib/linguist/vendor.yml) or generated
// (lib/linguist/generated.rb), so a project's `.gitattributes` can override it as on GitHub
// (trustmybot/tmb#154): `-linguist-vendored` reads a vendored folder, `linguist-vendored` leaves a
// path out, and `linguist-generated` likewise.
/** The rule that leaves out a project's installed packages, which are no code of the repo. */
export const NODE_MODULES_RULE = 'node_modules/';
type LeftOutKind = 'vendored' | 'generated';
const LEFT_OUT: readonly { rule: string; kind: LeftOutKind; re: RegExp }[] = [
  { rule: 'dist/', kind: 'vendored', re: /(^|\/)dist\// },
  { rule: NODE_MODULES_RULE, kind: 'vendored', re: /(^|\/)node_modules\// },
  { rule: 'vendor/', kind: 'vendored', re: /(^|\/)vendor\// },
  { rule: 'source maps', kind: 'generated', re: /\.map$/ },
  { rule: 'minified (.min.js)', kind: 'vendored', re: /\.min\.js$/ },
  { rule: 'lockfiles', kind: 'generated', re: /(^|\/)package-lock\.json$/ },
  { rule: 'lockfiles', kind: 'generated', re: /\.lock(b)?$/ },
];
/** The rule name of a path a `.gitattributes` file marks with the attribute. */
const ATTRIBUTE_RULE: Readonly<Record<LeftOutKind, string>> = { vendored: 'linguist-vendored', generated: 'linguist-generated' };

// The rule that leaves a path out of the graph, or null when the graph reads it. A
// `.gitattributes` file's `linguist-vendored` or `linguist-generated` decides for its kind.
export function leftOutRule(relPath: string, attributes: Attributes = {}): string | null {
  const marked = { vendored: attributeFlag(attributes['linguist-vendored']), generated: attributeFlag(attributes['linguist-generated']) };
  for (const kind of ['vendored', 'generated'] as const) if (marked[kind] === true) return ATTRIBUTE_RULE[kind];
  return LEFT_OUT.find(({ kind, re }) => marked[kind] === null && re.test(relPath))?.rule ?? null;
}

// A path is in symbol scope unless a rule leaves it out.
export function inSymbolScope(relPath: string, attributes: Attributes = {}): boolean {
  return leftOutRule(relPath, attributes) === null;
}

/**
 * A file's languages by GitHub Linguist's list and rules (trustmybot/tmb#154): the language a
 * `.gitattributes` file names for it, else what its name, its first line and the heuristics for its
 * extension leave. `text` is asked for only when the name does not decide; null answers by the name
 * alone.
 */
export function fileLanguages(relPath: string, text: (() => string) | null, attributes: Attributes = {}): string[] {
  const named = attributes['linguist-language'];
  const override = typeof named === 'string' ? linguist().byAliasName(named) : null;
  if (override !== null) return [override];
  return linguist().detect(relPath, text).languages;
}

// The language module that reads a file Linguist names `languages` (CODE_GRAPH.md, trustmybot/tmb#154):
// the module of the language Linguist settles on. When its rules leave several, the module that
// names the file's ending as its own reads it, if it reads one of them, so a file the graph reads is
// never dropped for want of an answer; with no such module the file is not parsed. Null too for a
// file its module keeps with no symbols.
export function moduleOfLanguages(relPath: string, languages: readonly string[]): SourceLanguage | null {
  const module = readingModule(relPath, languages);
  return module === null || module.declarationsOnly?.(relPath) === true ? null : module.name;
}

// The module whose language a file is in, by moduleOfLanguages' rule, before declarationsOnly.
export function readingModule(relPath: string, languages: readonly string[]): LanguageModule | null {
  if (languages.length === 1) return moduleReading(relPath, languages[0]!);
  const owner = endingOwner(relPath);
  return owner !== null && languages.some((name) => moduleReading(relPath, name) === owner) ? owner : null;
}

// The language module that reads a path; see moduleOfLanguages.
export function languageOf(relPath: string, text: () => string, attributes: Attributes = {}): SourceLanguage | null {
  return moduleOfLanguages(relPath, fileLanguages(relPath, text, attributes));
}

// Whether a language is read through a tree-sitter grammar, not by patterns.
export function needsParser(lang: SourceLanguage): boolean {
  return languageNamed(lang)?.grammar !== undefined;
}

// The split-name text wm_symbols_fts indexes for a symbol.
export function symbolTerms(kind: SymbolKind, qualifiedName: string, relPath: string): string {
  return `${splitWords(qualifiedName)} ${kind.replace('_', ' ')} ${splitWords(basename(relPath))}`;
}

// The distinct non-stopword words of a body, for callers that rank on them.
export function bodyTerms(text: string): string {
  const seen = new Set<string>();
  for (const w of splitWords(text).split(' ')) if (w.length > 2 && !STOPWORDS.has(w)) seen.add(w);
  return [...seen].slice(0, 400).join(' ');
}

function moduleDoc(comment: 'hash' | 'slash', src: string): string {
  const out: string[] = [];
  const marker = comment === 'hash' ? /^\s*(?:#|--)\s?(.*)$/ : /^\s*(?:\/\/|\/\*\*?|\*)\s?(.*?)(\*\/)?$/;
  for (const l of src.split('\n')) {
    if (/^#!/.test(l)) continue;
    const m = l.match(marker);
    if (m) {
      if (m[1]!.trim()) out.push(m[1]!.trim());
    } else if (out.length || l.trim()) break;
  }
  return clip(out.join(' '), DOC_MAX);
}

// Every symbol of one file, the per-file 'module' row first, and the references each one
// makes.
export function extractFile(parsers: Parsers | null, relPath: string, lang: SourceLanguage, src: string): Extraction {
  const language = languageNamed(lang);
  if (!language) throw new Error(`no language module for ${lang}`);
  const out = new Collector();
  const moduleSymbol = out.symbol({
    kind: 'module',
    qualified_name: relPath,
    signature: relPath,
    doc: moduleDoc(language.comment, src),
    start_line: 1,
    end_line: src.split('\n').length,
    body_hash: md5(src),
    exported: 0,
  });
  let tree = null;
  let text = src;
  if (language.grammar) {
    const parser = parsers?.get(lang);
    if (!parser) throw new Error(`no parser loaded for ${lang}`);
    if (language.parse) {
      const parsed = language.parse(parser, src);
      tree = parsed?.tree ?? null;
      text = parsed?.src ?? src;
    } else {
      tree = parser.parse(src);
    }
    if (!tree) throw new Error(`tree-sitter returned no tree for ${relPath}`);
  }
  try {
    const root = tree?.rootNode ?? null;
    language.extract({ relPath, src: text, root, module: moduleSymbol }, out);
  } finally {
    tree?.delete();
  }
  return withParents(out);
}

// Every symbol but the file's own row has a container; one an extractor gave
// none is the file's.
function withParents(out: Collector): Collector {
  out.symbols.forEach((s, i) => {
    if (i > 0 && s.parent === undefined) s.parent = 0;
  });
  return out;
}
