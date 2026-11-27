// What C and C++ share in the code graph (trustmybot/tmb#355): the nodes of a file, the calls each
// makes, and the links way A proves inside one file. C++ is a superset here: a namespace, a class's
// members, a lambda, a construction with `new`. Each rule names the section of the C standard
// (ISO/IEC 9899:2011, "C11") or of the C++ standard (ISO/IEC 14882:2020, by its stable names, such as
// [basic.lookup.unqual]) it reads. Way A links only what those rules prove inside one file.
import type { Node, Parser, Tree } from 'web-tree-sitter';
import { type CallMark, type Collector, type LanguageModule, SYMBOL_KINDS, type SymbolKind } from '../contract.ts';
import { docOf, memberHint, named, normalizedHash, signatureOf } from '../kit.ts';

/** The grammar's node type for a comment, in both grammars. */
export const C_COMMENTS: readonly string[] = ['comment'];

/** Which language's rules a file follows. */
export type Dialect = 'c' | 'cpp';

// The nodes a declarator names its entity by (C11 6.7.6; [dcl.decl]): a plain or a member name, a
// qualified name, a destructor's, an operator's, a conversion function's, and a template's
// specialization.
const NAME_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'field_identifier',
  'qualified_identifier',
  'destructor_name',
  'operator_name',
  'operator_cast',
  'template_function',
]);

/** The declarators that wrap a name (C11 6.7.6; [dcl.meaning]). */
const WRAPPERS: ReadonlySet<string> = new Set([
  'function_declarator',
  'pointer_declarator',
  'reference_declarator',
  'array_declarator',
  'init_declarator',
  'attributed_declarator',
  'parenthesized_declarator',
]);

/** The wrappers that leave a declarator's type as it is: parentheses (C11 6.7.6 p6), an attribute and an initializer. */
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set(['parenthesized_declarator', 'attributed_declarator', 'init_declarator']);

/** A class (C++ [class.pre]), a structure or a union (C11 6.7.2.1), and an enumeration (C11 6.7.2.2; [dcl.enum]). */
const TYPE_SPECIFIERS: ReadonlySet<string> = new Set(['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier']);

/** A C++ class-key's default access (C++ [class.access] p2): `class` private, `struct` and `union` public. */
const DEFAULT_ACCESS: Readonly<Record<string, string>> = { class_specifier: 'private', struct_specifier: 'public', union_specifier: 'public' };

/** The preprocessor's conditional groups (C11 6.10.1): code in one is compiled only when its condition holds. */
const CONDITIONAL_GROUPS: ReadonlySet<string> = new Set(['preproc_if', 'preproc_ifdef', 'preproc_else', 'preproc_elif', 'preproc_elifdef']);

/** The nodes that hold declarations in sequence and add no scope of their own: a conditional group and a linkage specification's body. */
const PASS_THROUGH: ReadonlySet<string> = new Set([...CONDITIONAL_GROUPS, 'declaration_list']);

// The C++ casts written like a function's call that are operators, not calls (C++ [expr.cast],
// [expr.static.cast], [expr.dynamic.cast], [expr.const.cast], [expr.reinterpret.cast]).
const CAST_KEYWORDS: ReadonlySet<string> = new Set(['static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast']);

// The declarations that bind a name in a block or a parameter list, each of which hides a name of
// an enclosing scope (C11 6.2.1 p4; [basic.scope.block], [basic.lookup.unqual]).
const DECLARATION_HOLDERS: ReadonlySet<string> = new Set([
  'parameter_declaration',
  'optional_parameter_declaration',
  'variadic_parameter_declaration',
  'declaration',
  'type_definition',
  'for_range_loop',
  'condition_clause',
]);

const startLine = (n: Node): number => n.startPosition.row + 1;
const endLine = (n: Node): number => n.endPosition.row + 1;

/** The name a declarator declares, and whether it declares a function: whether the declarator nearest the name is a function declarator. */
export function declared(decl: Node | null): { name: Node; fn: boolean } | null {
  const chain: string[] = [];
  let n = decl;
  while (n) {
    if (NAME_TYPES.has(n.type)) {
      const near = chain.filter((t) => !TRANSPARENT_WRAPPERS.has(t)).at(-1);
      return { name: n, fn: n.type === 'operator_cast' || near === 'function_declarator' };
    }
    if (!WRAPPERS.has(n.type)) return null;
    chain.push(n.type);
    n = n.childForFieldName('declarator') ?? named(n).find((c) => WRAPPERS.has(c.type) || NAME_TYPES.has(c.type)) ?? null;
  }
  return null;
}

/** A name as its parts, `a::B::f` as [a, B, f]; `global` when it starts with `::`. */
export function partsOf(n: Node): { parts: string[]; global: boolean } {
  switch (n.type) {
    case 'qualified_identifier': {
      const scope = n.childForFieldName('scope');
      const name = n.childForFieldName('name');
      const head = scope ? partsOf(scope) : { parts: [], global: true };
      const tail = name ? partsOf(name).parts : [];
      return { parts: [...head.parts, ...tail], global: head.global };
    }
    case 'template_function':
    case 'template_type':
    case 'template_method': {
      const name = n.childForFieldName('name');
      return name ? partsOf(name) : { parts: [n.text], global: false };
    }
    case 'destructor_name':
      return { parts: [`~${n.text.replace(/^~\s*/, '')}`], global: false };
    case 'operator_name': {
      const rest = n.text.slice('operator'.length).replace(/\s+/g, '');
      return { parts: [/^[A-Za-z_]/.test(rest) ? `operator ${rest}` : `operator${rest}`], global: false };
    }
    case 'operator_cast':
      return { parts: [`operator ${(n.childForFieldName('type')?.text ?? '').replace(/\s+/g, ' ')}`], global: false };
    case 'nested_namespace_specifier':
      return { parts: n.text.split('::').map((p) => p.replace(/^\s*inline\s+/, '').trim()).filter((p) => p !== ''), global: false };
    default:
      return { parts: [n.text], global: false };
  }
}

/** The node a declaration's lines and doc start at: its outermost `template <…>` head (C++ [temp.pre]), else itself. */
function spanOf(n: Node): Node {
  let s = n;
  while (s.parent?.type === 'template_declaration') s = s.parent;
  return s;
}

/** The conditional groups around a node: the grammar's, and the first groups way A kept of those it blanked (`kept`), as keys. */
function groupsOf(n: Node, kept: readonly Blank[]): string[] {
  const out: string[] = [];
  for (let p = n.parent; p; p = p.parent) if (CONDITIONAL_GROUPS.has(p.type)) out.push(`node ${p.id}`);
  for (const [start, end] of kept) if (n.startIndex >= start && n.startIndex < end) out.push(`kept ${start}`);
  return out;
}

/** Whether `target` is compiled whenever `call` is: every conditional group around it is around the call too. */
function compiledWith(target: Node, call: Node, kept: readonly Blank[]): boolean {
  const around = new Set(groupsOf(call, kept));
  return groupsOf(target, kept).every((g) => around.has(g));
}

/** Whether a declaration has the storage class `word` (C11 6.7.1; [dcl.stc]). */
const hasStorage = (decl: Node, word: string): boolean => named(decl).some((c) => c.type === 'storage_class_specifier' && c.text === word);

/** One class of the file and what its body declares (C++ [class.mem]). */
interface ClassInfo {
  node: Node;
  full: string;
  own: string;
  symbol: number;
  // The member functions it declares by each name, as their declarations in the body.
  functions: Map<string, Node[]>;
  // Every other name its body declares: a data member, a type, an enumerator, a friend.
  others: Set<string>;
  // The names a using-declaration brings into it from a base (C++ [namespace.udecl]).
  usings: Set<string>;
  // Its member classes defined in its body, by their own names.
  nested: Map<string, ClassInfo[]>;
}

/** The function a call is written in, for the rules that follow its scopes. */
interface FnInfo {
  node: Node;
  // The class whose member it is, when the file defines that class.
  cls: ClassInfo | null;
  member: boolean;
  // Its namespace, as a key: '' for the global one.
  ns: string;
}

/** A declaration at namespace scope, by its namespace and name. */
interface NsEntry {
  kind: 'definition' | 'declaration' | 'other';
  node: Node;
  symbol?: number;
  template?: boolean;
  provable?: boolean;
}

/** Where the visit is. */
interface Ctx {
  // The qualified-name parts a node declared here is named through.
  prefix: string[];
  // The namespace's key, '' for the global namespace.
  ns: string;
  // Whether here is inside an unnamed namespace, whose names have internal linkage (C++ [basic.link] p4).
  internal: boolean;
  container: number;
  scope: number;
  owner: number;
  cls: ClassInfo | null;
  fn: FnInfo | null;
  // Inside a function's body.
  local: boolean;
}

/** A span of the text to blank: start and end offsets. */
type Blank = [number, number];

/** The containers a function definition at file or namespace level sits in: not a class's body. */
const OUTSIDE_CLASSES: ReadonlySet<string> = new Set([
  'translation_unit',
  'declaration_list',
  'preproc_if',
  'preproc_ifdef',
  'preproc_else',
  'preproc_elif',
  'preproc_elifdef',
  'linkage_specification',
]);

// A body at file or namespace level is a function definition's (C11 6.9.1; [dcl.fct.def.general]).
// When a macro's parentheses wrap the head before it, `M(static int f(int n)) { … }`, as a macro that
// adds an attribute writes it, the head inside them declares the function. The grammar cannot read
// the macro: C reads `M(…)` as a type and the body as a statement, which a file cannot hold; C++
// reads `M` as a function with no return type, which only a constructor is, and a constructor is
// named through its class outside it ([class.ctor]). The macro's name and its parentheses are
// blanked, keeping every line and column, and the file parsed again.
function macrosAroundHeads(root: Node, cpp: boolean): Blank[] {
  const blanks: Blank[] = [];
  const parens = (n: Node): { open: Node; close: Node } | null => {
    const open = n.children.find((c) => c?.type === '(');
    const close = n.children.at(-1);
    return open && close?.type === ')' ? { open, close } : null;
  };
  const walk = (n: Node): void => {
    if (!cpp && n.type === 'macro_type_specifier' && n.nextNamedSibling?.type === 'compound_statement' && OUTSIDE_CLASSES.has(n.parent?.type ?? '')) {
      const name = n.childForFieldName('name');
      const p = parens(n);
      if (name && p && /\)\s*$/.test(n.text.slice(0, p.close.startIndex - n.startIndex))) blanks.push([name.startIndex, p.open.endIndex], [p.close.startIndex, p.close.endIndex]);
    }
    if (cpp && n.type === 'function_definition' && !n.childForFieldName('type') && OUTSIDE_CLASSES.has(n.parent?.type ?? '')) {
      const declarator = n.childForFieldName('declarator');
      const name = declarator?.type === 'function_declarator' ? declarator.childForFieldName('declarator') : null;
      const params = declarator?.childForFieldName('parameters');
      const only = params ? named(params) : [];
      const p = params ? parens(params) : null;
      if (name?.type === 'identifier' && p && only.length === 1 && only[0]!.type === 'parameter_declaration' && only[0]!.descendantsOfType('function_declarator').length > 0) {
        blanks.push([name.startIndex, p.open.endIndex], [p.close.startIndex, p.close.endIndex]);
      }
    }
    if (cpp && n.type === 'function_definition' && !n.childForFieldName('type')) {
      // `int f(int a) M(x) { … }`: a word after a declarator and before a body, as an annotation
      // macro writes it. The grammar ends the declaration of `f` with no `;` and reads `M(x) { … }`
      // as a function with no return type. A declaration ends with `;` ([dcl.dcl]), so the body is
      // `f`'s, and `M(x)` is blanked.
      const declarator = n.childForFieldName('declarator');
      const name = declarator?.type === 'function_declarator' ? declarator.childForFieldName('declarator') : null;
      const before = n.previousSibling;
      const end = before?.lastChild;
      if (
        declarator &&
        (name?.type === 'identifier' || name?.type === 'field_identifier') &&
        (before?.type === 'declaration' || before?.type === 'field_declaration') &&
        end?.type === ';' &&
        end.isMissing &&
        before.childForFieldName('declarator')?.type === 'function_declarator'
      ) {
        blanks.push([declarator.startIndex, declarator.endIndex]);
      }
    }
    for (const c of named(n)) walk(c);
  };
  walk(root);
  return blanks;
}

/** The directives of a conditional (C11 6.10.1, with C23's `#elifdef` and `#elifndef`; C++ [cpp.cond]): one that opens it, one that starts another group, and one that closes it. */
const OPENING_DIRECTIVES: ReadonlySet<string> = new Set(['if', 'ifdef', 'ifndef']);
const GROUP_DIRECTIVES: ReadonlySet<string> = new Set(['elif', 'elifdef', 'elifndef', 'else']);
const CLOSING_DIRECTIVE = 'endif';

/** The grammar's nodes for a conditional, and for each group after its first. */
const CONDITIONAL_OPENERS: ReadonlySet<string> = new Set(['preproc_if', 'preproc_ifdef']);
const CONDITIONAL_ALTERNATIVES: ReadonlySet<string> = new Set(['preproc_elif', 'preproc_elifdef', 'preproc_else']);

/** One directive line: where its `#` is, and where the line ends, with the lines a backslash continues it onto (C11 5.1.1.2 phase 2). */
interface Directive {
  word: string;
  hash: number;
  start: number;
  end: number;
}

/** A conditional as the text writes it: its directives in order, from the one that opens it to its `#endif`. */
interface Conditional {
  directives: Directive[];
}

/**
 * The conditionals of a file, from its text: a directive is a line whose first token is `#` (C11
 * 6.10 p2; [cpp.pre]), outside a comment and a literal. A conditional the text does not close is
 * left out.
 */
function conditionalsOf(text: string): Conditional[] {
  const out: Conditional[] = [];
  const open: Conditional[] = [];
  let i = 0;
  let lineStart = true;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      lineStart = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = endOfLogicalLine(text, i);
      continue;
    }
    if (ch === '#' && lineStart) {
      const start = text.lastIndexOf('\n', i - 1) + 1;
      const end = endOfLogicalLine(text, i);
      const word = /^#\s*([A-Za-z_]+)/.exec(text.slice(i, end))?.[1] ?? '';
      const d: Directive = { word, hash: i, start, end };
      if (OPENING_DIRECTIVES.has(word)) open.push({ directives: [d] });
      else if (GROUP_DIRECTIVES.has(word)) open.at(-1)?.directives.push(d);
      else if (word === CLOSING_DIRECTIVE) {
        const c = open.pop();
        if (c) {
          c.directives.push(d);
          out.push(c);
        }
      }
      i = end;
      continue;
    }
    lineStart = false;
    if (ch === '"' || ch === "'") {
      // A literal ends at its unescaped quote, and never past its line.
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** Where the logical line around `i` ends: before the newline that no backslash escapes. */
function endOfLogicalLine(text: string, i: number): number {
  let at = i;
  for (;;) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    if (!/\\\r?$/.test(text.slice(at, nl))) return nl;
    at = nl + 1;
  }
}

/**
 * Whether the grammar read a conditional as the text writes it: a conditional's node opens at its
 * first directive, each group after the first starts at its directive, and the node's `#endif` is
 * the conditional's own. The grammar reads a conditional only where a declaration, a member or a
 * statement may stand; elsewhere it reads the directives as tokens of the construct around them.
 */
function readAsWritten(root: Node, c: Conditional): boolean {
  const first = c.directives[0]!;
  const last = c.directives.at(-1)!;
  let node: Node | null = root.descendantForIndex(first.hash);
  while (node && !(CONDITIONAL_OPENERS.has(node.type) && node.startIndex === first.hash)) node = node.parent;
  if (!node) return false;
  const groups: number[] = [];
  for (let n: Node | null = node; n; ) {
    const next: Node | null = n.children.find((ch): ch is Node => ch !== null && CONDITIONAL_ALTERNATIVES.has(ch.type)) ?? null;
    if (next) groups.push(next.startIndex);
    n = next;
  }
  const middle = c.directives.slice(1, -1).map((d) => d.hash);
  const endif = node.children.find((ch) => ch?.type === `#${CLOSING_DIRECTIVE}`);
  return endif?.startIndex === last.hash && groups.length === middle.length && groups.every((g, k) => g === middle[k]);
}

/** What way A reads of a conditional the grammar cannot place: the spans it keeps, and the macros the groups it drops define. */
interface ConditionalReading {
  kept: Blank[];
  dropped: Set<string>;
}

// A conditional is processed before the code is parsed (C11 5.1.1.2 phase 4, 6.10.1 p6; C++
// [cpp.cond]): the compiler reads one of its groups and none of the others, and a directive may stand
// between any two tokens. The grammar reads a conditional only where a declaration, a member or a
// statement may stand. One that cuts a construct, inside a member initializer list, the head of a
// `for` or an initializer, it reads as tokens of that construct, and the constructs after it are
// misread. Way A reads such a conditional with its first group, the code compiled when its
// condition holds: its directives and its other groups are blanked, keeping every line and column.
// Innermost first: a conditional nested in one the grammar misreads may be what misreads it.
function conditionalsCut(root: Node, text: string): { blanks: Blank[]; reading: ConditionalReading } {
  const all = conditionalsOf(text);
  const cut = all.filter((c) => !readAsWritten(root, c));
  const inside = (a: Conditional, b: Conditional): boolean => a !== b && a.directives[0]!.start > b.directives[0]!.start && a.directives.at(-1)!.end < b.directives.at(-1)!.end;
  const innermost = cut.filter((c) => !cut.some((d) => inside(d, c)));
  const blanks: Blank[] = [];
  const reading: ConditionalReading = { kept: [], dropped: new Set() };
  for (const c of innermost) {
    const [first, second] = c.directives;
    const last = c.directives.at(-1)!;
    blanks.push([first!.start, first!.end]);
    reading.kept.push([first!.end, second!.start]);
    // The groups after the first, with their directives, through the `#endif`.
    blanks.push([second!.start, last.end]);
    for (const m of text.slice(second!.start, last.end).matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm)) reading.dropped.add(m[1]!);
  }
  return { blanks, reading };
}

/** Each tree's reading of the conditionals parseFamily blanked, for extractFamily. */
const READINGS = new WeakMap<Tree, ConditionalReading>();

/** How many times the macros around heads are blanked, each pass finding what the last one's blanks uncovered. */
const MACRO_PASSES = 8;

/** Blanks a span, keeping its line breaks, so every line and column stays where it is. */
const blank = (text: string, [start, end]: Blank): string => text.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ') + text.slice(end);

/**
 * Parses a C or C++ file, blanking each span `find` gives, and the macros around a function's head
 * (macrosAroundHeads), and parsing again until none is left; then, the same way, reading each
 * conditional the grammar cannot place with its first group (conditionalsCut). Every line and
 * column stays where it is.
 */
export function parseFamily(dialect: Dialect, find: (root: Node) => Blank[] = () => []): NonNullable<LanguageModule['parse']> {
  return (parser: Parser, src: string) => {
    let text = src;
    let tree = parser.parse(text);
    const reading: ConditionalReading = { kept: [], dropped: new Set() };
    // Each pass blanks what it finds; what is nested in it is found once the outer part parses.
    let macroPasses = 0;
    while (tree) {
      let blanks = macroPasses < MACRO_PASSES ? [...find(tree.rootNode), ...macrosAroundHeads(tree.rootNode, dialect === 'cpp')] : [];
      if (blanks.length > 0) macroPasses++;
      else {
        // Each pass blanks at least one conditional's directives, so the passes end.
        const cut = conditionalsCut(tree.rootNode, text);
        blanks = cut.blanks;
        reading.kept.push(...cut.reading.kept);
        for (const name of cut.reading.dropped) reading.dropped.add(name);
      }
      if (blanks.length === 0) break;
      for (const span of blanks) text = blank(text, span);
      tree.delete();
      tree = parser.parse(text);
    }
    if (!tree) return null;
    READINGS.set(tree, reading);
    return { tree, src: text };
  };
}

/** The nodes and calls of a C or C++ file, by its dialect's rules, into `out`. */
export function extractFamily(dialect: Dialect, root: Node, src: string, out: Collector, moduleSymbol: number): void {
  const cpp = dialect === 'cpp';
  const reading = READINGS.get(root.tree) ?? { kept: [], dropped: new Set<string>() };
  const symbolOf = (
    kind: SymbolKind,
    name: string,
    node: Node,
    anchor: Node,
    parent: number,
    exported: boolean,
    reach?: 'nested' | 'member',
  ): number =>
    out.symbol(
      {
        kind,
        qualified_name: name,
        signature: signatureOf(node, src),
        doc: docOf(anchor, C_COMMENTS),
        start_line: startLine(anchor),
        end_line: endLine(anchor),
        body_hash: normalizedHash(anchor, C_COMMENTS),
        exported: exported ? 1 : 0,
        parent,
        ...(reach ? { reach } : {}),
      },
      `${kind}\u0000${anchor.startIndex}\u0000${name}`,
    );

  const classes = new Map<string, ClassInfo[]>();
  const namespaces = new Map<string, number>();
  const symbolByNode = new Map<number, number>();
  const outOfLine = new Map<string, { symbol: number; node: Node }[]>();
  const nsEntries = new Map<string, NsEntry[]>();
  const addEntry = (ns: string, name: string, e: NsEntry): void => {
    const key = `${ns}\u0000${name}`;
    nsEntries.set(key, [...(nsEntries.get(key) ?? []), e]);
  };
  const pending: { call: Node; name: Node; hint: string | null; scope: number; fn: FnInfo | null }[] = [];

  /** A namespace-scope declaration's entries for the lookup rules: a function's declaration, else any other name. */
  const recordDeclaration = (decl: Node, ctx: Ctx): void => {
    for (const d of decl.childrenForFieldName('declarator')) {
      const found = declared(d);
      if (!found) continue;
      const { parts } = partsOf(found.name);
      if (parts.length !== 1) continue;
      addEntry(ctx.ns, parts[0]!, { kind: found.fn ? 'declaration' : 'other', node: decl, template: decl.parent?.type === 'template_declaration' });
    }
  };

  // A type with a body: a class, structure, union or enumeration, named by its tag, else by the
  // typedef name it is given (C11 6.7.8; C++ [dcl.typedef] p9). A C tag is in the file's scope
  // wherever it is written (C11 6.2.1 p4); a C++ class is named through the scopes around it.
  const visitType = (node: Node, ctx: Ctx, access: string | null): void => {
    const body = node.childForFieldName('body');
    const holder = node.parent;
    const statement = holder && (holder.type === 'type_definition' || holder.type === 'declaration' || holder.type === 'field_declaration') ? holder : null;
    let own: string[] | null = null;
    const nameNode = node.childForFieldName('name');
    if (nameNode) own = partsOf(nameNode).parts;
    else if (statement?.type === 'type_definition') {
      const typedef = declared(statement.childForFieldName('declarator')) ?? named(statement).find((c) => c.type === 'type_identifier');
      const n = typedef && 'name' in typedef ? typedef.name : (typedef as Node | undefined);
      if (n) own = [n.text];
    }
    if (!body || !own || own.length === 0) {
      visitChildren(node, ctx);
      return;
    }
    const full = cpp ? [...ctx.prefix, ...own] : own;
    const name = full.join('.');
    const anchor = spanOf(statement ?? node);
    const exported = !ctx.internal && !ctx.local && (access === null || access === 'public');
    const symbol = symbolOf(SYMBOL_KINDS.type, ctx.local && cpp ? own.join('.') : name, node, anchor, ctx.container, exported, ctx.local ? 'nested' : undefined);
    // A C++ class, struct or union is a class ([class.pre]); an enumeration and every C type are not.
    if (cpp && node.type !== 'enum_specifier') out.symbols[symbol]!.makesObjects = 1;
    // A C tag is in a namespace of its own (C11 6.2.3); a C++ class name is an ordinary name of its scope.
    if (ctx.cls) ctx.cls.others.add(own.at(-1)!);
    else if (!ctx.local && cpp) addEntry(ctx.ns, own.at(-1)!, { kind: 'other', node });
    if (node.type === 'enum_specifier') {
      // An unscoped enumeration's enumerators are declared in the scope around it (C11 6.2.1; [dcl.enum] p11).
      const scoped = node.children.some((c) => c?.type === 'class' || c?.type === 'struct');
      for (const e of named(body)) {
        const n = e.type === 'enumerator' ? e.childForFieldName('name')?.text : undefined;
        if (!n || scoped) continue;
        if (ctx.cls) ctx.cls.others.add(n);
        else if (!ctx.local) addEntry(ctx.ns, n, { kind: 'other', node: e });
      }
      visitChildren(body, { ...ctx, container: symbol, scope: symbol, owner: symbol });
      return;
    }
    if (!cpp) {
      visitChildren(body, { ...ctx, container: symbol, scope: symbol, owner: symbol });
      return;
    }
    const info: ClassInfo = { node, full: name, own: own.at(-1)!, symbol, functions: new Map(), others: new Set(), usings: new Set(), nested: new Map() };
    classes.set(name, [...(classes.get(name) ?? []), info]);
    if (ctx.cls) ctx.cls.nested.set(info.own, [...(ctx.cls.nested.get(info.own) ?? []), info]);
    symbolByNode.set(node.id, symbol);
    const inner: Ctx = { ...ctx, prefix: ctx.local ? own : full, container: symbol, scope: symbol, owner: symbol, cls: info, fn: ctx.fn };
    for (const c of named(node)) if (c.id !== body.id) visit(c, ctx);
    visitClassBody(body, inner, DEFAULT_ACCESS[node.type] ?? 'public');
  };

  // A class's body (C++ [class.mem]): each member in order, with the access the last access
  // specifier before it gives.
  const visitClassBody = (body: Node, ctx: Ctx, start: string): void => {
    const cls = ctx.cls!;
    let access = start;
    const member = (m: Node): void => {
      if (m.type === 'access_specifier') {
        access = m.text.replace(/\s|:/g, '');
        return;
      }
      if (PASS_THROUGH.has(m.type)) {
        for (const c of named(m)) member(c);
        return;
      }
      const inner = m.type === 'template_declaration' ? (named(m).find((c) => c.type !== 'template_parameter_list') ?? m) : m;
      if (m.type === 'template_declaration' && inner !== m) {
        member(inner);
        return;
      }
      switch (m.type) {
        case 'function_definition':
          visitFunction(m, ctx, access, false);
          return;
        case 'field_declaration':
        case 'declaration': {
          for (const d of m.childrenForFieldName('declarator')) {
            const found = declared(d);
            if (!found) continue;
            const own = partsOf(found.name).parts.at(-1) ?? '';
            if (!found.fn) {
              cls.others.add(own);
              continue;
            }
            // A constructor has no name ([class.ctor] p1): lookup of the class's name finds the class.
            if (own !== cls.own) cls.functions.set(own, [...(cls.functions.get(own) ?? []), m]);
            // A pure virtual function (C++ [class.abstract] p2) is a method with only a declaration: a node.
            if (m.childForFieldName('default_value')?.text === '0') {
              const symbol = symbolOf('method', `${cls.full}.${own}`, m, spanOf(m), cls.symbol, access === 'public');
              symbolByNode.set(m.id, symbol);
            }
          }
          visitChildren(m, ctx, access);
          return;
        }
        case 'friend_declaration': {
          for (const c of named(m)) {
            const f = c.type === 'function_definition' || c.type === 'declaration' ? declared(c.childForFieldName('declarator')) : null;
            if (f) cls.others.add(partsOf(f.name).parts.at(-1) ?? '');
            // A friend function defined in a class is no member (C++ [class.friend] p6, p7): it is in the namespace around the class.
            if (c.type === 'function_definition') visitFunction(c, ctx, access, true);
            else visit(c, ctx);
          }
          return;
        }
        case 'using_declaration': {
          const q = named(m).find((c) => c.type === 'qualified_identifier' || c.type === 'identifier');
          if (q) cls.usings.add(partsOf(q).parts.at(-1) ?? '');
          return;
        }
        case 'alias_declaration':
        case 'type_definition': {
          const n = m.childForFieldName('name') ?? declared(m.childForFieldName('declarator'))?.name;
          if (n) cls.others.add(n.text);
          visitChildren(m, ctx, access);
          return;
        }
        default:
          visit(m, ctx, access);
      }
    };
    for (const m of named(body)) member(m);
  };

  // A function definition (C11 6.9.1; C++ [dcl.fct.def.general]): a function at namespace scope, a
  // member function, a constructor, a destructor or a conversion function. A member is named through
  // its class, and so is a member defined outside it, `Cart::total` as `Cart.total`; it is held by its
  // class when the file defines the class, else by the file (CODE_GRAPH.md, "Kinds of symbol", edge case 3).
  const visitFunction = (node: Node, ctx: Ctx, access: string | null, friend: boolean): void => {
    const d = declared(node.childForFieldName('declarator'));
    if (!d) {
      visitChildren(node, ctx);
      return;
    }
    const { parts, global } = partsOf(d.name);
    const own = parts.at(-1) ?? d.name.text;
    const anchor = spanOf(node);
    const isMember = ctx.cls !== null && !friend;
    // A definition the grammar reads with no function declarator, or a C++ one with no return type
    // at namespace scope that names no constructor, destructor or conversion, is made by a macro
    // the parser does not expand: a function whose real name is not written, which no rule links to.
    const hasType = node.childForFieldName('type') !== null;
    const provable = d.fn && (!cpp || hasType || isMember || parts.length > 1 || d.name.type === 'destructor_name' || d.name.type === 'operator_cast');
    let kind: SymbolKind = 'function';
    let name: string;
    let parent = ctx.container;
    let exported: boolean;
    let cls: ClassInfo | null = null;
    let ns = ctx.ns;
    let qualifiedNs: string | null = null;
    if (isMember) {
      kind = 'method';
      cls = ctx.cls;
      name = `${cls!.full}.${own}`;
      parent = cls!.symbol;
      exported = access === 'public';
      if (own !== cls!.own) cls!.functions.set(own, [...(cls!.functions.get(own) ?? []), node]);
    } else if (cpp && parts.length > 1) {
      // A qualified name defines a member of the class or the namespace it names ([dcl.meaning] p1),
      // looked up from the scope the definition is in, out ([basic.lookup.qual]).
      const qual = parts.slice(0, -1);
      const bases = global ? [[]] : ctx.prefix.map((_, i) => ctx.prefix.slice(0, ctx.prefix.length - i)).concat([[]]);
      let found: ClassInfo | null = null;
      let foundNs: string[] | null = null;
      for (const base of bases) {
        const key = [...base, ...qual].join('.');
        const known = classes.get(key);
        if (known) {
          found = known.length === 1 ? known[0]! : null;
          break;
        }
        if (namespaces.has([...base, ...qual].join('::'))) {
          foundNs = [...base, ...qual];
          break;
        }
      }
      if (foundNs) {
        name = [...foundNs, own].join('.');
        parent = namespaces.get(foundNs.join('::'))!;
        qualifiedNs = foundNs.join('::');
        ns = qualifiedNs;
      } else {
        kind = 'method';
        cls = found;
        name = found ? `${found.full}.${own}` : [...(global ? [] : ctx.prefix), ...parts].join('.');
        parent = found ? found.symbol : moduleSymbol;
      }
      exported = !ctx.internal;
    } else {
      // A friend defined in a class is named by its own name: it is in the namespace around the class.
      name = cpp && !friend ? [...ctx.prefix, own].join('.') : own;
      exported = !ctx.internal && !hasStorage(node, 'static');
    }
    const symbol = symbolOf(kind, name, node, anchor, parent, exported, ctx.local && !isMember ? 'nested' : undefined);
    symbolByNode.set(node.id, symbol);
    if (kind === 'method' && !isMember && cls) {
      const key = `${cls.full}\u0000${own}`;
      outOfLine.set(key, [...(outOfLine.get(key) ?? []), { symbol, node: anchor }]);
    }
    if (!isMember && !friend && !ctx.local && (kind === 'function' || !cpp)) {
      addEntry(qualifiedNs ?? ctx.ns, own, { kind: 'definition', node: anchor, symbol, template: anchor !== node, provable });
    }
    const fn: FnInfo = { node, cls, member: kind === 'method', ns };
    const inner: Ctx = { ...ctx, prefix: [], container: symbol, scope: symbol, owner: symbol, cls: null, fn, local: true };
    visitChildren(node, inner);
  };

  // A declaration at namespace scope. In C and in C++'s global namespace each variable it declares
  // is file-level data, a node; a declaration that is no definition is none: a function's prototype
  // and an `extern` declaration with no initializer (C11 6.9.2; C++ [basic.def] p2). A variable of a
  // named C++ namespace is a member of that namespace, which is a type: a field, no node
  // (CODE_GRAPH.md, "Kinds of symbol"). A call in a variable's value is that variable's, or the file's
  // when the declaration declares several.
  const visitDeclaration = (node: Node, ctx: Ctx): void => {
    recordDeclaration(node, ctx);
    const fileLevel = !cpp || ctx.prefix.length === 0;
    const data: { name: string; d: Node }[] = [];
    for (const d of node.childrenForFieldName('declarator')) {
      const found = declared(d);
      if (!found || found.fn) continue;
      const { parts } = partsOf(found.name);
      if (parts.length !== 1) continue;
      if (hasStorage(node, 'extern') && d.type !== 'init_declarator') continue;
      data.push({ name: parts[0]!, d });
    }
    let scope = ctx.scope;
    // A lambda bound to a file-level name, `auto f = [] {…};`, is the function `f` (CODE_GRAPH.md,
    // "Kinds of symbol"): the variable holds the closure and nothing else, so it is no unnamed function.
    const lambda = data.length === 1 ? data[0]!.d.childForFieldName('value') : null;
    if (fileLevel && lambda?.type === 'lambda_expression') {
      const symbol = symbolOf('function', data[0]!.name, node, node, ctx.container, !ctx.internal && !hasStorage(node, 'static'));
      visitChildren(lambda, { ...ctx, container: symbol, scope: symbol, owner: symbol });
      return;
    }
    if (fileLevel) {
      const made = data.map(({ name }) => symbolOf(SYMBOL_KINDS.fileData, name, node, node, ctx.container, !ctx.internal && !hasStorage(node, 'static')));
      if (made.length === 1) scope = made[0]!;
    }
    visitChildren(node, { ...ctx, scope });
  };

  const visitChildren = (node: Node, ctx: Ctx, access: string | null = null): void => {
    for (const c of named(node)) visit(c, ctx, access);
  };

  const visit = (node: Node, ctx: Ctx, access: string | null = null): void => {
    switch (node.type) {
      case 'namespace_definition': {
        // A namespace is a type-like container (CODE_GRAPH.md, "Kinds of symbol"), named through the
        // ones around it. An unnamed namespace adds no name: its members are named as the namespace
        // around it names them, and have internal linkage ([namespace.unnamed]).
        const nameNode = node.childForFieldName('name');
        const body = node.childForFieldName('body');
        if (!nameNode) {
          if (body) visitChildren(body, { ...ctx, ns: `${ctx.ns}::(unnamed)`, internal: true });
          return;
        }
        const parts = partsOf(nameNode).parts;
        const full = [...ctx.prefix, ...parts];
        const key = [...(ctx.ns === '' ? [] : [ctx.ns]), ...parts].join('::');
        const symbol = symbolOf('type', full.join('.'), node, node, ctx.container, !ctx.internal);
        if (!namespaces.has(full.join('::'))) namespaces.set(full.join('::'), symbol);
        if (body) visitChildren(body, { ...ctx, prefix: full, ns: key, container: symbol, scope: symbol, owner: symbol });
        return;
      }
      case 'linkage_specification': {
        // `extern "C"` sets a linkage and adds no scope ([dcl.link]).
        const body = node.childForFieldName('body');
        if (body) visit(body, ctx, access);
        return;
      }
      case 'class_specifier':
      case 'struct_specifier':
      case 'union_specifier':
      case 'enum_specifier':
        visitType(node, ctx, access);
        return;
      case 'function_definition':
        visitFunction(node, ctx, access, false);
        return;
      case 'declaration':
        if (!ctx.local && ctx.cls === null) {
          visitDeclaration(node, ctx);
          return;
        }
        break;
      case 'type_definition':
      case 'alias_declaration':
        if (!ctx.local && ctx.cls === null) {
          const n = node.childForFieldName('name') ?? declared(node.childForFieldName('declarator'))?.name;
          if (n) addEntry(ctx.ns, n.text, { kind: 'other', node });
        }
        break;
      case 'lambda_expression': {
        // A lambda (C++ [expr.prim.lambda]) is a function with no name, owned by the nearest named node.
        const symbol = out.symbol(
          {
            kind: 'function',
            qualified_name: lambdaLabel(node),
            signature: signatureOf(node, src),
            doc: '',
            start_line: startLine(node),
            end_line: endLine(node),
            body_hash: normalizedHash(node, C_COMMENTS),
            exported: 0,
            parent: ctx.container,
            unnamed: 1,
            owner: ctx.owner,
          },
          `lambda\u0000${node.startIndex}`,
        );
        visitChildren(node, { ...ctx, container: symbol, scope: symbol });
        return;
      }
      case 'call_expression': {
        const callee = calleeOf(node, cpp);
        if (callee) pending.push({ call: node, ...callee, scope: ctx.scope, fn: ctx.fn });
        break;
      }
      case 'new_expression': {
        // `new T(…)` constructs a T (C++ [expr.new]): a call, at the type's name; a built-in type has no constructor to call.
        // `new T*[n]` and `new T*()` make pointers, which have no constructor. The grammar ends the
        // expression at `T` and leaves the `*` after it, so a `*` right after the expression is its type's.
        const type = node.childForFieldName('type');
        const name = type ? typeName(type) : null;
        const pointer = /^\s*\*/.test(src.slice(node.endIndex, node.endIndex + 64));
        if (name && !pointer) pending.push({ call: node, name, hint: null, scope: ctx.scope, fn: ctx.fn });
        break;
      }
    }
    visitChildren(node, ctx, access);
  };

  visitChildren(root, {
    prefix: [],
    ns: '',
    internal: false,
    container: moduleSymbol,
    scope: moduleSymbol,
    owner: moduleSymbol,
    cls: null,
    fn: null,
    local: false,
  });

  // Every name a function binds in its blocks and parameters, and every macro the file defines.
  const bound = new Map<number, Set<string>>();
  const boundIn = (fn: Node): Set<string> => {
    const known = bound.get(fn.id);
    if (known) return known;
    const names = new Set<string>();
    const walk = (n: Node): void => {
      if (DECLARATION_HOLDERS.has(n.type)) {
        for (const d of n.childrenForFieldName('declarator')) {
          const found = declared(d);
          if (found) names.add(partsOf(found.name).parts.at(-1) ?? '');
          else if (d.type === 'type_identifier') names.add(d.text);
        }
      } else if (TYPE_SPECIFIERS.has(n.type)) {
        const name = n.childForFieldName('name');
        if (name) names.add(partsOf(name).parts.at(-1) ?? '');
      } else if (n.type === 'enumerator' || n.type === 'alias_declaration') {
        const name = n.childForFieldName('name');
        if (name) names.add(name.text);
      } else if (n.type === 'using_declaration') {
        const q = named(n).find((c) => c.type === 'qualified_identifier' || c.type === 'identifier');
        if (q) names.add(partsOf(q).parts.at(-1) ?? '');
      } else if (n.type === 'structured_binding_declarator' || n.type === 'lambda_capture_initializer') {
        for (const c of named(n)) if (c.type === 'identifier') names.add(c.text);
      }
      for (const c of named(n)) walk(c);
    };
    walk(fn);
    bound.set(fn.id, names);
    return names;
  };
  const macros = new Set<string>();
  for (const m of root.descendantsOfType(['preproc_def', 'preproc_function_def'])) {
    const name = m?.childForFieldName('name')?.text;
    if (name) macros.add(name);
  }
  // A macro a blanked group defines is still the file's: the compiler may read that group instead.
  for (const name of reading.dropped) macros.add(name);

  // A macro's arguments are tokens it may stringify, paste or drop (C11 6.10.3): what a call written
  // there becomes is the macro's to say, and the rules do not expand the file's `#define`.
  const inMacroArguments = (call: Node): boolean => {
    for (let a = call.parent; a !== null; a = a.parent) {
      if (a.type !== 'argument_list') continue;
      const callee = a.parent?.type === 'call_expression' ? a.parent.childForFieldName('function') : null;
      if (callee?.type === 'identifier' && macros.has(callee.text)) return true;
    }
    return false;
  };

  /** The one node of `entries` that is a definition the rules can link, compiled whenever the call is. */
  const oneDefinition = (entries: readonly NsEntry[], call: Node): number | null => {
    const defs = entries.filter((e) => e.kind === 'definition');
    if (defs.length !== 1 || entries.some((e) => e.kind === 'other')) return null;
    const def = defs[0]!;
    if (!def.provable || def.template || def.symbol === undefined || !compiledWith(def.node, call, reading.kept)) return null;
    return def.symbol;
  };

  // The rules that prove a call's target inside the file. Every other call is not known; the
  // language's tool, clangd, gives those.
  const markOf = (call: Node, name: Node, fn: FnInfo | null): CallMark => {
    if (fn === null || macros.has(name.text) || boundIn(fn.node).has(name.text) || inMacroArguments(call)) return {};
    const callee = call.type === 'call_expression' ? call.childForFieldName('function') : null;
    if (!cpp) {
      // C has one ordinary-identifier namespace in a file's scope and no overloading (C11 6.2.1,
      // 6.2.3): `f(…)` with no block declaring `f` calls the file's one definition of `f`.
      if (callee?.type !== 'identifier') return {};
      const target = oneDefinition(nsEntries.get(`\u0000${name.text}`) ?? [], call);
      return target === null ? {} : { target };
    }
    const cls = fn.cls;
    const plain = callee?.type === 'identifier';
    const onThis = callee?.type === 'field_expression' && callee.childForFieldName('argument')?.type === 'this' && callee.childForFieldName('field')?.type === 'field_identifier';
    if (fn.member && cls !== null && (plain || onThis)) {
      // In a member function, an unqualified name is looked up in the class before the namespaces
      // around it, and the class's own declaration of it hides a base's ([class.member.lookup],
      // [basic.lookup.unqual] p8). One member function of that name, with no using-declaration of it,
      // is the call's target.
      const decls = cls.functions.get(name.text) ?? [];
      if (decls.length === 1 && !cls.usings.has(name.text) && !cls.others.has(name.text) && compiledWith(decls[0]!, call, reading.kept)) {
        const decl = decls[0]!;
        const inBody = symbolByNode.get(decl.id);
        if (inBody !== undefined) return { target: inBody };
        const defs = outOfLine.get(`${cls.full}\u0000${name.text}`) ?? [];
        if (defs.length === 1 && compiledWith(defs[0]!.node, call, reading.kept)) return { target: defs[0]!.symbol };
        return {};
      }
      // The class's own name in its scope is the class (the injected-class-name, [class.pre] p2), and
      // a member class is named by its name there: a construction of it links to the class.
      if (plain && decls.length === 0 && !cls.usings.has(name.text)) {
        if (name.text === cls.own && !cls.others.has(name.text)) return { target: cls.symbol };
        const nested = cls.nested.get(name.text);
        if (nested?.length === 1 && compiledWith(nested[0]!.node, call, reading.kept)) return { target: nested[0]!.symbol };
      }
      return {};
    }
    if (call.type === 'new_expression') {
      if (!fn.member || cls === null || call.childForFieldName('type')?.type !== 'type_identifier') return {};
      if (cls.functions.has(name.text) || cls.usings.has(name.text)) return {};
      if (name.text === cls.own && !cls.others.has(name.text)) return { target: cls.symbol };
      const nested = cls.nested.get(name.text);
      if (nested?.length === 1 && compiledWith(nested[0]!.node, call, reading.kept)) return { target: nested[0]!.symbol };
      return {};
    }
    // Outside a class, `f()` with no arguments has no associated namespaces to search
    // ([basic.lookup.argdep] p2), so the name is looked up from its block out to its namespace
    // ([basic.lookup.unqual]). The file declaring `f` there before the call, and defining one
    // function `f` in that namespace and nothing else by that name, proves the call's target.
    if (!fn.member && plain && call.type === 'call_expression' && named(call.childForFieldName('arguments') ?? call).length === 0) {
      const entries = nsEntries.get(`${fn.ns}\u0000${name.text}`) ?? [];
      if (!entries.some((e) => e.node.startIndex < call.startIndex)) return {};
      const target = oneDefinition(entries, call);
      return target === null ? {} : { target };
    }
    return {};
  };

  for (const { call, name, hint, scope, fn } of pending) {
    const mark = markOf(call, name, fn);
    // No call is linked by its name alone: what the language's rules prove is its target.
    out.edge(scope, 'calls', calledText(name), startLine(name), hint, 'value', undefined, { pos: name.startIndex, ...mark });
  }
}

/** The text a call names: a destructor's name with its `~`. */
const calledText = (name: Node): string => (name.type === 'destructor_name' ? `~${name.text.replace(/^~\s*/, '')}` : name.text);

/** The last name of a type a `new` writes, `T` in `T`, `ns::T` and `T<A>`; null for a built-in type. */
function typeName(type: Node): Node | null {
  let t: Node | null = type;
  for (let i = 0; t && i < 8; i++) {
    if (t.type === 'type_identifier') return t;
    if (t.type === 'qualified_identifier' || t.type === 'template_type') t = t.childForFieldName('name');
    else return null;
  }
  return null;
}

/** The name a call names and the object it is called on: `f` in `f(x)`, `ns::f(x)`, `f<T>(x)` and `o.f(x)`; null for no name, a cast or a functional cast to a built-in type. */
function calleeOf(call: Node, cpp: boolean): { name: Node; hint: string | null } | null {
  let f = call.childForFieldName('function');
  let hint: string | null = null;
  if (f?.type === 'field_expression') {
    const object = f.childForFieldName('argument');
    hint = object ? memberHint(object.text) : null;
    f = f.childForFieldName('field');
  }
  for (let i = 0; f && i < 8; i++) {
    switch (f.type) {
      case 'identifier':
      case 'field_identifier':
        return cpp && CAST_KEYWORDS.has(f.text) ? null : { name: f, hint };
      case 'destructor_name':
        return { name: f, hint };
      case 'qualified_identifier':
      case 'template_function':
      case 'template_method':
        f = f.childForFieldName('name');
        break;
      case 'dependent_name':
        f = named(f)[0] ?? null;
        break;
      default:
        return null;
    }
  }
  return null;
}

/** The name of a call's callee as a lambda's label. */
function lambdaLabel(lambda: Node): string {
  const args = lambda.parent;
  const call = args?.type === 'argument_list' ? args.parent : null;
  const callee = call?.type === 'call_expression' ? calleeOf(call, true) : null;
  const created = call?.type === 'new_expression' ? typeName(call.childForFieldName('type') ?? call) : null;
  const name = callee?.name.text ?? created?.text;
  return name ? `callback of \`${name}\`` : `function at line ${startLine(lambda)}`;
}
