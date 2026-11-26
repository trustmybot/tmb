// The project that owns each file, and its program (trustmybot/tmb#324; CODE_GRAPH.md, "Two ways
// to make links": way B follows the project's own configs). A file is resolved under the config
// that owns it, found as the TypeScript compiler's language service finds the project of a file it
// opens (tsserver's default configured project):
// - the nearest folder above the file, up to the repo's top, with a `tsconfig.json`, else a
//   `jsconfig.json`, names the first config tried;
// - a config owns the file when its `files`, `include` and `exclude` take the file in, and no
//   project it references takes it in too, for there the file is that project's source;
// - else a project the config references (`references`), the direct ones first and then theirs,
//   that takes the file in;
// - else, unless the config sets `disableSolutionSearching`, the next config above the config's own
//   folder, tried the same way (TypeScript 5.6, "Search Ancestor Configuration Files for Project
//   Ownership");
// - else no config owns it, and the file is compiled with the compiler's defaults, as the language
//   service's inferred project compiles it: `getDefaultCompilerOptions`, with JavaScript allowed.
// Every config is read and matched by the compiler itself (`getParsedCommandLineOfConfigFile`,
// with its `extends`), never by rules written here.
//
// One program per config that owns a file with calls, and one for the files no config owns. A
// program reads its referenced projects from their source, each of their files resolved under its
// own project's settings, as the language service does ("Build-Free Editing with Project
// References", TypeScript 3.7). The programs share the files they parse through the compiler's
// document registry, which hands one parse to every program whose settings parse and bind a file
// alike; each program's checker answers only for the files its config owns.
import path from "node:path";
import type TS from "typescript5";
import { type CommitFiles, commitHost, INSTALLED_DIR, type TypeScriptModule } from "./compiler.ts";

/** The names of a folder's own config, in the order the compiler's language service looks for them. */
const FOLDER_CONFIGS = ["tsconfig.json", "jsconfig.json"] as const;
/** A config of this name has a folder's other config, a jsconfig.json, beside it to try above it. */
const TS_FOLDER_CONFIG = FOLDER_CONFIGS[0];

/** The version the programs' files are read at: one commit, read once. */
const COMMIT_VERSION = "commit";

/**
 * The compiler's own matching of a config's `include` and `exclude` against a folder tree
 * (`ts.matchFiles`, what `ts.sys.readDirectory` runs on disk). It is not in the compiler's typed
 * surface, so its presence is checked when the programs are made.
 */
type MatchFiles = (
  dir: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  entries: (dir: string) => { files: readonly string[]; directories: readonly string[] },
  realpath: (file: string) => string,
) => string[];

/** A host as the language service gives a program: referenced projects read from their source. */
type ProjectHost = TS.CompilerHost & { useSourceOfProjectReferenceRedirect(): boolean };

/** The programs of a repo at a commit: the one each file is resolved in. */
export type Projects = {
  /** The program of the project that owns `file`, a path from the repo's top. */
  programOf(file: string): TS.Program;
};

/**
 * The projects of the repo at the commit, for the files `owned`: each file's owning config found as
 * the compiler finds it, and one program per owner, made when first asked for.
 */
export function projectsOf(ts: TypeScriptModule, root: string, files: CommitFiles, owned: Iterable<string>): Projects {
  const matchFiles = (ts as unknown as { matchFiles?: MatchFiles }).matchFiles;
  if (typeof matchFiles !== "function") throw new Error("the compiler tmb carries has no matchFiles to read a config's include");
  const reader = commitHost(ts, root, files, {});

  // The commit's folders, each with the names of its files and folders, as the compiler reads a
  // folder on disk.
  const tree = new Map<string, { files: string[]; directories: Set<string> }>();
  const folder = (dir: string) => {
    let here = tree.get(dir);
    if (here === undefined) {
      here = { files: [], directories: new Set() };
      tree.set(dir, here);
    }
    return here;
  };
  for (const file of files.texts.keys()) {
    const abs = path.join(root, file);
    folder(path.dirname(abs)).files.push(path.basename(abs));
    for (let d = path.dirname(abs); d !== root && d.startsWith(root + path.sep); d = path.dirname(d)) folder(path.dirname(d)).directories.add(path.basename(d));
  }
  const entries = (dir: string) => {
    const here = tree.get(path.resolve(dir));
    return { files: here?.files ?? [], directories: [...(here?.directories ?? [])] };
  };

  // A config reads any file of the commit it names by `extends` or `references`, whatever its name,
  // as the compiler reads it on disk.
  const named = (file: string): string | undefined => {
    const rel = path.relative(root, path.resolve(file));
    return rel.startsWith("..") || path.isAbsolute(rel) ? undefined : files.read?.(rel.split(path.sep).join("/"));
  };
  const readConfig = (file: string): string | undefined => reader.readFile(file) ?? named(file);
  const configHost: TS.ParseConfigFileHost = {
    useCaseSensitiveFileNames: true,
    getCurrentDirectory: () => root,
    fileExists: (file) => reader.fileExists(file) || named(file) !== undefined,
    readFile: readConfig,
    readDirectory: (dir, extensions, excludes, includes, depth) => matchFiles(dir, extensions, excludes, includes, true, root, depth, entries, (file) => file),
    // A config that cannot be read owns no file.
    onUnRecoverableConfigFileDiagnostic: () => {},
  };
  const extendedConfigCache = new Map<string, TS.ExtendedConfigCacheEntry>();
  const parsed = new Map<string, TS.ParsedCommandLine | null>();
  const parsedConfig = (config: string): TS.ParsedCommandLine | null => {
    const known = parsed.get(config);
    if (known !== undefined) return known;
    const read = configHost.fileExists(config) ? (ts.getParsedCommandLineOfConfigFile(config, undefined, configHost, extendedConfigCache) ?? null) : null;
    parsed.set(config, read);
    return read;
  };
  const referencesOf = (config: string): string[] => (parsedConfig(config)?.projectReferences ?? []).map((ref) => path.resolve(ts.resolveProjectReferencePath(ref)));

  // The files a config takes in, and those its referenced projects take in, at any depth.
  const takenIn = new Map<string, Set<string>>();
  const filesOf = (config: string): Set<string> => {
    let known = takenIn.get(config);
    if (known === undefined) {
      known = new Set((parsedConfig(config)?.fileNames ?? []).map((f) => path.resolve(f)));
      takenIn.set(config, known);
    }
    return known;
  };
  const referenced = new Map<string, Set<string>>();
  const referencedFilesOf = (config: string): Set<string> => {
    let known = referenced.get(config);
    if (known !== undefined) return known;
    known = new Set();
    referenced.set(config, known);
    const seen = new Set([config]);
    const queue = referencesOf(config);
    while (queue.length > 0) {
      const ref = queue.shift()!;
      if (seen.has(ref)) continue;
      seen.add(ref);
      for (const f of filesOf(ref)) known.add(f);
      queue.push(...referencesOf(ref));
    }
    return known;
  };
  const owns = (config: string, file: string): boolean => filesOf(config).has(file) && !referencedFilesOf(config).has(file);

  /** The first config in `dir` or a folder above it, up to the repo's top; in `dir`, only `names`. */
  const configFrom = (dir: string, names: readonly string[]): string | null => {
    for (let d = dir, here = names; ; d = path.dirname(d), here = FOLDER_CONFIGS) {
      for (const name of here) if (reader.fileExists(path.join(d, name))) return path.join(d, name);
      if (d === root || !d.startsWith(root + path.sep) || path.basename(d) === INSTALLED_DIR) return null;
    }
  };

  /** A config that owns the file: this one, else one it references, the direct ones first. */
  const ownerUnder = (config: string, file: string, seen: Set<string>): string | null => {
    if (!seen.has(config)) {
      seen.add(config);
      if (owns(config, file)) return config;
    }
    let level = [config];
    while (level.length > 0) {
      const next: string[] = [];
      for (const parent of level) {
        for (const ref of referencesOf(parent)) {
          if (seen.has(ref)) continue;
          seen.add(ref);
          if (owns(ref, file)) return ref;
          next.push(ref);
        }
      }
      level = next;
    }
    return null;
  };

  /** The config that owns a file, by its path from the repo's top; null when none does. */
  const ownerOf = (rel: string): string | null => {
    const file = path.join(root, rel);
    const seen = new Set<string>();
    for (let config = configFrom(path.dirname(file), FOLDER_CONFIGS); config !== null; ) {
      const found = ownerUnder(config, file, seen);
      if (found !== null) return found;
      if (parsedConfig(config)?.options.disableSolutionSearching === true) return null;
      config = configFrom(path.dirname(config), path.basename(config).endsWith(TS_FOLDER_CONFIG) ? FOLDER_CONFIGS.slice(1) : []);
    }
    return null;
  };

  const owners = new Map<string, string | null>();
  const unowned: string[] = [];
  for (const rel of owned) {
    const owner = ownerOf(rel);
    owners.set(rel, owner);
    if (owner === null) unowned.push(path.join(root, rel));
  }

  const registry = ts.createDocumentRegistry(true, root);
  const programs = new Map<string | null, TS.Program>();
  const programFor = (config: string | null): TS.Program => {
    const known = programs.get(config);
    if (known !== undefined) return known;
    const project = config === null ? null : parsedConfig(config);
    const options: TS.CompilerOptions = project?.options ?? { ...ts.getDefaultCompilerOptions(), allowJs: true };
    const base = commitHost(ts, root, files, options);
    const host: ProjectHost = {
      ...base,
      useSourceOfProjectReferenceRedirect: () => true,
      getParsedCommandLine: (file) => parsedConfig(path.resolve(file)) ?? undefined,
      getSourceFile: (file, languageVersionOrOptions) => {
        const text = base.readFile(file);
        return text === undefined ? undefined : registry.acquireDocument(file, options, ts.ScriptSnapshot.fromString(text), COMMIT_VERSION, undefined, languageVersionOrOptions);
      },
    };
    const program = ts.createProgram({ rootNames: project?.fileNames ?? unowned, options, projectReferences: project?.projectReferences, host });
    programs.set(config, program);
    return program;
  };

  return {
    programOf: (file) => {
      const owner = owners.get(file);
      if (owner === undefined) throw new Error(`${file} was not given to the projects`);
      return programFor(owner);
    },
  };
}
