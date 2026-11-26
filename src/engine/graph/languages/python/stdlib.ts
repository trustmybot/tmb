// The stubs of Python's standard library that pyright ships in its package, typeshed's `stdlib`
// folder: what pyright needs to know the language's built-ins. carried.ts imports this as a Bun
// macro, `with { type: "macro" }`: it runs when tmb is built, so the program carries the files'
// text, packed, and a compiled tmb needs no pyright on disk.
//
// Only the standard library is carried. typeshed's stubs of third-party packages, which pyright
// ships beside it, are not: a package call is answered from the package the repo installs, and
// with no environment it is not known (CODE_GRAPH.md, "Way B for Python reads the environment in
// the working tree"), never guessed to be outside from a stub of a package that is not there.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The tool tmb carries, as a package name: the one carried.ts carries. */
const CARRIED_PACKAGE = "pyright";
/** Where pyright's package keeps typeshed, and typeshed its standard library. */
const TYPESHED_DIR = "dist/typeshed-fallback";
const STDLIB_DIR = "stdlib";

/** Each file of the carried standard library, by its path under typeshed's folder, with its text. */
export function pyrightStdlib(): Record<string, string> {
  const typeshed = path.join(path.dirname(Bun.resolveSync(`${CARRIED_PACKAGE}/package.json`, import.meta.dir)), TYPESHED_DIR);
  const files: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(typeshed, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files[child] = readFileSync(path.join(typeshed, child), "utf8");
    }
  };
  walk(STDLIB_DIR);
  return files;
}

/** The standard library's stubs, packed: their files by path as JSON, gzipped, in base64. */
export function packedStdlib(): string {
  return Buffer.from(Bun.gzipSync(JSON.stringify(pyrightStdlib()))).toString("base64");
}
