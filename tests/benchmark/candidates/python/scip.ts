// Reads a SCIP index (https://github.com/sourcegraph/scip, scip.proto), the open format language
// indexers write, for the Python A/B test (trustmybot/tmb#338). Only the fields the test needs are
// decoded: each document's path and occurrences (range, symbol, roles). The protobuf wire format is
// read by hand, so no package is installed for it.

/** An occurrence: 0-based start line and character, end line and character, its symbol and roles. */
export type Occurrence = { line: number; character: number; endLine: number; endCharacter: number; symbol: string; roles: number };
export type ScipDocument = { path: string; occurrences: Occurrence[] };

/** SymbolRole.Definition in scip.proto. */
export const DEFINITION = 0x1;

class Reader {
  pos = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly end = buf.length,
  ) {}
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint();
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unknown wire type ${wire}`);
  }
}

const text = new TextDecoder();

/** Each field of a message: its number, wire type, and a reader positioned at its value. */
function* fields(buf: Uint8Array): Generator<{ field: number; wire: number; r: Reader }> {
  const r = new Reader(buf);
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    const at = r.pos;
    yield { field, wire, r };
    if (r.pos === at) r.skip(wire);
  }
}

function occurrence(buf: Uint8Array): Occurrence | null {
  let range: number[] = [];
  let symbol = "";
  let roles = 0;
  for (const { field, wire, r } of fields(buf)) {
    if (field === 1) {
      if (wire === 2) {
        const packed = new Reader(r.bytes());
        while (packed.pos < packed.end) range.push(packed.varint());
      } else range.push(r.varint());
    } else if (field === 2 && wire === 2) symbol = text.decode(r.bytes());
    else if (field === 3 && wire === 0) roles = r.varint();
  }
  if (range.length === 3) range = [range[0]!, range[1]!, range[0]!, range[2]!];
  if (range.length !== 4) return null;
  return { line: range[0]!, character: range[1]!, endLine: range[2]!, endCharacter: range[3]!, symbol, roles };
}

function document(buf: Uint8Array): ScipDocument {
  let docPath = "";
  const occurrences: Occurrence[] = [];
  for (const { field, wire, r } of fields(buf)) {
    if (field === 1 && wire === 2) docPath = text.decode(r.bytes());
    else if (field === 2 && wire === 2) {
      const o = occurrence(r.bytes());
      if (o !== null) occurrences.push(o);
    }
  }
  return { path: docPath, occurrences };
}

/** The documents of an index. */
export function readScip(buf: Uint8Array): ScipDocument[] {
  const docs: ScipDocument[] = [];
  for (const { field, wire, r } of fields(buf)) if (field === 2 && wire === 2) docs.push(document(r.bytes()));
  return docs;
}

/** Whether a symbol is local to one document (`local N`), which SCIP gives no package. */
export const isLocal = (symbol: string): boolean => symbol.startsWith("local ");

/**
 * A global symbol's package, as scip.proto writes it: `<scheme> <manager> <name> <version> <descriptors>`,
 * each part ending at a space.
 */
export function packageOf(symbol: string): { manager: string; name: string; version: string } | null {
  if (isLocal(symbol)) return null;
  const parts = symbol.split(" ");
  if (parts.length < 5) return null;
  return { manager: parts[1]!, name: parts[2]!, version: parts[3]! };
}
