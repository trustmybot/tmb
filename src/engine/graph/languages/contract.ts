// The one contract every language of the code graph meets (trustmybot/tmb#157): a file's text
// in; its definitions, the container of each, and its references out. The build, the lookups
// and the dashboard know only this contract, never a language's own rules.
import type { Node, Parser, Tree } from 'web-tree-sitter';

/**
 * The kinds of symbol, one set for every language (CODE_GRAPH.md, "Kinds of symbol"): each language
 * module maps its own syntax to them, so no kind is one language's word. A constructor and an
 * accessor are methods; an unnamed function is a function or a method marked `unnamed`. A data
 * source is the engine's own, made from the links that reach one.
 */
export const SYMBOL_KINDS = {
  file: 'file',
  type: 'type',
  function: 'function',
  method: 'method',
  fileData: 'file_level_data',
  dataSource: 'data_source',
} as const;

export type SymbolKind = (typeof SYMBOL_KINDS)[keyof typeof SYMBOL_KINDS];

export type EdgeKind =
  | 'calls'
  | 'imports'
  | 'instantiates'
  | 'sources'
  | 'runs'
  | 'reads_data'
  | 'writes_data'
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
  // or the file. Absent only on the file's own 'file' row.
  parent?: number;
  // 1 on a function with no name of its own. Its owner is the nearest named
  // symbol around it, which agents' lookups name in its place.
  unnamed?: number;
  owner?: number;
  // How far a named function's bare name reaches: 'nested' inside another
  // function, 'member' when bound as an object's key or an assignment's target,
  // which no bare call names. Absent on a declaration of the file or a class.
  // 'none' on a function no call of any language names: code a store runs on its own, such as an SQL
  // trigger (CODE_GRAPH.md, "Data sources"). Like an unnamed function, it is no reference's target.
  reach?: 'nested' | 'member' | 'none';
  // The node's own language, set by the module that writes it, only when it differs from its file's
  // (CODE_GRAPH.md, "Data sources"): SQL for a trigger in a string of TypeScript. Absent on every
  // other node, which is in its file's language.
  lang?: SourceLanguage;
  // 1 on a type its language's own definition calls a class: a type whose objects are made from it
  // (a TypeScript or Python class; a Java class, enum class or record class; a C++ class, struct or
  // union). The built-in rules link a construction of its name to it, read its name written as a
  // receiver's type as proof, and look a method up through its parents ("Links on proof"). Absent
  // on any other type, such as an interface, a trait or a C struct, and on every other kind.
  makesObjects?: 1;
  // A class's bases by the names its file gives them (`extends B`, `class C(B)`), which the
  // resolver looks up as the file binds them, an import under a new name included; '' for a
  // base that is no plain name, such as `extends mixin(B)`. Absent when it has none, and on
  // every other kind.
  bases?: string[];
  // The names a class's own body binds to anything but a method (trustmybot/tmb#287): a field or
  // a signature with no body in TypeScript, an attribute in Python. Each hides a method of the
  // same name further up its parents. Absent when it has none, and on every other kind.
  fields?: string[];
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
  // On an 'imports' edge, the name the import binds in the file when it is not the imported
  // name (`import { A as B }`, `from m import A as B`): a reference to `B` is looked up in the
  // file that import names, by `A` (trustmybot/tmb#287).
  local?: string;
  // 1 on a call written in the symbol it starts from: a call or a construction as the language's
  // grammar writes one, whatever its callee (trustmybot/tmb#252). Absent on every other reference,
  // such as a function passed as a value or a class a class extends.
  call?: 1;
  // On a link to a data source (CODE_GRAPH.md, "Data sources"): the data source's kind, such as a
  // table. Its name is dst_name, '' when the code does not state one. A data source is no symbol
  // of a file: the layer holds one node of each kind and name, and links to it.
  data?: string;
  // Where the name it links is written: on a call, its position (CallAt), which tells two calls of
  // one name on one line apart (CODE_GRAPH.md, "Two ways to make links"); on a use that is no
  // call, such as a function passed as a value or a parent class, where that name is written, the
  // same in every parser, so the compiler's answer for that name can be matched to it.
  pos?: number;
  // On a call: where the language's lookup ends for its name, or for the name of the object it is
  // called on, when that is no definition of the repo it could link.
  outside?: Outside;
  // On a call: the one symbol of the same file the language's own lookup proves it goes to, as an
  // index into Extraction.symbols. That symbol is its link, with no lookup by name; absent when the
  // language's rules prove none.
  target?: number;
  // 1 on a name written as a call inside a macro's input, which the parser cannot see as code
  // (CODE_GRAPH.md, "Inside a macro, the tool says what is a call"). The language's tool says
  // whether it is a call, and one it does not answer as a call is dropped; with no tool to ask, it
  // is a call that is not known, and no link is made from it.
  inMacro?: 1;
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
export type CallMark = { outside?: Outside; target?: number };

// A call edge's mark and its position: the offset in the file's text, in UTF-16 code units as the
// parser reports it, where the name it calls is written, else, when it calls no name, where the
// call starts. A name is one token, so its place is the same in every parser of the language,
// whatever each makes of the operators around it, and no two calls share it.
// `inMacro` marks a name written as a call in a macro's input (ExtractedEdge.inMacro).
export type CallAt = CallMark & { pos: number; inMacro?: 1 };

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
  // Statements the language's parser could not read, each of which gave no link (CODE_GRAPH.md,
  // "Data sources"); absent when there are none.
  statementsNotRead?: number;
}

// Gathers one file's symbols and references as a language's rules find them.
export class Collector {
  readonly symbols: ExtractedSymbol[] = [];
  readonly edges: ExtractedEdge[] = [];
  readonly exports: ExtractedExport[] = [];
  statementsNotRead = 0;
  private readonly byKey = new Map<string, number>();

  // A symbol seen again under the same key is the same row: by default its
  // kind and name, so an interface and its merged declarations are one; a
  // function or a class passes its own place, so two that share a name stay two.
  symbol(s: ExtractedSymbol, key = `${s.kind}\u0000${s.qualified_name}`): number {
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    this.symbols.push(s);
    this.byKey.set(key, this.symbols.length - 1);
    return this.symbols.length - 1;
  }

  // A link to a data source of this kind and name ('' when the code does not state it).
  dataLink(src: number, kind: EdgeKind, data: string, name: string, line: number): void {
    this.edges.push({ src, kind, dst_name: name, line, hint: null, data });
  }

  // `at` is where a use that is no call writes its name; a call's place is in `call`.
  edge(src: number, kind: EdgeKind, dstName: string, line: number, hint: string | null = null, bound?: Bound, local?: string, call?: CallAt, at?: number): void {
    this.edges.push({
      src,
      kind,
      dst_name: dstName,
      line,
      hint,
      ...(bound ? { bound } : {}),
      ...(local ? { local } : {}),
      ...(call
        ? {
            call: 1 as const,
            pos: call.pos,
            ...(call.outside ? { outside: call.outside } : {}),
            ...(call.target !== undefined ? { target: call.target } : {}),
            ...(call.inMacro ? { inMacro: call.inMacro } : {}),
          }
        : at !== undefined
          ? { pos: at }
          : {}),
    });
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
  // The languages of GitHub Linguist's list it reads, by Linguist's names (trustmybot/tmb#154):
  // a file is read by the module whose language Linguist settles the file on.
  linguist: readonly string[];
  // The file endings that are its own, lower case with the dot. An ending belongs to one module.
  // A file Linguist's rules leave several languages is read by the module that owns its ending,
  // when that module reads one of them; with no owner it is not parsed (CODE_GRAPH.md, edge cases 1
  // and 2).
  endings: readonly string[];
  // Dialects Linguist names apart that it reads too, in a file with one of its own endings: a
  // dialect's other endings are not read.
  dialects?: readonly string[];
  // Whether a file of its language only declares what another file runs, such as a stub: it is
  // kept as a file of that language with no symbols (trustmybot/tmb#390).
  declarationsOnly?(relPath: string): boolean;
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
  // The language's own tool, which makes the links of its calls when a repo asks for it (way B,
  // trustmybot/tmb#311); absent for a language with no tool, whose links are always the built-in
  // rules'. Languages that share one tool name the same object, so one program reads them all.
  tool?: LanguageTool;
}

// A node of the graph a tool may link a call to: its file, its own name and its lines. Its index
// in ToolInput.nodes is how an answer names it.
export interface ToolNode {
  path: string;
  name: string;
  start: number;
  end: number;
}

// A call the graph holds, as the built-in parser found it: its file, its position (CallAt) and
// the name it calls. `inMacro` is set on a name written as a call in a macro's input, which the
// parser cannot see as code: the tool says whether it is a call (ExtractedEdge.inMacro).
export interface ToolCall {
  path: string;
  pos: number;
  name: string;
  inMacro?: true;
}

// What a repo gives its tool: the text of every file of the tool's languages at the commit, the
// project's settings files at the commit (package.json, tsconfig.json, … and each file the tool
// reads besides, LanguageTool.reads), any other file of the commit read when the tool asks for it
// by its path (a settings file another one names), the graph's nodes in those files and the
// graph's calls in them.
export interface ToolInput {
  files: ReadonlyMap<string, string>;
  configs: ReadonlyMap<string, string>;
  read(path: string): string | undefined;
  nodes: readonly ToolNode[];
  calls: readonly ToolCall[];
}

// The tool's answer for one call (CODE_GRAPH.md, "Two ways to make links"): linked to each node, by
// its index in ToolInput.nodes, of the declarations the language proves the call can go to, one or
// more (trustmybot/tmb#344); else outside the repo, or not known. For a name in a macro's input
// (ToolCall.inMacro), `{ call: false }` says the tool does not answer it as a call: it is dropped.
export type ToolAnswer = { nodes: readonly [number, ...number[]] } | { state: 'outside' | 'not_known' } | { call: false };

// A language's own tool, opened for one repo with the copy the find order found (CODE_GRAPH.md,
// "Where a language's tool comes from"); one that cannot run in the repo says why. Opening may wait
// (a tool that loads its own parts first); answering does not.
export interface LanguageTool {
  // What it is, for a reader.
  name: string;
  // Where its copy comes from: the facts the find order reads.
  copy: ToolCopy;
  // The files of the commit the tool reads besides its languages' own, such as its settings files
  // or the language's stubs; absent when it reads none.
  reads?(path: string): boolean;
  open(repoDir: string, found: FoundCopy): OpenedTool | Promise<OpenedTool>;
  // What its answers rest on beyond the commit and the copy (CODE_GRAPH.md: "A way B graph is stale
  // when the tool or the installed packages change", trustmybot/tmb#325), made again at each read
  // of a layer it built: a change makes the layer stale. `places` are where it read the repo's
  // installed packages, as its answer gave them (OpenedTool), [] when it did not run. It reads only
  // what says what is installed, never the packages' code, and runs no code of the repo.
  builtWith(repoDir: string, places: readonly string[], found: FoundCopy): BuiltWith;
  // The program tmb builds, from source it carries, to run the tool with the copy found, kept in the
  // tools folder of the state folder given (CODE_GRAPH.md, "Go's helper is built once"); absent for
  // a tool that needs none, null when the copy does not say what it would build. It builds nothing.
  helper?(found: FoundCopy, stateDir: string): BuiltHelper | null;
}

// The repo's installed packages a tool's answers rest on, at the places it read them, as one text.
export type BuiltWith = { packages: string };

// A program tmb builds from source it carries to run a tool: its name; its key, a digest of all its
// build rests on, which a new key builds again; its source's digest; the tool, as it names its own
// version, that builds it; where it is kept; and whether it is built there yet.
export type BuiltHelper = { name: string; key: string; source: string; builtBy: string; path: string; built: boolean };

/**
 * Whose copy of a tool is used (CODE_GRAPH.md, "Where a language's tool comes from"): the one a
 * setting names, the user's own, or tmb's.
 */
export type Whose = 'setting' | 'user' | 'tmb';

/**
 * The copy the find order found: whose it is, its program's path (null for one tmb carries in its
 * own program), and its version as it reports it. `note` says why the user's copy was passed over.
 */
export type FoundCopy = { whose: Whose; path: string | null; version: string; note?: string };

/**
 * A tool's facts for the find order, kept in its language's module:
 * - carried: tmb carries the tool in its own program, at this version;
 * - else a program the find order looks for: its file's name; how a reader names it; the arguments
 *   that make it report its version, and the environment it runs in; its report from its output;
 *   the lowest version tmb supports, for a reader, and whether a report is at or above it; the
 *   folders besides PATH where the language's own installer puts the user's copy; and whether tmb
 *   keeps a copy of it in its tools folder, which it never does for a language's own command.
 */
export type ToolCopy =
  | { carried: string }
  | {
      program: string;
      what: string;
      versionArgs: readonly string[];
      env?: Readonly<Record<string, string>>;
      report(output: { stdout: string; stderr: string }): string;
      lowest: string;
      supported(report: string): boolean;
      userPlaces?(): string[];
      tmbInstalls: boolean;
    };

// A tool that runs may still tell the reader something its answers rest on, such as a setting of
// the repo it could not follow: `note` adds it to the answer's freshness. `readFrom` names the
// places it read the repo's installed packages from, which LanguageTool.builtWith reads again.
// A tool that runs as its own program, talked to while it works, answers later: `answer` may return
// a promise.
export type OpenedTool =
  | {
      answer(input: ToolInput, note: (text: string) => void, readFrom: (places: readonly string[]) => void): ToolAnswer[] | Promise<ToolAnswer[]>;
    }
  | { unavailable: string };
