// The tree-sitter runtime and the grammars the code graph parses with. Each `.wasm` is
// imported `with { type: "file" }`, so the compiled tmb embeds it and needs no download.
// Nothing loads until the first parse; later parses reuse the compiled parsers.
import { Language, Parser } from "web-tree-sitter";
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import typescriptWasm from "tree-sitter-typescript/tree-sitter-typescript.wasm" with { type: "file" };
import tsxWasm from "tree-sitter-typescript/tree-sitter-tsx.wasm" with { type: "file" };
import javascriptWasm from "tree-sitter-javascript/tree-sitter-javascript.wasm" with { type: "file" };
import bashWasm from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };
import pythonWasm from "tree-sitter-python/tree-sitter-python.wasm" with { type: "file" };

export type IndexedGrammar = "typescript" | "tsx" | "javascript" | "bash" | "python";

export type Parsers = Record<IndexedGrammar, Parser>;

const GRAMMAR_WASM: Record<IndexedGrammar, string> = {
  typescript: typescriptWasm,
  tsx: tsxWasm,
  javascript: javascriptWasm,
  bash: bashWasm,
  python: pythonWasm,
};

let pending: Promise<Parsers> | null = null;

async function load(): Promise<Parsers> {
  await Parser.init({ locateFile: () => runtimeWasm });
  const parsers = {} as Parsers;
  for (const [name, file] of Object.entries(GRAMMAR_WASM) as [IndexedGrammar, string][]) {
    const parser = new Parser();
    parser.setLanguage(await Language.load(new Uint8Array(await Bun.file(file).arrayBuffer())));
    parsers[name] = parser;
  }
  return parsers;
}

/** Every grammar's parser, compiled once per process; a failed load is tried again on the next call. */
export function loadParsers(): Promise<Parsers> {
  if (!pending) {
    pending = load();
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}
