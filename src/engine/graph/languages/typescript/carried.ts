// The compiler tmb carries for way B (CODE_GRAPH.md, "Two ways to make links"): the TypeScript
// compiler's JavaScript API and its default library. The compiler is loaded only when way B builds
// a graph, so no other command starts slower for it. Its code is carried as a file of the program
// (`with { type: "file" }`), not as code: code the program bundles is parsed when it starts, used
// or not, and the compiler is several megabytes of it. loadCarried reads the file and runs it.
// The default library is carried packed (library.ts), unpacked by loadCarried too.
import { readFileSync } from "node:fs";
import path from "node:path";
import compilerFile from "typescript5/lib/typescript.js" with { type: "file" };
import carriedPackage from "typescript5/package.json" with { type: "json" };
import type { TypeScriptModule } from "./compiler.ts";
import { packedLibrary } from "./library.ts" with { type: "macro" };

/** The version of the compiler tmb carries, as its package names it. */
export const CARRIED_VERSION: string = carriedPackage.version;

/** The default library, packed when tmb is built. */
const PACKED_LIBRARY: string = packedLibrary();

/**
 * Where the compiler believes it runs. It finds its default library beside its own file; the
 * library it is given (compiler.ts) is served at that folder, so no file there is ever read.
 */
const COMPILER_DIR = "/tmb-carried/typescript/lib";

/** Loads the compiler tmb carries and its default library; it throws when they cannot load. */
export function loadCarried(): { ts: TypeScriptModule; library: ReadonlyMap<string, string> } {
  // The compiler's file is CommonJS: it is run as a module of its own, with the program's require.
  const source = readFileSync(compilerFile as unknown as string, "utf8");
  const module: { exports: unknown } = { exports: {} };
  new Function("module", "exports", "require", "__filename", "__dirname", source)(module, module.exports, require, path.join(COMPILER_DIR, "typescript.js"), COMPILER_DIR);
  const library = JSON.parse(Buffer.from(Bun.gunzipSync(Buffer.from(PACKED_LIBRARY, "base64"))).toString("utf8")) as Record<string, string>;
  return { ts: module.exports as TypeScriptModule, library: new Map(Object.entries(library)) };
}
