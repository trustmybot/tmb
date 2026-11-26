// A reader for SCIP index files (https://github.com/sourcegraph/scip, scip.proto), the open format
// rust-analyzer's `scip` command writes. Only the fields the A/B needs are decoded: each document's
// path and occurrences, and each symbol's kind and enclosing symbol. Protobuf wire format by hand,
// so the harness needs no package.

/** One occurrence of a symbol in a document. Lines and characters are 0-based, as SCIP writes them. */
export type Occurrence = {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  symbol: string;
  roles: number;
  /** The whole declaration around a definition, when the indexer gives it. */
  enclosing?: { startLine: number; endLine: number };
};
/** PositionEncoding in scip.proto: 1 UTF-8 bytes, 2 UTF-16 code units, 3 UTF-32 (characters); 0 unspecified. */
export type ScipDocument = { path: string; encoding: number; occurrences: Occurrence[]; symbols: { symbol: string; kind: number; enclosing: string }[] };
export type ScipIndex = { documents: ScipDocument[]; projectRoot: string };

/** SymbolRole.Definition in scip.proto. */
export const ROLE_DEFINITION = 1;

// Field numbers in scip.proto.
const INDEX = { metadata: 1, documents: 2 } as const;
const METADATA = { projectRoot: 3 } as const;
const DOCUMENT = { relativePath: 1, occurrences: 2, symbols: 3, positionEncoding: 6 } as const;
const OCCURRENCE = { range: 1, symbol: 2, roles: 3, enclosingRange: 7 } as const;
const SYMBOL_INFO = { symbol: 1, kind: 5, enclosingSymbol: 8 } as const;

const WIRE = { varint: 0, fixed64: 1, bytes: 2, fixed32: 5 } as const;

type Field = { no: number; wire: number; varint?: number; bytes?: Uint8Array };

function* fields(buf: Uint8Array): Generator<Field> {
  let i = 0;
  const varint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = buf[i++]!;
      out += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return out;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const no = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === WIRE.varint) yield { no, wire, varint: varint() };
    else if (wire === WIRE.bytes) {
      const len = varint();
      yield { no, wire, bytes: buf.subarray(i, i + len) };
      i += len;
    } else if (wire === WIRE.fixed64) i += 8;
    else if (wire === WIRE.fixed32) i += 4;
    else throw new Error(`scip: unknown wire type ${wire}`);
  }
}

const text = new TextDecoder();

function packed(f: Field): number[] {
  if (f.varint !== undefined) return [f.varint];
  const out: number[] = [];
  for (const g of fields(withKeys(f.bytes!))) out.push(g.varint!);
  return out;
}

// A packed repeated varint field holds bare varints; give each a key of field 1 so `fields` reads them.
function withKeys(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    out.push(WIRE.varint | (1 << 3));
    do out.push(bytes[i]!);
    while ((bytes[i++]! & 0x80) !== 0);
  }
  return Uint8Array.from(out);
}

/** A SCIP range: [line, start, end] on one line, or [startLine, startChar, endLine, endChar]. */
function span(r: number[]): { startLine: number; startChar: number; endLine: number; endChar: number } {
  return r.length === 3 ? { startLine: r[0]!, startChar: r[1]!, endLine: r[0]!, endChar: r[2]! } : { startLine: r[0]!, startChar: r[1]!, endLine: r[2]!, endChar: r[3]! };
}

function occurrence(buf: Uint8Array): Occurrence {
  let range: number[] = [];
  let symbol = "";
  let roles = 0;
  let enclosing: number[] = [];
  for (const f of fields(buf)) {
    if (f.no === OCCURRENCE.range) range = range.concat(packed(f));
    else if (f.no === OCCURRENCE.symbol) symbol = text.decode(f.bytes);
    else if (f.no === OCCURRENCE.roles) roles = f.varint!;
    else if (f.no === OCCURRENCE.enclosingRange) enclosing = enclosing.concat(packed(f));
  }
  const at = span(range);
  const occ: Occurrence = { ...at, symbol, roles };
  if (enclosing.length > 0) {
    const e = span(enclosing);
    occ.enclosing = { startLine: e.startLine, endLine: e.endLine };
  }
  return occ;
}

function symbolInfo(buf: Uint8Array): { symbol: string; kind: number; enclosing: string } {
  let symbol = "";
  let kind = 0;
  let enclosing = "";
  for (const f of fields(buf)) {
    if (f.no === SYMBOL_INFO.symbol) symbol = text.decode(f.bytes);
    else if (f.no === SYMBOL_INFO.kind) kind = f.varint!;
    else if (f.no === SYMBOL_INFO.enclosingSymbol) enclosing = text.decode(f.bytes);
  }
  return { symbol, kind, enclosing };
}

/** Reads a whole SCIP index. */
export function readScip(bytes: Uint8Array): ScipIndex {
  const documents: ScipDocument[] = [];
  let projectRoot = "";
  for (const f of fields(bytes)) {
    if (f.no === INDEX.metadata) {
      for (const g of fields(f.bytes!)) if (g.no === METADATA.projectRoot) projectRoot = text.decode(g.bytes);
    } else if (f.no === INDEX.documents) {
      const doc: ScipDocument = { path: "", encoding: 0, occurrences: [], symbols: [] };
      for (const g of fields(f.bytes!)) {
        if (g.no === DOCUMENT.relativePath) doc.path = text.decode(g.bytes);
        else if (g.no === DOCUMENT.occurrences) doc.occurrences.push(occurrence(g.bytes!));
        else if (g.no === DOCUMENT.symbols) doc.symbols.push(symbolInfo(g.bytes!));
        else if (g.no === DOCUMENT.positionEncoding) doc.encoding = g.varint!;
      }
      documents.push(doc);
    }
  }
  return { documents, projectRoot };
}

if (import.meta.main) {
  const index = readScip(new Uint8Array(await Bun.file(process.argv[2]!).arrayBuffer()));
  console.log("root", index.projectRoot);
  for (const d of index.documents) {
    console.log("##", d.path, "encoding", d.encoding);
    for (const o of d.occurrences) console.log(`${o.startLine + 1}:${o.startChar}-${o.endLine + 1}:${o.endChar} r${o.roles} ${o.symbol}${o.enclosing ? ` enc ${o.enclosing.startLine + 1}-${o.enclosing.endLine + 1}` : ""}`);
  }
}
