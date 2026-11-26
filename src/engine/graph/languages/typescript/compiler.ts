// The TypeScript compiler's program of a repo at one commit, with the compiler module given as an
// input: no fixed compiler is loaded here. The repo's own files are read from the commit, as the
// graph reads them, never from the working folder. The link check (links.ts) and way B
// (tool.ts) both read the commit through the host here, in the programs of projects.ts.
import path from "node:path";
import type TS from "typescript5";

/** A TypeScript compiler module: the one tmb carries (tool.ts), or the benchmark's reference (links.ts). */
export type TypeScriptModule = typeof TS;

/** The options of a program that reads every TypeScript and JavaScript file and emits nothing. */
export function baseOptions(ts: TypeScriptModule): TS.CompilerOptions {
  return {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  };
}

/** The folder a package manager installs a project's dependencies in. */
export const INSTALLED_DIR = "node_modules";

export type CommitFiles = {
  /** The repo's files at the commit, by path from its top. */
  texts: ReadonlyMap<string, string>;
  /** Whether the project's installed dependencies (a `node_modules` folder) are read from disk. */
  installed: boolean;
  /**
   * Any other file of the commit, by path from its top, read when asked for: a config that another
   * config names by `extends` or `references`, whatever its name.
   */
  read?: (rel: string) => string | undefined;
  /**
   * The compiler's default library files by name, when the program carries them: then they are
   * read from here, never from the compiler's folder on disk. Without it they are read from disk.
   */
  library?: ReadonlyMap<string, string>;
};

/** Where a file of the repo or of the disk is read: the commit, or the disk. */
type RepoPlace = { from: "commit"; rel: string } | { from: "disk" };
/** Where a file the compiler asks for is read: the commit, the disk, or the library carried. */
type Place = RepoPlace | { from: "library"; name: string };

function placeOf(root: string, file: string, installed: boolean): RepoPlace {
  const prefix = root + path.sep;
  if (file !== root && !file.startsWith(prefix)) return { from: "disk" };
  const rel = path.relative(root, file).split(path.sep).join("/");
  // A project's installed packages are not in git; they are read where the project installed them.
  if (installed && rel.split("/").includes(INSTALLED_DIR)) return { from: "disk" };
  return { from: "commit", rel };
}

/**
 * A compiler host that reads the repo's files from the commit; the compiler's default library from
 * `library` when it is carried, else from the compiler's folder; and from disk only what is outside
 * the repo or, with `installed`, the project's installed packages.
 */
export function commitHost(ts: TypeScriptModule, root: string, files: CommitFiles, options: TS.CompilerOptions): TS.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const dirs = new Set<string>();
  for (const file of files.texts.keys()) for (let d = path.posix.dirname(file); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
  // The folder the compiler looks in for its default library. With a carried library, each of its
  // files is read from what is carried; any other file there is read where it lives, as an
  // installed package's declarations beside the compiler's own are.
  const libraryDir = path.dirname(ts.getDefaultLibFilePath(options));
  const { library } = files;
  const at = (file: string): Place =>
    library !== undefined && path.dirname(file) === libraryDir && library.has(path.basename(file)) ? { from: "library", name: path.basename(file) } : placeOf(root, file, files.installed);
  const textOf = (p: Exclude<Place, { from: "disk" }>): string | undefined => (p.from === "library" ? library?.get(p.name) : files.texts.get(p.rel));
  const { getSourceFile } = host;
  return {
    ...host,
    getCurrentDirectory: () => root,
    fileExists: (file) => {
      const p = at(file);
      return p.from === "disk" ? ts.sys.fileExists(file) : textOf(p) !== undefined;
    },
    readFile: (file) => {
      const p = at(file);
      return p.from === "disk" ? ts.sys.readFile(file) : textOf(p);
    },
    directoryExists: (dir) => {
      if (library !== undefined && dir === libraryDir) return true;
      const p = at(dir);
      if (p.from === "disk") return ts.sys.directoryExists(dir);
      if (p.from === "library") return false;
      if (dir === root || dirs.has(p.rel)) return true;
      // The installed packages' folder, which git does not hold.
      return files.installed && path.basename(dir) === INSTALLED_DIR && ts.sys.directoryExists(dir);
    },
    getDirectories: (dir) => (at(dir).from === "disk" ? ts.sys.getDirectories(dir) : []),
    realpath: (file) => (at(file).from === "disk" && ts.sys.realpath !== undefined ? ts.sys.realpath(file) : file),
    getSourceFile: (file, version, onError) => {
      const p = at(file);
      if (p.from === "disk") return getSourceFile.call(host, file, version, onError);
      const text = textOf(p);
      return text === undefined ? undefined : ts.createSourceFile(file, text, version, true);
    },
  };
}

/** A program over the repo's files at the commit: `rootFiles` are its paths from the repo's top. */
export function commitProgram(ts: TypeScriptModule, root: string, rootFiles: Iterable<string>, files: CommitFiles, options: TS.CompilerOptions): TS.Program {
  return ts.createProgram(
    [...rootFiles].map((f) => path.join(root, f)),
    options,
    commitHost(ts, root, files, options),
  );
}

/** A call or a construction, as the compiler writes it: what the graph counts as a call. */
export const isCallNode = (ts: TypeScriptModule, node: TS.Node): node is TS.CallExpression | TS.NewExpression | TS.TaggedTemplateExpression =>
  ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node);

/** The name a call, a construction, a JSX element or a tagged template calls, when it is one. */
export function calleeOf(ts: TypeScriptModule, node: TS.Node): TS.Identifier | TS.PrivateIdentifier | null {
  const name = (expr: TS.Node): TS.Identifier | TS.PrivateIdentifier | null => {
    if (ts.isIdentifier(expr)) return expr;
    if (ts.isPropertyAccessExpression(expr)) return expr.name;
    if (ts.isParenthesizedExpression(expr)) return name(expr.expression);
    return null;
  };
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return name(node.expression);
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return name(node.tagName);
  if (ts.isTaggedTemplateExpression(node)) return name(node.tag);
  return null;
}

/** `import { a as b }`: the graph names a reference to `b` by the name `a` it is declared as. */
export function originalNames(ts: TypeScriptModule, sf: TS.SourceFile): Map<string, string> {
  const original = new Map<string, string>();
  for (const stmt of sf.statements) {
    const bindings = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined;
    if (bindings !== undefined && ts.isNamedImports(bindings)) for (const el of bindings.elements) if (el.propertyName !== undefined) original.set(el.name.text, el.propertyName.text);
  }
  return original;
}

/** A member that runs as a method: a method, a constructor, a getter or a setter. */
type MethodLike = TS.MethodDeclaration | TS.MethodSignature | TS.ConstructorDeclaration | TS.GetAccessorDeclaration | TS.SetAccessorDeclaration;
const isMethodLike = (ts: TypeScriptModule, m: TS.Node): m is MethodLike =>
  ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m);

const hasBody = (m: MethodLike): boolean => "body" in m && m.body !== undefined;

/** A member's name as written: its text, a computed name's string inside the brackets, a constructor's keyword. */
function memberName(ts: TypeScriptModule, m: MethodLike): string {
  if (ts.isConstructorDeclaration(m)) return "constructor";
  const name = m.name;
  if (ts.isComputedPropertyName(name)) return ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression) ? name.expression.text : name.getText();
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : name.getText();
}

/** How a member runs: a getter, a setter, or a method, a constructor being one by its name. */
const runsAs = (ts: TypeScriptModule, m: MethodLike): string => (ts.isGetAccessorDeclaration(m) ? "get" : ts.isSetAccessorDeclaration(m) ? "set" : "method");

/** The members of a named type that run as methods, each with its name and kind as one key. */
function listed(ts: TypeScriptModule, members: readonly TS.Node[]): { m: MethodLike; key: string }[] {
  return members.filter((m): m is MethodLike => isMethodLike(ts, m)).map((m) => ({ m, key: `${runsAs(ts, m)}\u0000${memberName(ts, m)}` }));
}

/**
 * The members of a type that has a name and lists its methods, whatever keyword declares it: a
 * class, an interface, or an alias written directly as an object type. Null for any other node.
 */
function namedTypeMembers(ts: TypeScriptModule, type: TS.Node): readonly TS.Node[] | null {
  if ((ts.isClassDeclaration(type) || ts.isInterfaceDeclaration(type)) && type.name !== undefined) return type.members;
  if (ts.isTypeLiteralNode(type) && ts.isTypeAliasDeclaration(type.parent) && type.parent.type === type) return type.members;
  return null;
}

/** The keys of the members the classes of an interface's name list in the interface's own scope, which it merges with. */
function mergedClassKeys(ts: TypeScriptModule, type: TS.Node): Set<string> {
  const keys = new Set<string>();
  if (!ts.isInterfaceDeclaration(type) || !("statements" in type.parent)) return keys;
  for (const stmt of (type.parent as TS.Node & { statements: TS.NodeArray<TS.Statement> }).statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === type.name.text) for (const { key } of listed(ts, stmt.members)) keys.add(key);
  }
  return keys;
}

/**
 * The methods of a type that have only a declaration (CODE_GRAPH.md, "A function with a
 * declaration and a definition is one node"; "Kinds of symbol"): in a type that has a name and
 * lists its methods (namedTypeMembers), each method, constructor, getter or setter with no body,
 * when the type's own body holds no member of that name and kind with a body, and, for an
 * interface, no class of its name in its scope lists that member: the class's is the one node. The
 * signatures of one name and kind in one body are one method, an overload set, first to last. A
 * signature beside a body of its name is an overload of that body, which is the node; a type with
 * no name holds no node.
 */
export function bodilessMethods(ts: TypeScriptModule, type: TS.Node): MethodLike[][] {
  const members = namedTypeMembers(ts, type);
  if (members === null) return [];
  const all = listed(ts, members);
  const taken = mergedClassKeys(ts, type);
  for (const { m, key } of all) if (hasBody(m)) taken.add(key);
  const sets = new Map<string, MethodLike[]>();
  for (const { m, key } of all) {
    if (hasBody(m) || taken.has(key)) continue;
    sets.set(key, [...(sets.get(key) ?? []), m]);
  }
  return [...sets.values()];
}

/** Whether a declaration is a method that has only a declaration, one of {@link bodilessMethods}. */
export function isBodilessMethod(ts: TypeScriptModule, d: TS.Node): boolean {
  return isMethodLike(ts, d) && !hasBody(d) && bodilessMethods(ts, d.parent).some((set) => set.includes(d));
}
