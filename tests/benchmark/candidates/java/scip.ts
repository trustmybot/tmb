// Candidate: scip-java, read through the SCIP index it writes (CODE_GRAPH.md plans way B for other
// languages to read a SCIP index, trustmybot/tmb#156). The index is decoded here from the protobuf
// wire format with the fields of scip.proto this needs, and turned into the same lines the Java
// candidates write (tools/Out.java):
// - a reference to a method or constructor symbol (a local one by its kind) is a call at the position where it is written;
// - its place is the symbol's definition in the index: the file, the name and the lines of the
//   definition's enclosing range, else of the name;
// - a symbol with no definition whose type is defined in the index is placed at its type;
// - any other global symbol with no definition in the index is outside; a call with no reference is not known.

type Occurrence = { range: number[]; symbol: string; roles: number; enclosing: number[] };
type Info = { symbol: string; kind: number; display: string; enclosing: string };
type Document = { path: string; occurrences: Occurrence[]; encoding: number; symbols: Info[] };

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}
  varint(): number {
    let out = 0;
    let shift = 1;
    for (;;) {
      const b = this.buf[this.pos++] as number;
      out += (b & 0x7f) * shift;
      if (b < 0x80) return out;
      shift *= 128;
    }
  }
  bytes(): Uint8Array {
    const n = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** Each field of the message: its number, wire type, and the reader at its value. */
  *fields(): Generator<[number, number]> {
    while (this.pos < this.buf.length) {
      const key = this.varint();
      yield [Math.floor(key / 8), key % 8];
    }
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`wire type ${wire}`);
  }
  /** A repeated int32, packed or not. */
  ints(wire: number, into: number[]) {
    if (wire === 0) into.push(this.varint());
    else {
      const r = new Reader(this.bytes());
      while (r.pos < r.buf.length) into.push(r.varint());
    }
  }
}

const text = new TextDecoder();

/** A SingleLineRange (3 fields) or MultiLineRange (4 fields) as the deprecated `repeated int32` form; proto3 leaves out zeros. */
function typed(buf: Uint8Array, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  const r = new Reader(buf);
  for (const [f, w] of r.fields()) {
    if (f >= 1 && f <= n && w === 0) out[f - 1] = r.varint();
    else r.skip(w);
  }
  return out;
}

function occurrence(buf: Uint8Array): Occurrence {
  const r = new Reader(buf);
  const o: Occurrence = { range: [], symbol: "", roles: 0, enclosing: [] };
  for (const [f, w] of r.fields()) {
    if (f === 1) r.ints(w, o.range);
    else if (f === 2) o.symbol = text.decode(r.bytes());
    else if (f === 3) o.roles = r.varint();
    else if (f === 7) r.ints(w, o.enclosing);
    else if (f === 8 || f === 10) (f === 8 ? (o.range = typed(r.bytes(), 3)) : (o.enclosing = typed(r.bytes(), 3)));
    else if (f === 9 || f === 11) (f === 9 ? (o.range = typed(r.bytes(), 4)) : (o.enclosing = typed(r.bytes(), 4)));
    else r.skip(w);
  }
  return o;
}

function info(buf: Uint8Array): Info {
  const r = new Reader(buf);
  const o: Info = { symbol: "", kind: 0, display: "", enclosing: "" };
  for (const [f, w] of r.fields()) {
    if (f === 1) o.symbol = text.decode(r.bytes());
    else if (f === 5) o.kind = r.varint();
    else if (f === 6) o.display = text.decode(r.bytes());
    else if (f === 8) o.enclosing = text.decode(r.bytes());
    else r.skip(w);
  }
  return o;
}

function document(buf: Uint8Array): Document {
  const r = new Reader(buf);
  const d: Document = { path: "", occurrences: [], encoding: 0, symbols: [] };
  for (const [f, w] of r.fields()) {
    if (f === 1) d.path = text.decode(r.bytes());
    else if (f === 2) d.occurrences.push(occurrence(r.bytes()));
    else if (f === 3) d.symbols.push(info(r.bytes()));
    else if (f === 6) d.encoding = r.varint();
    else r.skip(w);
  }
  return d;
}

/** The documents of a SCIP index (Index.documents is field 2). */
export function readIndex(buf: Uint8Array): Document[] {
  const r = new Reader(buf);
  const out: Document[] = [];
  for (const [f, w] of r.fields()) {
    if (f === 2) out.push(document(r.bytes()));
    else r.skip(w);
  }
  return out;
}

const DEFINITION = 1;
/** A method or constructor symbol: its last descriptor is `name(disambiguator).` (SCIP symbol grammar). */
const METHOD = /(?:`([^`]+)`|([^\s#./`]+))\([^)]*\)\.$/;
const TYPE = /(?:`([^`]+)`|([^\s#./`]+))#(?:`[^`]+`|[^\s#./`]+)\([^)]*\)\.$/;

function methodName(symbol: string): string | null {
  const m = METHOD.exec(symbol);
  if (!m) return null;
  const name = m[1] ?? m[2] ?? "";
  if (name !== "<init>") return name;
  const t = TYPE.exec(symbol);
  return t ? (t[1] ?? t[2] ?? "") : null;
}

/** UTF-16 offset of a 0-based line and character in a file's text. */
function offsetOf(starts: number[], line: number, ch: number): number {
  return (starts[line] ?? 0) + ch;
}

function lineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\r" && s[i + 1] === "\n") continue;
    if (s[i] === "\n" || s[i] === "\r") out.push(i + 1);
  }
  return out;
}

const endLine = (r: number[]) => (r.length === 4 ? (r[2] as number) : (r[0] as number));

/** The SCIP index as the lines tools/Out.java writes, for run.ts. */
/** SCIP kinds of a callable (scip.proto, SymbolInformation.Kind), for a local symbol, whose name says nothing. */
const CALLABLE_KINDS = new Set([9, 26, 66, 80]);
const CONSTRUCTOR_KIND = 9;
const LOCAL = "local ";

export async function scipAnswers(index: string, root: string): Promise<string[]> {
  const docs = readIndex(new Uint8Array(await Bun.file(index).arrayBuffer()));
  // A global symbol is one name across the index; a local one only within its document (SCIP symbol grammar).
  const id = (doc: Document, symbol: string) => (symbol.startsWith(LOCAL) ? `${doc.path}#${symbol}` : symbol);
  const infos = new Map<string, Info>();
  for (const d of docs) for (const i of d.symbols) infos.set(id(d, i.symbol), i);
  const nameOf = (d: Document, symbol: string): string | null => {
    if (!symbol.startsWith(LOCAL)) return methodName(symbol);
    const i = infos.get(id(d, symbol));
    if (!i || !CALLABLE_KINDS.has(i.kind)) return null;
    return i.kind === CONSTRUCTOR_KIND ? (infos.get(id(d, i.enclosing))?.display ?? "") : i.display;
  };
  const defs = new Map<string, { file: string; start: number; end: number }>();
  const lines: string[] = [];
  for (const d of docs) {
    for (const o of d.occurrences) {
      if ((o.roles & DEFINITION) === 0) continue;
      const r = o.enclosing.length > 0 ? o.enclosing : o.range;
      defs.set(id(d, o.symbol), { file: d.path, start: (r[0] as number) + 1, end: endLine(r) + 1 });
      const name = nameOf(d, o.symbol);
      if (name !== null) lines.push(JSON.stringify({ t: "fn", file: d.path, name, kind: "method", start: (r[0] as number) + 1, end: endLine(r) + 1 }));
    }
  }
  for (const d of docs) {
    const starts = lineStarts(await Bun.file(`${root}/${d.path}`).text());
    for (const o of d.occurrences) {
      if ((o.roles & DEFINITION) !== 0) continue;
      const name = nameOf(d, o.symbol);
      if (name === null) continue;
      const pos = offsetOf(starts, o.range[0] as number, o.range[1] as number);
      const line = (o.range[0] as number) + 1;
      const def = defs.get(id(d, o.symbol));
      if (def) lines.push(JSON.stringify({ t: "call", file: d.path, pos, line, name, state: "repo", decls: [{ ...def, name }] }));
      else if (o.symbol.startsWith(LOCAL)) lines.push(JSON.stringify({ t: "call", file: d.path, pos, line, name, state: "unknown", decls: [], why: "local with no definition" }));
      else {
        // No definition of its own: a member the language declares implicitly (JLS 8.8.9, 8.9.3,
        // 8.10.3) is placed at its type when the type is defined in the index.
        const owner = defs.get(o.symbol.replace(METHOD, ""));
        if (owner) lines.push(JSON.stringify({ t: "call", file: d.path, pos, line, name, state: "repo", decls: [{ ...owner, name }], why: "implicit" }));
        else lines.push(JSON.stringify({ t: "call", file: d.path, pos, line, name, state: "outside", decls: [] }));
      }
    }
  }
  lines.push(JSON.stringify({ t: "info", key: "documents", value: String(docs.length) }));
  lines.push(JSON.stringify({ t: "info", key: "encoding", value: [...new Set(docs.map((d) => d.encoding))].join(",") }));
  return lines;
}

if (import.meta.main) {
  const [index, root, out] = Bun.argv.slice(2);
  if (!index || !root || !out) throw new Error("usage: bun scip.ts <index.scip> <root> <out.jsonl>");
  await Bun.write(out, `${(await scipAnswers(index, root)).join("\n")}\n`);
}
