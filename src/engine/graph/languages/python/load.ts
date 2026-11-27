// Loads pyright, Python's way B tool (CODE_GRAPH.md, "Two ways to make links"), from tmb's copy in
// its tools folder ("Where a language's tool comes from"): the folder the find order gives, which
// holds pyright's package at tmb's pin. It is loaded only when way B builds a Python graph, so no
// other command starts slower for it, and the tmb program holds none of it.
//
// pyright's package is a command-line program, not a library: its entry file runs the command, and
// its parts are modules of a webpack bundle. loadPyright runs the entry file only until it asks for
// its first module, keeps the bundle's own loader, and asks that loader for the parts tool.ts uses,
// each by the name it exports.
//
// Of typeshed, which pyright ships beside its code, only the standard library's stubs are read:
// what pyright needs to know the language's built-ins. typeshed's stubs of third-party packages are
// not: a package call is answered from the package the repo installs, and with no environment it is
// not known (CODE_GRAPH.md, "Way B for Python reads the environment in the working tree"), never
// guessed to be outside from a stub of a package that is not there. The stubs are read from the
// copy's folder when it loads and served from memory (tool.ts).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The files of pyright's package it is run from: its entry file and the two chunks of its bundle, under `dist/`. */
const DIST = "dist";
const ENTRY = "pyright.js";
const CHUNK_FILES = ["vendor.js", "pyright-internal.js"] as const;
/** Where pyright's package keeps typeshed, and typeshed its standard library. */
const TYPESHED_DIR = `${DIST}/typeshed-fallback`;
const STDLIB_DIR = "stdlib";

/** The files of its package a copy of pyright must hold to be loaded, from its folder. */
export const PYRIGHT_HOLDS: readonly string[] = [`${DIST}/${ENTRY}`, ...CHUNK_FILES.map((f) => `${DIST}/${f}`), `${TYPESHED_DIR}/${STDLIB_DIR}/VERSIONS`];

/**
 * Where pyright believes it runs. It finds typeshed under its own folder; the stubs it is given
 * are served at that folder (tool.ts), so no file there is read where pyright looks for it.
 */
export const PYRIGHT_DIR = "/tmb-tools/pyright/dist";
/** Where pyright looks for typeshed, under its own folder: the stubs' paths are under it. */
export const TYPESHED_ROOT = `${PYRIGHT_DIR}/typeshed-fallback`;

/** A chunk of the bundle: its modules, each a function the bundle's loader calls with itself. */
type Chunk = { modules: Record<string, (this: unknown, module: unknown, exports: unknown, load: Loader) => void> };
type Loader = (id: string) => Record<string, unknown>;

/** Thrown to stop the entry file at its first module, once the loader is in hand. */
class LoaderFound extends Error {}

/** Runs a CommonJS file as a module of its own, with the given require, as if it were in pyright's folder. */
function runFile(file: string, require: (id: string) => unknown): Record<string, unknown> {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  new Function("module", "exports", "require", "__filename", "__dirname", readFileSync(file, "utf8"))(module, module.exports, require, path.join(PYRIGHT_DIR, path.basename(file)), PYRIGHT_DIR);
  return module.exports;
}

/** Each file of the standard library's stubs in a copy of pyright, by its path under typeshed's folder, with its text. */
export function pyrightStdlib(folder: string): Map<string, string> {
  const typeshed = path.join(folder, TYPESHED_DIR);
  const files = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(typeshed, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.set(child, readFileSync(path.join(typeshed, child), "utf8"));
    }
  };
  walk(STDLIB_DIR);
  return files;
}

/** The part of pyright that exports a name, by that name. */
export type Exporting = (name: string) => Record<string, any>;

/** Loads the copy of pyright in a folder, with its standard library's stubs; it throws when it cannot load. */
export function loadPyright(folder: string): { exporting: Exporting; stdlib: ReadonlyMap<string, string> } {
  const dist = path.join(folder, DIST);
  // pyright finds its own folder through this global, which its command line sets.
  (globalThis as { __rootDirectory?: string }).__rootDirectory = `${PYRIGHT_DIR}/`;
  let loader: Loader | undefined;
  const sources = new Map<string, string>();
  const chunks = new Map<string, Chunk>();
  for (const name of CHUNK_FILES) {
    const chunk = runFile(path.join(dist, name), require) as unknown as Chunk;
    for (const [id, run] of Object.entries(chunk.modules)) {
      sources.set(id, String(run));
      chunk.modules[id] = function (this: unknown, module, exports, load) {
        if (loader === undefined) {
          loader = load;
          throw new LoaderFound();
        }
        return run.call(this, module, exports, load);
      };
    }
    chunks.set(`./${name}`, chunk);
  }
  try {
    runFile(path.join(dist, ENTRY), (id) => chunks.get(id) ?? require(id));
  } catch (error) {
    if (!(error instanceof LoaderFound)) throw error;
  }
  const found = loader;
  if (found === undefined) throw new Error("pyright's module loader was not found");
  const byName = new Map<string, Record<string, any>>();
  const exporting: Exporting = (name) => {
    const known = byName.get(name);
    if (known !== undefined) return known;
    // A module that exports a name assigns it (`.name=`); of those, the one whose exports hold it.
    // A name two modules export is the same value in both, or it is no answer.
    const holders: Record<string, unknown>[] = [];
    for (const [id, source] of sources) {
      if (!source.includes(`.${name}=`)) continue;
      const exports = found(id);
      if (exports !== undefined && exports !== null && Object.prototype.hasOwnProperty.call(exports, name)) holders.push(exports);
    }
    if (holders.length === 0 || new Set(holders.map((h) => h[name])).size !== 1) throw new Error(`pyright exports ${name} from ${holders.length} modules`);
    byName.set(name, holders[0]!);
    return holders[0]!;
  };
  return { exporting, stdlib: pyrightStdlib(folder) };
}
