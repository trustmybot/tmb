// The SQL parser tmb carries (CODE_GRAPH.md, "Data sources"): sqlparser-rs, built from its source
// at a pinned version into sql-tables.wasm by scripts/build-sql-parser.ts (the crate is in
// parser/). It is carried as a file of the program (`with { type: "file" }`) and loaded the first
// time a text is read, so a repo with no SQL never loads it and no command starts slower for it.
import { readFileSync } from "node:fs";
import wasmFile from "./sql-tables.wasm" with { type: "file" };

/** Where a statement reads or writes: a table by name, or the store alone. */
export type SqlPlace = { to: "table"; name: string } | { to: "store" };

export type SqlRef = { op: "read" | "write"; at: SqlPlace };

/** One statement of a text, its lines counted from the text's first line as 1. */
export type SqlStatement = {
  line: number;
  end: number;
  /** False when no dialect parses it, or two that parse it name different tables. */
  read: boolean;
  /** How many dialects the parser tried. */
  of: number;
  /** How many of them parsed it, when it was read. */
  parsed?: number;
  /** Whether the general dialect parsed it, when it was read. */
  general?: boolean;
  refs?: SqlRef[];
  triggers?: { name: string; on: SqlPlace | null; refs: SqlRef[] }[];
};

type Exports = {
  memory: WebAssembly.Memory;
  block_alloc(len: number): number;
  block_free(ptr: number, len: number): void;
  analyze_json(text: number, textLen: number, hole: number, holeLen: number): number;
};

let loaded: Exports | null = null;

function parser(): Exports {
  if (loaded === null) {
    const module = new WebAssembly.Module(readFileSync(wasmFile as unknown as string));
    loaded = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  }
  return loaded;
}

function put(wasm: Exports, bytes: Uint8Array): number {
  const at = wasm.block_alloc(bytes.length);
  new Uint8Array(wasm.memory.buffer, at, bytes.length).set(bytes);
  return at;
}

/**
 * The statements of `text` and the tables each reads and writes. `hole` is the word a caller put
 * where code interpolates a value: a name holding it is not stated. A text the parser stops on
 * (a trap) is one statement not read, and the parser is loaded anew for the next text.
 */
export function readSql(text: string, hole: string): SqlStatement[] {
  const wasm = parser();
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);
  const holeBytes = encoder.encode(hole);
  let textAt = 0;
  let holeAt = 0;
  try {
    textAt = put(wasm, textBytes);
    holeAt = put(wasm, holeBytes);
    const answer = wasm.analyze_json(textAt, textBytes.length, holeAt, holeBytes.length);
    const length = new DataView(wasm.memory.buffer).getUint32(answer, true);
    const json = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, answer + 4, length));
    wasm.block_free(answer, length + 4);
    wasm.block_free(textAt, textBytes.length);
    wasm.block_free(holeAt, holeBytes.length);
    return JSON.parse(json) as SqlStatement[];
  } catch {
    loaded = null;
    return [{ line: 1, end: text.split("\n").length, read: false, of: 0 }];
  }
}
