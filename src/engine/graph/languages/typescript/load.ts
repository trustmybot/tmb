// Loads the TypeScript compiler, way B's tool for TypeScript and JavaScript (CODE_GRAPH.md, "Two
// ways to make links"), from tmb's copy in its tools folder ("Where a language's tool comes from"):
// the folder the find order gives, which holds the compiler's package at tmb's pin. The compiler is
// loaded only when way B builds a graph, so no other command starts slower for it, and the tmb
// program holds none of it. Its default library, the declaration files of the language's built-ins
// that ship beside the compiler, is read from the same folder and served from memory (compiler.ts).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TypeScriptModule } from "./compiler.ts";

/** The folder of the compiler's package that holds its code and its default library, and its code's file there. */
const LIBRARY_DIR = "lib";
const COMPILER_FILE = "typescript.js";
/** How the compiler names its default library's files: `lib.<name>.d.ts`. */
const LIBRARY_PREFIX = "lib.";
const LIBRARY_SUFFIX = ".d.ts";

/** The files of its package a copy of the compiler must hold to be loaded, from its folder. */
export const COMPILER_HOLDS: readonly string[] = [`${LIBRARY_DIR}/${COMPILER_FILE}`, `${LIBRARY_DIR}/${LIBRARY_PREFIX}es5${LIBRARY_SUFFIX}`];

/**
 * Where the compiler believes it runs. It finds its default library beside its own file; the
 * library it is given (compiler.ts) is served at that folder, so no file there is read where the
 * compiler looks for it.
 */
const COMPILER_DIR = "/tmb-tools/typescript/lib";

/** Each default library file of a copy of the compiler, by its file name, with its text. */
export function compilerLibrary(folder: string): Map<string, string> {
  const dir = path.join(folder, LIBRARY_DIR);
  const library = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(LIBRARY_PREFIX) && name.endsWith(LIBRARY_SUFFIX)) library.set(name, readFileSync(path.join(dir, name), "utf8"));
  }
  return library;
}

/** Loads the copy of the compiler in a folder, with its default library; it throws when they cannot load. */
export function loadCompiler(folder: string): { ts: TypeScriptModule; library: ReadonlyMap<string, string> } {
  // The compiler's file is CommonJS: it is run as a module of its own, with the program's require.
  const source = readFileSync(path.join(folder, LIBRARY_DIR, COMPILER_FILE), "utf8");
  const module: { exports: unknown } = { exports: {} };
  new Function("module", "exports", "require", "__filename", "__dirname", source)(module, module.exports, require, path.join(COMPILER_DIR, COMPILER_FILE), COMPILER_DIR);
  return { ts: module.exports as TypeScriptModule, library: compilerLibrary(folder) };
}
