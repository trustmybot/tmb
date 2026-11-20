// The tree-sitter runtime and the grammars the code graph parses with. Each grammar's `.wasm`
// is imported by its language module `with { type: "file" }`, so the compiled tmb embeds it
// and needs no download. A grammar loads the first time a file in its language is parsed
// (trustmybot/tmb#157); later parses reuse its compiled parser.
import { Language, Parser } from "web-tree-sitter";
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import { LANGUAGES, languageNamed } from "./languages/registry.ts";

/** A compiled parser for each language loaded, by language name. */
export type Parsers = ReadonlyMap<string, Parser>;

let runtime: Promise<void> | null = null;
const parsers = new Map<string, Promise<Parser>>();

function retried<T>(promise: Promise<T>, forget: () => void): Promise<T> {
  promise.catch(forget);
  return promise;
}

async function compile(grammar: string): Promise<Parser> {
  if (!runtime) runtime = retried(Parser.init({ locateFile: () => runtimeWasm }), () => (runtime = null));
  await runtime;
  const parser = new Parser();
  parser.setLanguage(await Language.load(new Uint8Array(await Bun.file(grammar).arrayBuffer())));
  return parser;
}

/**
 * The parsers of the named languages, every language with a grammar when none is named, each
 * compiled once per process; a failed load is tried again on the next call.
 */
export async function loadParsers(names?: Iterable<string>): Promise<Parsers> {
  const wanted = names ? [...new Set(names)].map(languageNamed) : LANGUAGES;
  const out = new Map<string, Parser>();
  for (const lang of wanted) {
    if (!lang?.grammar) continue;
    let pending = parsers.get(lang.name);
    if (!pending) {
      pending = retried(compile(lang.grammar), () => parsers.delete(lang.name));
      parsers.set(lang.name, pending);
    }
    out.set(lang.name, await pending);
  }
  return out;
}

/** The languages whose grammar this process has loaded, or is loading. */
export function loadedGrammars(): string[] {
  return [...parsers.keys()].sort();
}
