// A file's text in, its symbols and outgoing references out, through the language module the
// registry names for it (trustmybot/tmb#157). This file holds no language's rules: those are in
// languages/, one folder per language.
import { basename } from 'node:path';
import { Collector, type Extraction, type SourceLanguage, type SymbolKind } from './languages/contract.ts';
import { clip, DOC_MAX, md5, splitWords, STOPWORDS } from './languages/kit.ts';
import { languageNamed, languageOfExtension, languageOfShebang } from './languages/registry.ts';
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
const LEFT_OUT: readonly { rule: string; re: RegExp }[] = [
  { rule: 'dist/', re: /(^|\/)dist\// },
  { rule: 'node_modules/', re: /(^|\/)node_modules\// },
  { rule: 'vendor/', re: /(^|\/)vendor\// },
  { rule: 'source maps', re: /\.map$/ },
  { rule: 'minified (.min.js)', re: /\.min\.js$/ },
  { rule: 'lockfiles', re: /(^|\/)package-lock\.json$/ },
  { rule: 'lockfiles', re: /\.lock(b)?$/ },
];

// The rule that leaves a path out of the graph, or null when the graph reads it.
export function leftOutRule(relPath: string): string | null {
  return LEFT_OUT.find(({ re }) => re.test(relPath))?.rule ?? null;
}

// A path is in symbol scope unless a rule leaves it out.
export function inSymbolScope(relPath: string): boolean {
  return leftOutRule(relPath) === null;
}

// The language a path parses as: by extension, else by the shebang of an extensionless file;
// null when no language module reads it.
export function languageOf(relPath: string, head: () => string): SourceLanguage | null {
  const name = basename(relPath);
  const dot = name.lastIndexOf('.');
  if (dot > 0) return languageOfExtension(name.slice(dot + 1).toLowerCase())?.name ?? null;
  return languageOfShebang(head().slice(0, 120))?.name ?? null;
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
