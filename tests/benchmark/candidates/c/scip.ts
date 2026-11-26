// Candidate: scip-clang, Sourcegraph's SCIP indexer for C and C++, built on clang's front end. It
// writes one index of the project (index.scip); this file reads it with a small protobuf reader for
// the fields of scip.proto the harness needs, and answers each call from it:
// - the occurrence at the place the call's name is written gives the symbol;
// - the symbol's definitions in the project's documents are its declarations.
// scip-clang writes no occurrence for a symbol declared outside the project, and marks a plain
// declaration in the project no differently from a reference, so its index never proves that a call
// goes outside the repo: a call with no definition in the index is not known.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { callKey, type Answers, type Decl, type GraphCall } from "./lib.ts";

/** scip.proto SymbolRole bits. */
const ROLE_DEFINITION = 0x1;

class Reader {
  pos = 0;
  constructor(private b: Uint8Array, private end = b.length) {}
  done() {
    return this.pos >= this.end;
  }
  varint(): number {
    let r = 0;
    let shift = 0;
    for (;;) {
      const x = this.b[this.pos++]!;
      r += (x & 0x7f) * 2 ** shift;
      if ((x & 0x80) === 0) return r;
      shift += 7;
    }
  }
  tag(): [number, number] {
    const t = this.varint();
    return [Math.floor(t / 8), t & 7];
  }
  bytes(): Uint8Array {
    const n = this.varint();
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const n = this.varint();
      this.pos += n;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`wire type ${wire} at ${this.pos} of ${this.end}`);
  }
}

const text = new TextDecoder();
type Occurrence = { range: number[]; symbol: string; roles: number; enclosing: number[] };
type Document = { path: string; occurrences: Occurrence[] };

function packedInts(r: Reader, wire: number, into: number[]) {
  if (wire === 2) {
    const sub = new Reader(r.bytes());
    while (!sub.done()) into.push(sub.varint());
  } else into.push(r.varint());
}

function occurrence(b: Uint8Array): Occurrence {
  const r = new Reader(b);
  const o: Occurrence = { range: [], symbol: "", roles: 0, enclosing: [] };
  while (!r.done()) {
    const [f, w] = r.tag();
    if (f === 1) packedInts(r, w, o.range);
    else if (f === 2) o.symbol = text.decode(r.bytes());
    else if (f === 3) o.roles = r.varint();
    else if (f === 7) packedInts(r, w, o.enclosing);
    else r.skip(w);
  }
  return o;
}

function document(b: Uint8Array): Document {
  const r = new Reader(b);
  const d: Document = { path: "", occurrences: [] };
  while (!r.done()) {
    const [f, w] = r.tag();
    if (f === 1) d.path = text.decode(r.bytes());
    else if (f === 2) d.occurrences.push(occurrence(r.bytes()));
    else r.skip(w);
  }
  return d;
}

export function readIndex(file: string): Document[] {
  const r = new Reader(new Uint8Array(readFileSync(file)));
  const docs: Document[] = [];
  while (!r.done()) {
    const [f, w] = r.tag();
    if (f === 2) docs.push(document(r.bytes()));
    else r.skip(w);
  }
  return docs;
}

/** Run scip-clang over the project; the project root is its working folder. */
export function runScipClang(binary: string, root: string, cdb: string, out: string): { ms: number; status: number | null; stderr: string } {
  const t0 = performance.now();
  const r = spawnSync(binary, [`--compdb-path=${cdb}`, `--index-output-path=${out}`, "--no-progress-report", "--log-level=warning"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  return { ms: performance.now() - t0, status: r.status, stderr: r.stderr };
}

const isLocal = (symbol: string) => symbol.startsWith("local ");

/** Each call's declarations, read from the index. */
export function scipAnswers(docs: Document[], calls: readonly GraphCall[]): Answers {
  const at = new Map<string, Occurrence[]>();
  const defs = new Map<string, Decl[]>();
  for (const d of docs) {
    for (const o of d.occurrences) {
      const line = o.range[0]! + 1;
      const col = o.range[1]! + 1;
      const key = callKey(d.path, line, col);
      at.set(key, [...(at.get(key) ?? []), o]);
      if (isLocal(o.symbol)) continue;
      if (o.roles & ROLE_DEFINITION) {
        const span = o.enclosing.length >= 3 ? { start: o.enclosing[0]! + 1, end: (o.enclosing.length === 4 ? o.enclosing[2]! : o.enclosing[0]!) + 1 } : { start: line, end: line };
        defs.set(o.symbol, [...(defs.get(o.symbol) ?? []), { file: d.path, ...span }]);
      }
    }
  }
  const out: Answers = new Map();
  for (const c of calls) {
    const key = callKey(c.file, c.line, c.col);
    const refs = (at.get(key) ?? []).filter((o) => !(o.roles & ROLE_DEFINITION) && o.symbol !== "");
    const ans: Decl[] = [];
    for (const o of refs) {
      if (isLocal(o.symbol)) continue;
      const found = defs.get(o.symbol);
      if (found !== undefined) ans.push(...found);
    }
    out.set(key, ans);
  }
  return out;
}
