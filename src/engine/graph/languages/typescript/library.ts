// The TypeScript compiler's default library, the declaration files of the language's built-ins
// (`lib.es5.d.ts`, `lib.dom.d.ts`, …), which ship beside the compiler in its package's `lib`
// folder. Way B (tool.ts) imports this as a Bun macro, `with { type: "macro" }`: it runs when tmb
// is built, so the program carries the files' text, and a compiled tmb needs no compiler on disk.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The compiler tmb carries, as a package name: the one tool.ts loads. */
const CARRIED_PACKAGE = "typescript5";
/** The folder of the compiler's package that holds its default library. */
const LIBRARY_DIR = "lib";
/** How the compiler names its default library's files: `lib.<name>.d.ts`. */
const LIBRARY_PREFIX = "lib.";
const LIBRARY_SUFFIX = ".d.ts";

/** Each default library file of the carried compiler, by its file name, with its text. */
export function compilerLibrary(): Record<string, string> {
  const dir = path.join(path.dirname(Bun.resolveSync(`${CARRIED_PACKAGE}/package.json`, import.meta.dir)), LIBRARY_DIR);
  const library: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(LIBRARY_PREFIX) && name.endsWith(LIBRARY_SUFFIX)) library[name] = readFileSync(path.join(dir, name), "utf8");
  }
  return library;
}
