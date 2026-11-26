// Way B for Python (trustmybot/tmb#347): pyright makes the links of the graph's calls. It asks
// pyright; it does not imitate it. For each call the built-in parser found, pyright's definition
// provider names the callee's declarations, all the questions asked of one program, and the call is:
// - linked, when they are exactly one node of the graph: a declaration in the repo that is a node
//   by "Kinds of symbol", in the same file, of the same name, its lines overlapping the node's;
// - outside, when every declaration is outside the repo: the standard library's stubs, or a package
//   the repo's environment installs;
// - not known, otherwise: no answer, a declaration that is no node (a parameter, a local, a
//   function or a class inside another), more than one node, or an answer for another call than the
//   one asked, such as a callee that is no name.
// No answer is ever replaced by a guess, and none is corrected (CODE_GRAPH.md, "The tool's answer
// stands"). Two rules of the page read the tool's own answer: a function's `@overload` stubs are
// one function, the one definition that runs, so a stub matches no node by place, unless no
// definition follows the stubs and they are one node together; and a construction links to the
// class, which is what pyright names.
//
// tmb carries pyright (carried.ts), loaded only when way B builds a Python graph, and never runs
// the user's Python. pyright reads the repo's files from the commit, the standard library's stubs
// tmb carries from memory, and the repo's own virtual environment from disk, with the project's
// config (CODE_GRAPH.md, "Way B for Python reads the environment in the working tree"). The
// environment is the one the project's config names, pyright's own `venvPath` and `venv`, else the
// one folder at the top of the working tree that is one; two or more with no config naming one
// are none, and so is a folder the config names that is not there; the answer's freshness says so. With no environment, a call into a package is not
// known.
import { type Dirent, existsSync, readdirSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import { type Exporting, loadCarried, PYRIGHT_DIR, TYPESHED_ROOT } from "./carried.ts";
import type { LanguageTool, OpenedTool, ToolAnswer, ToolCall, ToolInput, ToolNode } from "../contract.ts";

const NOT_KNOWN: ToolAnswer = { state: "not_known" };
const OUTSIDE: ToolAnswer = { state: "outside" };

/**
 * A Python virtual environment is a folder that holds this file (PEP 405), which every tool that
 * makes one writes. The repo's own is such a folder at the top of its working tree.
 */
const ENVIRONMENT_MARK = "pyvenv.cfg";

/** The files of the commit pyright reads besides the `.py` files: the language's stubs and pyright's settings. */
const STUB_EXTENSION = ".pyi";
const SETTINGS_FILES = new Set(["pyproject.toml", "pyrightconfig.json"]);

/**
 * The kinds of pyright's syntax tree that place a declaration and a call, as pyright 1.1.414, the
 * version tmb carries, numbers them (`ParseNodeType`, which its bundle does not export by name).
 * A test reads them back off a tree pyright parses.
 */
export const NODE = { Call: 9, Class: 10, Comprehension: 11, ImportFromAs: 26, Function: 31, Lambda: 33, MemberAccess: 35, Module: 36, Name: 38 } as const;

/** A node of pyright's syntax tree, as far as tool.ts reads it. */
type ParseNode = { nodeType: number; start: number; length: number; parent?: ParseNode; d: Record<string, any> };
type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Uri = { getFilePath(): string; isEmpty(): boolean };

/** The parts of pyright tool.ts uses, loaded on first use: way B alone needs them. */
type Pyright = { part: Exporting; stdlib: ReadonlyMap<string, string> };
let carried: Pyright | undefined;

/** The pyright tmb carries, or why it cannot be loaded. */
async function carriedPyright(): Promise<Pyright | { unavailable: string }> {
  if (carried !== undefined) return carried;
  try {
    const { exporting, stdlib } = loadCarried();
    // pyright loads its reader of `pyproject.toml` on its own, and reads no config before it has.
    await exporting("ensureTomlModuleLoaded").ensureTomlModuleLoaded();
    carried = { part: exporting, stdlib };
    return carried;
  } catch (error) {
    return { unavailable: `the pyright tmb carries did not load (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The folders at the top of the repo's working tree that are virtual environments, by name. */
function topEnvironments(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, ENVIRONMENT_MARK)))
    .map((e) => e.name)
    .sort();
}

/**
 * A file or a folder of a place served from memory: the commit, or the stubs tmb carries. `addDir`
 * lists a folder served from elsewhere in the folders above it, so pyright, which looks for a
 * folder in its parent's list, finds it.
 */
type Served = { files: ReadonlyMap<string, string>; dirs: ReadonlyMap<string, Set<string>>; addDir(rel: string): void };

function served(files: ReadonlyMap<string, string>): Served {
  const dirs = new Map<string, Set<string>>([["", new Set()]]);
  // Each folder holding a path, up to the top, with that path's name in it.
  const add = (rel: string): void => {
    const dir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    let names = dirs.get(dir);
    if (names === undefined) {
      names = new Set();
      dirs.set(dir, names);
      add(dir);
    }
    names.add(path.posix.basename(rel));
  };
  for (const file of files.keys()) add(file);
  const addDir = (rel: string): void => {
    if (!dirs.has(rel)) dirs.set(rel, new Set());
    add(rel);
  };
  return { files, dirs, addDir };
}

/** No place: a folder pyright believes it runs in, whose files it is never given. */
const NOWHERE: Served = { files: new Map(), dirs: new Map(), addDir: () => {} };

/** Whether a folder is on disk. */
function isFolder(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path is a folder or inside it. */
const within = (dir: string, file: string): boolean => file === dir || file.startsWith(`${dir}${path.sep}`);

const notFound = (file: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, '${file}'`), { code: "ENOENT" });

const statOf = (isFile: boolean, size: number): Stats =>
  ({
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size,
    mtimeMs: 0,
    ctimeMs: 0,
    mtime: new Date(0),
    ctime: new Date(0),
  }) as unknown as Stats;

const entryOf = (name: string, isFile: boolean): Dirent => ({ name, isFile: () => isFile, isDirectory: () => !isFile, isSymbolicLink: () => false }) as unknown as Dirent;

/**
 * pyright's file system for one commit: the repo's files from the commit, the stubs tmb carries
 * from memory, and everything else, the environment pyright is set up with included, from disk.
 * `environment()` is that environment's folder, an absolute path, or null for none.
 */
function commitFileSystem(real: Record<string, any>, root: string, commit: Served, environment: () => string | null, stdlib: Served): Record<string, any> {
  const placeOf = (uri: Uri): { place: Served; rel: string } | null => {
    const file = uri.getFilePath();
    if (file === TYPESHED_ROOT || file.startsWith(`${TYPESHED_ROOT}/`)) return { place: stdlib, rel: path.posix.relative(TYPESHED_ROOT, file) };
    if (file === PYRIGHT_DIR || file.startsWith(`${PYRIGHT_DIR}/`)) return { place: NOWHERE, rel: "" };
    const envDir = environment();
    if (envDir !== null && within(envDir, file)) return null;
    if (within(root, file)) return { place: commit, rel: path.relative(root, file).split(path.sep).join("/") };
    return null;
  };
  const text = (uri: Uri): string => {
    const at = placeOf(uri)!;
    const found = at.place.files.get(at.rel);
    if (found === undefined) throw notFound(uri.getFilePath());
    return found;
  };
  const own: Record<string, (...args: any[]) => unknown> = {
    existsSync: (uri: Uri) => {
      const at = placeOf(uri);
      return at === null ? real.existsSync(uri) : at.place.files.has(at.rel) || at.place.dirs.has(at.rel);
    },
    statSync: (uri: Uri) => {
      const at = placeOf(uri);
      if (at === null) return real.statSync(uri);
      const file = at.place.files.get(at.rel);
      if (file !== undefined) return statOf(true, file.length);
      if (at.place.dirs.has(at.rel)) return statOf(false, 0);
      throw notFound(uri.getFilePath());
    },
    readdirEntriesSync: (uri: Uri) => {
      const at = placeOf(uri);
      if (at === null) return real.readdirEntriesSync(uri);
      const names = at.place.dirs.get(at.rel);
      if (names === undefined) throw notFound(uri.getFilePath());
      return [...names].sort().map((name) => entryOf(name, at.place.files.has(at.rel === "" ? name : `${at.rel}/${name}`)));
    },
    readdirSync: (uri: Uri) => (own.readdirEntriesSync!(uri) as Dirent[]).map((e) => e.name),
    readFileSync: (uri: Uri, encoding?: BufferEncoding | null) => {
      if (placeOf(uri) === null) return real.readFileSync(uri, encoding);
      const found = text(uri);
      return encoding ? found : Buffer.from(found, "utf8");
    },
    readFile: async (uri: Uri) => (placeOf(uri) === null ? real.readFile(uri) : Buffer.from(text(uri), "utf8")),
    readFileText: async (uri: Uri, encoding?: BufferEncoding) => (placeOf(uri) === null ? real.readFileText(uri, encoding) : text(uri)),
    realpathSync: (uri: Uri) => (placeOf(uri) === null ? real.realpathSync(uri) : uri),
    realCasePath: (uri: Uri) => (placeOf(uri) === null ? real.realCasePath(uri) : uri),
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(own, prop)) return own[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** pyright's answers for the graph's calls, one per call, in order. */
function answerCalls({ part, stdlib: stdlibFiles }: Pyright, repoDir: string, input: ToolInput, note: (text: string) => void): ToolAnswer[] {
  const root = path.resolve(repoDir);
  // Which environment (CODE_GRAPH.md): the one the project's config names, else the one folder at
  // the top of the repo that is one; two or more with no config naming one are none.
  const tops = topEnvironments(root);
  const onlyTop = tops.length === 1 ? tops[0]! : null;
  const { DefinitionProvider, DefinitionFilter } = part("DefinitionProvider");
  const { AnalyzerService } = part("AnalyzerService");
  const { CommandLineOptions } = part("CommandLineOptions");
  const { ConfigOptions } = part("ConfigOptions");
  const { createServiceProvider } = part("createServiceProvider");
  const { PyrightFileSystem } = part("PyrightFileSystem");
  const { createFromRealFileSystem, RealTempFile } = part("createFromRealFileSystem");
  const { NoAccessHost } = part("NoAccessHost");
  const { NullConsole } = part("NullConsole");
  const { Uri } = part("Uri");
  const { CancellationToken } = part("CancellationToken");
  const { convertOffsetToPosition, convertPositionToOffset } = part("convertOffsetToPosition");
  const { CacheManager } = part("CacheManager");
  const { findNodeByOffset } = part("findNodeByOffset");

  const console = new NullConsole();
  const tempFile = new RealTempFile();
  // The repo's files and its settings, each from the commit.
  const commit = served(new Map([...input.configs, ...input.files]));
  // The environment pyright is set up with, known once it has read the project's config.
  let environment: string | null = null;
  const fs = new PyrightFileSystem(commitFileSystem(createFromRealFileSystem(tempFile, console), root, commit, () => environment, served(stdlibFiles)));
  // pyright measures its memory to drop what it has read when the heap runs high; the measure is
  // slow under Bun, and one program over one commit is read once, so it is not taken.
  const cacheManager = new CacheManager();
  cacheManager.pauseTracking();
  const services = createServiceProvider(fs, console, tempFile, cacheManager);
  const rootUri = Uri.file(root, services);
  // The environment when the project's config names none: pyright takes the config's `venv` and
  // `venvPath` first, and these only where the config gives none. It is a folder of the repo, so
  // its path is the repo's.
  const configOptions = new ConfigOptions(rootUri);
  if (onlyTop !== null) configOptions.venv = onlyTop;
  const service = new AnalyzerService("tmb", services, {
    console,
    // pyright asks its host to run Python for the interpreter's paths; this host never runs it.
    hostFactory: () => new NoAccessHost(),
    configOptions,
    skipScanningUserFiles: true,
    shouldRunAnalysis: () => false,
  });
  try {
    const options = new CommandLineOptions(root, false);
    // Where the language server looks for a `src` layout, it looks here too.
    options.configSettings.autoSearchPaths = true;
    if (onlyTop !== null) options.languageServerSettings.venvPath = root;
    service.setOptions(options);
    // The environment pyright is now set up with is served from disk, before it reads any import.
    // A folder that holds the repo itself is none: the repo's files are the commit's.
    const settled = service.getConfigOptions() as { venvPath?: Uri & { resolvePaths(p: string): Uri }; venv?: string };
    const set = settled.venvPath !== undefined && settled.venv !== undefined ? settled.venvPath.resolvePaths(settled.venv).getFilePath() : null;
    // A folder the config names that is not there is no environment, and the freshness says so.
    const missing = set !== null && !within(set, root) && !isFolder(set);
    environment = set === null || within(set, root) || missing ? null : set;
    if (missing) note(`the environment the project's config names (${within(root, set) ? path.relative(root, set).split(path.sep).join("/") : set}) is not there, so none is read: a call into a package is not known`);
    else if (environment === null && tops.length > 1) note(`${tops.length} virtual environments at the top of the repo (${tops.join(", ")}) and no config naming one, so none is read: a call into a package is not known`);
    // An environment inside the repo is listed in its folder, and its files are not the repo's.
    const envRel = environment !== null && within(root, environment) ? path.relative(root, environment).split(path.sep).join("/") : null;
    if (envRel !== null) commit.addDir(envRel);
    // pyright looked for the environment as it read its settings, before it was served, and keeps
    // what it saw; its settings read again, it finds the environment's packages.
    if (environment !== null) service.setOptions(options);
    const program = service.backgroundAnalysisProgram.program;
    const uriOf = (file: string): Uri => Uri.file(path.join(root, file), services);
    // Each file is opened, as an editor opens it: pyright keeps an open file's tokens, which each
    // question reads, where it would read a closed file anew for each.
    for (const [file, text] of input.files) program.setFileOpened(uriOf(file), 1, text);

    const rel = (uri: Uri): string => path.relative(root, uri.getFilePath()).split(path.sep).join("/");
    const envPrefix = envRel === null ? null : `${envRel}/`;
    /** A declaration's file is the repo's when the commit holds it; the environment's are not. */
    const inRepo = (uri: Uri): boolean => {
      const file = rel(uri);
      return commit.files.has(file) && (envPrefix === null || !file.startsWith(envPrefix));
    };

    const nodesByFile = new Map<string, { index: number; node: ToolNode }[]>();
    input.nodes.forEach((node, index) => {
      const here = nodesByFile.get(node.path) ?? [];
      here.push({ index, node });
      nodesByFile.set(node.path, here);
    });

    const lineAt = (offset: number, lines: unknown): number => convertOffsetToPosition(offset, lines).line + 1;

    /** Whether nothing between a node and its file's top makes a scope of its own: the name is the file's. */
    const fileLevel = (node: ParseNode): boolean => {
      for (let n = node.parent; n !== undefined; n = n.parent) {
        if (n.nodeType === NODE.Function || n.nodeType === NODE.Class || n.nodeType === NODE.Lambda || n.nodeType === NODE.Comprehension) return false;
        if (n.nodeType === NODE.Module) return true;
      }
      return false;
    };

    /**
     * The node a declaration in the repo is, by "Kinds of symbol": a class or a function at the top
     * of its file, a method of such a class, or file-level data. A function or a class inside
     * another has no node yet (trustmybot/tmb#141). Matched by place, so an `@overload` stub
     * matches the node of its stubs when no definition follows them, and else none, since the
     * definition that runs is the node: of its name, in its file, its lines overlapping the node's; of
     * several, the one that starts where the declaration or its name does, when only one does.
     */
    const nodesOf = (uri: Uri, range: Range): number[] => {
      const file = rel(uri);
      if (!input.files.has(file)) return [];
      const parsed = program.getParseResults(uri);
      if (parsed === undefined) return [];
      const lines = parsed.tokenizerOutput.lines;
      const offset = convertPositionToOffset(range.start, lines);
      if (offset === undefined) return [];
      const name = findNodeByOffset(parsed.parserOutput.parseTree, offset) as ParseNode | undefined;
      if (name === undefined || name.nodeType !== NODE.Name || name.start !== offset) return [];
      const owner = name.parent;
      let declared: ParseNode;
      if (owner !== undefined && (owner.nodeType === NODE.Function || owner.nodeType === NODE.Class) && owner.d.name === name) {
        const around = owner.parent;
        let scope: ParseNode | undefined;
        for (scope = around; scope !== undefined; scope = scope.parent) if (scope.nodeType === NODE.Function || scope.nodeType === NODE.Class || scope.nodeType === NODE.Lambda) break;
        const top = scope === undefined;
        const methodOfTopClass = scope !== undefined && owner.nodeType === NODE.Function && scope.nodeType === NODE.Class && fileLevel(scope);
        if (!top && !methodOfTopClass) return [];
        declared = owner;
      } else if (fileLevel(name)) {
        declared = name;
      } else {
        return [];
      }
      const start = lineAt(declared.start, lines);
      const end = lineAt(declared.start + declared.length, lines);
      const named = name.d.value as string;
      const overlapping = (nodesByFile.get(file) ?? []).filter(({ node }) => node.name === named && node.start <= end && node.end >= start);
      if (overlapping.length <= 1) return overlapping.map(({ index }) => index);
      const starts = new Set([start, lineAt(name.start, lines)]);
      const starting = overlapping.filter(({ node }) => starts.has(node.start));
      return (starting.length === 1 ? starting : overlapping).map(({ index }) => index);
    };

    const answerAt = (uri: Uri, position: Position): ToolAnswer => {
      const found = new DefinitionProvider(program, uri, position, DefinitionFilter.All, CancellationToken.None).getDefinitions() as { uri: Uri; range: Range }[] | undefined;
      const decls = (found ?? []).filter((d) => !d.uri.isEmpty());
      if (decls.length === 0) return NOT_KNOWN;
      const own = decls.filter((d) => inRepo(d.uri));
      if (own.length === 0) return OUTSIDE;
      const nodes = new Set(own.flatMap((d) => nodesOf(d.uri, d.range)));
      return nodes.size === 1 ? { nodes: [[...nodes][0]!] } : NOT_KNOWN;
    };

    /**
     * The names a call written at a name may be recorded by: that name, and the name an import
     * under a new name brings in under it (`from m import f as g`; `g()` calls `f`).
     */
    const originals = new Map<string, Map<string, string>>();
    const originalsOf = (file: string, tree: ParseNode): Map<string, string> => {
      const known = originals.get(file);
      if (known !== undefined) return known;
      const out = new Map<string, string>();
      const visit = (n: ParseNode): void => {
        if (n.nodeType === NODE.ImportFromAs && n.d.alias !== undefined) out.set(n.d.alias.d.value, n.d.name.d.value);
        for (const value of Object.values(n.d ?? {})) {
          for (const child of Array.isArray(value) ? value : [value]) if (child !== null && typeof child === "object" && typeof child.nodeType === "number" && child.parent === n) visit(child);
        }
      };
      visit(tree);
      originals.set(file, out);
      return out;
    };

    /**
     * pyright's answer for one call. It names what is written at a position; it answers for the
     * call asked only when a name is written there and that name is what the call calls, alone or
     * after a dot. Another call there, one whose callee is no name such as `f()()` or `h[k]()`, is
     * not the one it answers for: that is not known.
     */
    const answerOf = (call: ToolCall): ToolAnswer => {
      const uri = uriOf(call.path);
      const parsed = program.getParseResults(uri);
      if (parsed === undefined) return NOT_KNOWN;
      const name = findNodeByOffset(parsed.parserOutput.parseTree, call.pos) as ParseNode | undefined;
      if (name === undefined || name.nodeType !== NODE.Name || name.start !== call.pos) return NOT_KNOWN;
      const written = name.d.value as string;
      if (call.name !== written && originalsOf(call.path, parsed.parserOutput.parseTree).get(written) !== call.name) return NOT_KNOWN;
      const parent = name.parent;
      const callee =
        parent?.nodeType === NODE.Call && parent.d.leftExpr === name
          ? name
          : parent?.nodeType === NODE.MemberAccess && parent.d.member === name && parent.parent?.nodeType === NODE.Call && parent.parent.d.leftExpr === parent
            ? parent
            : null;
      if (callee === null) return NOT_KNOWN;
      return answerAt(uri, convertOffsetToPosition(call.pos, parsed.tokenizerOutput.lines));
    };

    return input.calls.map(answerOf);
  } finally {
    service.dispose();
  }
}

/** pyright, way B's tool for Python. */
export const pyright: LanguageTool = {
  name: "pyright",
  reads: (file: string) => file.endsWith(STUB_EXTENSION) || SETTINGS_FILES.has(path.posix.basename(file)),
  async open(repoDir: string): Promise<OpenedTool> {
    const loaded = await carriedPyright();
    if ("unavailable" in loaded) return loaded;
    return { answer: (input: ToolInput, note: (text: string) => void) => answerCalls(loaded, repoDir, input, note) };
  },
};
