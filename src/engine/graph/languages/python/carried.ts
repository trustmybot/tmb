// The tool tmb carries for Python's way B (CODE_GRAPH.md, "Two ways to make links"): pyright, its
// own code and its standard library's stubs. It is loaded only when way B builds a Python graph,
// so no other command starts slower for it. Its code is carried as files of the program
// (`with { type: "file" }`), not as code: code the program bundles is parsed when it starts, used
// or not, and pyright is several megabytes of it. loadCarried reads the files and runs them.
//
// pyright's package is a command-line program, not a library: its entry file runs the command, and
// its parts are modules of a webpack bundle. loadCarried runs the entry file only until it asks for
// its first module, keeps the bundle's own loader, and asks that loader for the parts tool.ts uses,
// each by the name it exports. The standard library's stubs are carried packed (stdlib.ts) and
// served from memory, so no file of them is ever read.
import { readFileSync } from "node:fs";
import path from "node:path";
import entryFile from "pyright/dist/pyright.js" with { type: "file" };
import internalFile from "pyright/dist/pyright-internal.js" with { type: "file" };
import vendorFile from "pyright/dist/vendor.js" with { type: "file" };
import { packedStdlib } from "./stdlib.ts" with { type: "macro" };

/** The standard library's stubs, packed when tmb is built. */
const PACKED_STDLIB: string = packedStdlib();

/**
 * Where pyright believes it runs. It finds typeshed under its own folder; the stubs it is given
 * are served at that folder (tool.ts), so no file there is ever read.
 */
export const PYRIGHT_DIR = "/tmb-carried/pyright/dist";
/** Where pyright looks for typeshed, under its own folder: the carried stubs' paths are under it. */
export const TYPESHED_ROOT = `${PYRIGHT_DIR}/typeshed-fallback`;

/** The bundle's chunks, by the name its entry file requires them with. */
const CHUNKS: Record<string, string> = { "./vendor.js": vendorFile, "./pyright-internal.js": internalFile };

/** A chunk of the bundle: its modules, each a function the bundle's loader calls with itself. */
type Chunk = { modules: Record<string, (this: unknown, module: unknown, exports: unknown, load: Loader) => void> };
type Loader = (id: string) => Record<string, unknown>;

/** Thrown to stop the entry file at its first module, once the loader is in hand. */
class LoaderFound extends Error {}

/** Runs a CommonJS file as a module of its own, with the given require. */
function runFile(file: string, require: (id: string) => unknown): Record<string, unknown> {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  new Function("module", "exports", "require", "__filename", "__dirname", readFileSync(file, "utf8"))(module, module.exports, require, path.join(PYRIGHT_DIR, path.basename(file)), PYRIGHT_DIR);
  return module.exports;
}

/** The part of pyright that exports a name, by that name. */
export type Exporting = (name: string) => Record<string, any>;

/** Loads the pyright tmb carries; it throws when it cannot load. */
export function loadCarried(): { exporting: Exporting; stdlib: ReadonlyMap<string, string> } {
  // pyright finds its own folder through this global, which its command line sets.
  (globalThis as { __rootDirectory?: string }).__rootDirectory = `${PYRIGHT_DIR}/`;
  let loader: Loader | undefined;
  const sources = new Map<string, string>();
  const chunks = new Map<string, Chunk>();
  for (const [name, file] of Object.entries(CHUNKS)) {
    const chunk = runFile(file, require) as unknown as Chunk;
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
    chunks.set(name, chunk);
  }
  try {
    runFile(entryFile, (id) => chunks.get(id) ?? require(id));
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
  const stdlib = JSON.parse(Buffer.from(Bun.gunzipSync(Buffer.from(PACKED_STDLIB, "base64"))).toString("utf8")) as Record<string, string>;
  return { exporting, stdlib: new Map(Object.entries(stdlib)) };
}
