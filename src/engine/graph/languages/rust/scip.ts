// A reader for SCIP index files, the open format rust-analyzer's `scip` command writes
// (https://github.com/sourcegraph/scip, scip.proto). It decodes only what way B for Rust reads:
// each document's path, position encoding and occurrences, and each symbol's kind. Protobuf's
// wire format (https://protobuf.dev/programming-guides/encoding/) is read by hand, so tmb carries
// no package for it.

/** One occurrence of a symbol in a document. Lines and characters are 0-based, as SCIP writes them. */
export type Occurrence = { line: number; start: number; endLine: number; end: number; symbol: string; roles: number };

/** A document of the index: its path from the project's root, its position encoding, and what it holds. */
export type ScipDocument = { path: string; encoding: number; occurrences: Occurrence[]; kinds: Map<string, number> };

/** SymbolRole.Definition in scip.proto: the occurrence defines the symbol. */
export const ROLE_DEFINITION = 1;

/** PositionEncoding in scip.proto: a character is a UTF-8 byte, or a UTF-16 code unit. */
export const ENCODING = { utf8: 1, utf16: 2 } as const;

/** SymbolInformation.Kind in scip.proto: an enum's variant. */
export const KIND_ENUM_MEMBER = 12;

// Field numbers in scip.proto.
const INDEX_DOCUMENTS = 2;
const DOCUMENT = { relativePath: 1, occurrences: 2, symbols: 3, positionEncoding: 6 } as const;
const OCCURRENCE = { range: 1, symbol: 2, roles: 3 } as const;
const SYMBOL_INFORMATION = { symbol: 1, kind: 5 } as const;

// Protobuf's wire types.
const WIRE = { varint: 0, fixed64: 1, bytes: 2, fixed32: 5 } as const;

type Field = { no: number; varint: number; bytes: Uint8Array | null };

const utf8 = new TextDecoder();

/** Reads a varint at `at`; returns it and the offset after it. */
function varint(buf: Uint8Array, at: number): [number, number] {
  let out = 0;
  let scale = 1;
  for (let i = at; i < buf.length; i++) {
    const b = buf[i]!;
    out += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return [out, i + 1];
    scale *= 128;
  }
  throw new Error("scip: a varint runs past the end");
}

function* fields(buf: Uint8Array): Generator<Field> {
  let i = 0;
  while (i < buf.length) {
    const [key, next] = varint(buf, i);
    i = next;
    const no = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === WIRE.varint) {
      const [value, after] = varint(buf, i);
      i = after;
      yield { no, varint: value, bytes: null };
    } else if (wire === WIRE.bytes) {
      const [length, after] = varint(buf, i);
      if (after + length > buf.length) throw new Error("scip: a field runs past the end");
      yield { no, varint: 0, bytes: buf.subarray(after, after + length) };
      i = after + length;
    } else if (wire === WIRE.fixed64) i += 8;
    else if (wire === WIRE.fixed32) i += 4;
    else throw new Error(`scip: unknown wire type ${wire}`);
  }
}

/** A repeated varint field, packed or not. */
function varints(f: Field, into: number[]): void {
  if (f.bytes === null) {
    into.push(f.varint);
    return;
  }
  for (let i = 0; i < f.bytes.length; ) {
    const [value, next] = varint(f.bytes, i);
    into.push(value);
    i = next;
  }
}

function occurrence(buf: Uint8Array): Occurrence | null {
  const range: number[] = [];
  let symbol = "";
  let roles = 0;
  for (const f of fields(buf)) {
    if (f.no === OCCURRENCE.range) varints(f, range);
    else if (f.no === OCCURRENCE.symbol && f.bytes !== null) symbol = utf8.decode(f.bytes);
    else if (f.no === OCCURRENCE.roles) roles = f.varint;
  }
  // A range is [line, start, end] on one line, or [line, start, endLine, end].
  if (range.length === 3) return { line: range[0]!, start: range[1]!, endLine: range[0]!, end: range[2]!, symbol, roles };
  if (range.length === 4) return { line: range[0]!, start: range[1]!, endLine: range[2]!, end: range[3]!, symbol, roles };
  return null;
}

function document(buf: Uint8Array): ScipDocument {
  const doc: ScipDocument = { path: "", encoding: 0, occurrences: [], kinds: new Map() };
  for (const f of fields(buf)) {
    if (f.no === DOCUMENT.relativePath && f.bytes !== null) doc.path = utf8.decode(f.bytes);
    else if (f.no === DOCUMENT.positionEncoding) doc.encoding = f.varint;
    else if (f.no === DOCUMENT.occurrences && f.bytes !== null) {
      const o = occurrence(f.bytes);
      if (o !== null) doc.occurrences.push(o);
    } else if (f.no === DOCUMENT.symbols && f.bytes !== null) {
      let symbol = "";
      let kind = 0;
      for (const g of fields(f.bytes)) {
        if (g.no === SYMBOL_INFORMATION.symbol && g.bytes !== null) symbol = utf8.decode(g.bytes);
        else if (g.no === SYMBOL_INFORMATION.kind) kind = g.varint;
      }
      if (symbol !== "") doc.kinds.set(symbol, kind);
    }
  }
  return doc;
}

/** The documents of a whole SCIP index. */
export function readScip(bytes: Uint8Array): ScipDocument[] {
  const out: ScipDocument[] = [];
  for (const f of fields(bytes)) if (f.no === INDEX_DOCUMENTS && f.bytes !== null) out.push(document(f.bytes));
  return out;
}

/** Whether a symbol is local to a document: a variable, a parameter or a closure (scip.proto, "local"). */
export const isLocal = (symbol: string): boolean => symbol.startsWith("local ");

/**
 * The package a global symbol belongs to, `<manager> <name> <version>`: a symbol is
 * `<scheme> <manager> <name> <version> <descriptors>`, its first four parts each ending at a space.
 */
export function packageOf(symbol: string): string {
  const parts = symbol.split(" ", 4);
  return parts.length === 4 ? `${parts[1]} ${parts[2]} ${parts[3]}` : "";
}

/**
 * The symbol a type descriptor is in: `… E#V#` is in `… E#`. Null when the symbol does not end in a
 * type descriptor (`name#`, the name plain or in backticks).
 */
export function ownerOfType(symbol: string): string | null {
  if (!symbol.endsWith("#")) return null;
  let i = symbol.length - 2;
  if (symbol[i] === "`") {
    // A backticked name ends at its opening backtick; a backtick in it is written twice.
    for (i--; i >= 0; i--) {
      if (symbol[i] !== "`") continue;
      if (symbol[i - 1] === "`") i--;
      else break;
    }
    if (i < 0) return null;
  } else {
    while (i >= 0 && /[\w+\-$]/.test(symbol[i]!)) i--;
    i++;
  }
  const owner = symbol.slice(0, i);
  return owner.endsWith("#") || owner.endsWith("/") ? owner : null;
}
