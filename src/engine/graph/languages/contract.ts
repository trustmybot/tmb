// The one contract every language of the code graph meets (trustmybot/tmb#157): a file's text
// in; its definitions, the container of each, and its references out. The build, the lookups
// and the dashboard know only this contract, never a language's own rules.
import type { Node, Parser, Tree } from 'web-tree-sitter';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'sh_function'
  | 'sql_table'
  | 'sql_index'
  | 'sql_trigger'
  | 'module'
  | 'hook'
  | 'runner';

export type EdgeKind =
  | 'calls'
  | 'imports'
  | 'instantiates'
  | 'sources'
  | 'runs'
  | 'reads_table'
  | 'writes_table'
  | 'indexes'
  | 'triggers_on'
  | 'bundles'
  | 'reads_config'
  | 'covers';

// A language's name, as its module in the registry gives it.
export type SourceLanguage = string;

export interface ExtractedSymbol {
  kind: SymbolKind;
  qualified_name: string;
  signature: string;
  doc: string;
  start_line: number;
  end_line: number;
  body_hash: string;
  exported: number;
  run_order?: number;
  // A TS/JS function's or method's FunctionParams as JSON (GH 3176); absent
  // on every other kind and language.
  params_json?: string;
  // What contains it, as an index into Extraction.symbols: a function, a class
  // or the file. Absent only on the file's own 'module' row.
  parent?: number;
  // 1 on a function with no name of its own. Its owner is the nearest named
  // symbol around it, which agents' lookups name in its place.
  unnamed?: number;
  owner?: number;
  // How far a named function's bare name reaches: 'nested' inside another
  // function, 'member' when bound as an object's key or an assignment's target,
  // which no bare call names. Absent on a declaration of the file or a class.
  reach?: 'nested' | 'member';
  // A class's bases as its file names them, through the file's own import aliases (`extends B`,
  // `class C(B)`); '' for a base that is no plain name, such as `extends mixin(B)`. Absent when
  // it has none, and on every other kind.
  bases?: string[];
}

export interface ParamInfo {
  name: string;
  type: string | null;
  optional: boolean;
  default?: string;
}

export interface FunctionParams {
  params: ParamInfo[];
  returns: string | null;
}

// src indexes Extraction.symbols. hint is the import specifier of an
// 'imports' edge, or the receiver of a member call: its class when the file
// types it (`C` for `obj: C` in obj.fn()), else its text (`obj`).
export interface ExtractedEdge {
  src: number;
  kind: EdgeKind;
  dst_name: string;
  line: number;
  hint: string | null;
  // Where the language finds the name before the file's own names and imports
  // (trustmybot/tmb#246); absent when nothing around the reference binds it.
  bound?: Bound;
  // 1 on a call written in the symbol it starts from: a call or a construction as the language's
  // grammar writes one, whatever its callee (trustmybot/tmb#252). Absent on every other reference,
  // such as a function passed as a value or a class a class extends.
  call?: 1;
  // On a call: where the language's lookup ends for its name, or for the name of the object it is
  // called on, when that is no definition of the repo it could link.
  outside?: Outside;
}

// Where a call's lookup ends outside the file's own definitions (trustmybot/tmb#252):
// - builtin: `name` is one of the language's built-ins, and nothing around the call or in the
//   file binds it; on `x.f()`, the built-in `x` declares a callable `f`;
// - import: the name, or the object it is called on, is an import of `module`, as the file writes
//   it, and not one relative to the file. The resolver decides whether that module is a package
//   outside the repo: by the repo's import settings, or, when `searched` is given, by the paths at
//   which the language finds the module in any folder it searches (`a/b.py`; a folder ends in
//   `/`): outside only when no file of the repo is at one of them.
export type Outside = { kind: 'builtin'; name: string } | { kind: 'import'; module: string; searched?: readonly string[] };

/** What a call edge adds to a reference. */
export type CallMark = { outside?: Outside };

// How a name is bound around a reference, the first place the language looks:
// - function: a function or class declared in a function or block around it,
//   and `hint` is the line its symbol starts on, the one target it may have;
// - value: anything else there, such as a parameter, a variable or a class's
//   field; it is no function of the repo, so it is never linked;
// - import: an import made inside the function around it, or a TypeScript
//   `import { A as B }` alias (trustmybot/tmb#242), and `hint` is that
//   import's module. On an 'imports' edge, the import is one made inside a
//   function, which holds only there;
// - self: a call on the object itself (`this`, `self`, `cls`), and `hint` is
//   its class; only that class and its parents are looked in.
export type Bound = 'function' | 'value' | 'import' | 'self';

// A name a file gives other files without declaring it under that name (trustmybot/tmb#233),
// which the resolver follows to the declaration. `source` is a module specifier as the file
// writes it.
// - name: `name` is `original` from `source`, or the file's own `original` when `source` is null;
// - star: every name of `source` that the language's star rule gives;
// - namespace: `name` is the whole module `source`, as `export * as name from` makes it;
// - all: a Python module's `__all__`, its names when it is a plain list or tuple of strings,
//   null when code builds it.
export type ExtractedExport =
  | { kind: 'name'; name: string; original: string; source: string | null }
  | { kind: 'star'; source: string }
  | { kind: 'namespace'; name: string; source: string }
  | { kind: 'all'; names: string[] | null };

export interface Extraction {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  // Absent when the file re-exports nothing.
  exports?: ExtractedExport[];
}

// Gathers one file's symbols and references as a language's rules find them.
export class Collector {
  readonly symbols: ExtractedSymbol[] = [];
  readonly edges: ExtractedEdge[] = [];
  readonly exports: ExtractedExport[] = [];
  private readonly byKey = new Map<string, number>();

  // A symbol seen again under the same key is the same row: by default its
  // kind and name, so a class and its merged declarations are one; a function
  // passes its own place, so two functions that share a name stay two.
  symbol(s: ExtractedSymbol, key = `${s.kind}\u0000${s.qualified_name}`): number {
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    this.symbols.push(s);
    this.byKey.set(key, this.symbols.length - 1);
    return this.symbols.length - 1;
  }

  edge(src: number, kind: EdgeKind, dstName: string, line: number, hint: string | null = null, bound?: Bound, call?: CallMark): void {
    this.edges.push({ src, kind, dst_name: dstName, line, hint, ...(bound ? { bound } : {}), ...(call ? { call: 1 as const, ...(call.outside ? { outside: call.outside } : {}) } : {}) });
  }

  export(e: ExtractedExport): void {
    this.exports.push(e);
  }
}

// One file, as a language's rules receive it. `root` is its syntax tree when the language has
// a grammar, else null. `module` is the file's own row, the container of what the rules find
// at its top level.
export interface SourceFile {
  relPath: string;
  src: string;
  root: Node | null;
  module: number;
}

export interface LanguageModule {
  // Its name: the `lang` of each file of it in the graph.
  name: string;
  // The file extensions it reads, lowercase and without the dot.
  extensions: readonly string[];
  // An extensionless file whose first line matches is in this language.
  shebang?: RegExp;
  // The path of its embedded tree-sitter grammar; absent for a language read by patterns.
  grammar?: string;
  // Its comment marker, for the file's leading comment: `#` or `--`, or `//` and `/* */`.
  comment: 'hash' | 'slash';
  // Whether a file's text is machine-minified, so it is kept as a file but not parsed
  // (trustmybot/tmb#232); absent when the language has no minified form.
  minified?(text: string): boolean;
  // How it parses a file, when not with one plain parse: the tree and the text it was parsed
  // from, which keeps every line and column of the file's own text.
  parse?(parser: Parser, src: string): { tree: Tree; src: string } | null;
  extract(file: SourceFile, out: Collector): void;
}
