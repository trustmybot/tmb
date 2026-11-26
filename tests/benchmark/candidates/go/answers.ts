// Each candidate's answer for the calls of a repo (trustmybot/tmb#346): where the callee of each
// call is declared, as the candidate says. The matching to nodes is the same for all (match.ts).
//
// The candidates, each run from the PATH the harness is given (nothing is installed by it):
// - go/types: the official toolchain's type checker, through `gotypes` (gotypes/main.go);
// - gopls: the Go team's language server, asked textDocument/definition over LSP for each call;
// - scip-go: the SCIP indexer, whose index is read for the symbol at each call and its definition.
import { spawn } from "bun";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { GoCall } from "./nodes.ts";

/**
 * What a candidate says a call names:
 * - decl: declared at `line` of `file` (relative to the repo), which is in the repo;
 * - outside: declared outside the repo, the standard library and built-ins included;
 * - none: no answer.
 * `isType` is set when the candidate says the callee is a type, which makes the call a conversion.
 */
export type Answer = { kind: "decl"; file: string; line: number; isType?: boolean } | { kind: "outside"; isType?: boolean } | { kind: "none" };

export type Answers = { answers: Map<string, Answer>; ms: { start: number; total: number }; note: string[] };

/** The key of a call: its file and position. */
export const callKey = (file: string, pos: number) => `${file}:${pos}`;

/** UTF-16 offset of each UTF-8 byte offset of `text`. */
export function byteToUtf16(text: string): (byte: number) => number {
  const bytes = Buffer.from(text, "utf8");
  const map = new Int32Array(bytes.length + 1);
  let u = 0;
  for (let b = 0; b < bytes.length; ) {
    const c = bytes[b] ?? 0;
    const len = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    for (let k = 0; k < len; k++) map[b + k] = u;
    b += len;
    u += len === 4 ? 2 : 1;
  }
  map[bytes.length] = u;
  return (byte) => map[byte] ?? u;
}

// ---------------------------------------------------------------------------------------------
// go/types

export type GotypesCall = {
  file: string;
  off: number;
  line: number;
  name: string;
  owner: number;
  kind: "call" | "conversion" | "builtin";
  callee: string;
  decl?: { file: string; line: number; name: string; kind: string; inRepo: boolean };
};
export type GotypesFn = { file: string; kind: string; name: string; start: number; end: number; body: boolean };
export type GotypesOut = { go: string; loadMs: number; packages: number; errors: string[]; loaded: string[]; functions: GotypesFn[]; calls: (GotypesCall & { pos: number })[]; parseFails: string[] };

/** Runs `gotypes` on the repo; each call gets its UTF-16 position. */
export async function runGotypes(bin: string, repo: string, fileList: string, texts: Map<string, string>, patterns: string[]): Promise<GotypesOut & { ms: number }> {
  const t = performance.now();
  const p = spawn([bin, repo, fileList, ...patterns], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`gotypes failed: ${err}`);
  const ms = Math.round(performance.now() - t);
  const data = JSON.parse(out) as GotypesOut;
  const conv = new Map<string, (b: number) => number>();
  for (const c of data.calls) {
    let f = conv.get(c.file);
    if (!f) {
      f = byteToUtf16(texts.get(c.file) ?? readFileSync(join(repo, c.file), "utf8"));
      conv.set(c.file, f);
    }
    c.pos = f(c.off);
  }
  return { ...data, ms };
}

/** go/types as a candidate: its answer for each call, by position. */
export function gotypesAnswers(data: GotypesOut & { ms: number }): Answers {
  const answers = new Map<string, Answer>();
  for (const c of data.calls) {
    const isType = c.kind === "conversion";
    let a: Answer;
    if (!c.decl) a = { kind: "none" };
    else if (!c.decl.inRepo) a = { kind: "outside", isType };
    else a = { kind: "decl", file: c.decl.file, line: c.decl.line, isType };
    answers.set(callKey(c.file, c.pos), a);
  }
  return { answers, ms: { start: data.loadMs, total: data.ms }, note: [`${data.errors.length} load errors`] };
}

// ---------------------------------------------------------------------------------------------
// gopls over LSP

/** A minimal LSP client over a child's stdio. */
class Lsp {
  private buf = Buffer.alloc(0);
  private next = 1;
  private waiting = new Map<number, (v: unknown) => void>();
  constructor(private proc: ReturnType<typeof spawn<{ stdin: "pipe"; stdout: "pipe"; stderr: "pipe" }>>) {
    void this.read();
  }
  private async read() {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      this.buf = Buffer.concat([this.buf, Buffer.from(value)]);
      for (;;) {
        const head = this.buf.indexOf("\r\n\r\n");
        if (head < 0) break;
        const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, head).toString())?.[1] ?? 0);
        if (this.buf.length < head + 4 + len) break;
        const msg = JSON.parse(this.buf.subarray(head + 4, head + 4 + len).toString()) as { id?: number; method?: string; result?: unknown; error?: unknown };
        this.buf = this.buf.subarray(head + 4 + len);
        if (msg.method !== undefined && msg.id !== undefined) this.send({ jsonrpc: "2.0", id: msg.id, result: null });
        else if (msg.id !== undefined) {
          const w = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          w?.(msg.error ? { error: msg.error } : msg.result);
        }
      }
    }
  }
  private send(msg: unknown) {
    const body = Buffer.from(JSON.stringify(msg));
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
    this.proc.stdin.flush();
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }
}

/** How many definition requests are in flight at once. */
const IN_FLIGHT = 32;

type Loc = { uri?: string; targetUri?: string; range?: { start: { line: number } }; targetSelectionRange?: { start: { line: number } } };

/** gopls as a candidate: textDocument/definition at each call's name. */
export async function goplsAnswers(bin: string, repo: string, calls: GoCall[]): Promise<Answers> {
  const root = resolve(repo);
  const t = performance.now();
  const proc = spawn([bin, "serve"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const lsp = new Lsp(proc);
  const uri = (f: string) => `file://${join(root, f)}`;
  await lsp.request("initialize", { processId: process.pid, rootUri: `file://${root}`, workspaceFolders: [{ uri: `file://${root}`, name: "repo" }], capabilities: {} });
  lsp.notify("initialized", {});
  const answers = new Map<string, Answer>();
  const note: string[] = [];
  const ask = async (c: GoCall): Promise<void> => {
    const r = (await lsp.request("textDocument/definition", { textDocument: { uri: uri(c.file) }, position: { line: c.line - 1, character: c.char } })) as Loc | Loc[] | null | { error: unknown };
    if (r && !Array.isArray(r) && "error" in r) {
      answers.set(callKey(c.file, c.pos), { kind: "none" });
      if (note.length < 5) note.push(`error at ${c.file}:${c.line}: ${JSON.stringify(r.error).slice(0, 160)}`);
      return;
    }
    const locs = (Array.isArray(r) ? r : r ? [r] : []) as Loc[];
    const loc = locs[0];
    if (!loc) {
      answers.set(callKey(c.file, c.pos), { kind: "none" });
      return;
    }
    const target = decodeURIComponent((loc.uri ?? loc.targetUri ?? "").replace(/^file:\/\//, ""));
    const ln = (loc.range ?? loc.targetSelectionRange)?.start.line ?? 0;
    const rel = relative(root, target);
    answers.set(callKey(c.file, c.pos), rel.startsWith("..") || rel.startsWith("/") ? { kind: "outside" } : { kind: "decl", file: rel, line: ln + 1 });
  };
  let start = 0;
  const first = calls[0];
  if (first) {
    await ask(first);
    start = Math.round(performance.now() - t);
  }
  let i = 1;
  const worker = async () => {
    while (i < calls.length) {
      const c = calls[i++];
      if (c) await ask(c);
    }
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
  const total = Math.round(performance.now() - t);
  await lsp.request("shutdown", null);
  lsp.notify("exit", null);
  proc.kill();
  return { answers, ms: { start, total }, note };
}

// ---------------------------------------------------------------------------------------------
// scip-go

/** A reader of protobuf's wire format, for the few SCIP fields read here. */
class Pb {
  i = 0;
  constructor(readonly b: Uint8Array) {}
  varint(): number {
    let r = 0;
    let s = 1;
    for (;;) {
      const x = this.b[this.i++] ?? 0;
      r += (x & 0x7f) * s;
      if (x < 0x80) return r;
      s *= 128;
    }
  }
  fields(cb: (field: number, wire: number, pb: Pb) => void, end = this.b.length) {
    while (this.i < end) {
      const tag = this.varint();
      const field = Math.floor(tag / 8);
      const wire = tag & 7;
      const before = this.i;
      cb(field, wire, this);
      if (this.i === before) this.skip(wire);
    }
  }
  bytes(): Uint8Array {
    const n = this.varint();
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.i += 8;
    else if (wire === 2) {
      // The length is read first: `this.i += this.varint()` would add it to the offset before the read.
      const n = this.varint();
      this.i += n;
    }
    else if (wire === 5) this.i += 4;
  }
}

type Occ = { line: number; char: number; symbol: string; def: boolean };
const DEFINITION_ROLE = 1;
/** The Occurrence fields SCIP 0.10 writes a range in, as a message, in place of the packed `range` (field 1). */
const SINGLE_LINE_RANGE = 8;
const MULTI_LINE_RANGE = 9;
/** SCIP's PositionEncoding: 1 is UTF-8 bytes, 2 UTF-16 code units, 3 UTF-32. */
const UTF8 = 1;
const UTF32 = 3;

/** The documents of a SCIP index: path, position encoding and occurrences. */
export function readScip(bytes: Uint8Array): { path: string; encoding: number; occs: Occ[] }[] {
  const dec = new TextDecoder();
  const docs: { path: string; encoding: number; occs: Occ[] }[] = [];
  new Pb(bytes).fields((f, w, pb) => {
    if (f !== 2 || w !== 2) return;
    const d = new Pb(pb.bytes());
    const doc = { path: "", encoding: 0, occs: [] as Occ[] };
    d.fields((g, gw, dpb) => {
      if (g === 1 && gw === 2) doc.path = dec.decode(dpb.bytes());
      else if (g === 6 && gw === 0) doc.encoding = dpb.varint();
      else if (g === 2 && gw === 2) {
        const o = new Pb(dpb.bytes());
        const occ = { line: 0, char: 0, symbol: "", def: false };
        const range: number[] = [];
        o.fields((h, hw, opb) => {
          if (h === 1 && hw === 2) {
            const r = new Pb(opb.bytes());
            while (r.i < r.b.length) range.push(r.varint());
          } else if (h === 1 && hw === 0) range.push(opb.varint());
          else if ((h === SINGLE_LINE_RANGE || h === MULTI_LINE_RANGE) && hw === 2 && range.length === 0) {
            // SCIP 0.10 writes the range as a message; both kinds start with 1 start line, 2 start character.
            const r = new Pb(opb.bytes());
            let ln = 0;
            let ch = 0;
            r.fields((k, kw, rpb) => {
              if (k === 1 && kw === 0) ln = rpb.varint();
              else if (k === 2 && kw === 0) ch = rpb.varint();
            });
            range.push(ln, ch);
          }
          else if (h === 2 && hw === 2) occ.symbol = dec.decode(opb.bytes());
          else if (h === 3 && hw === 0) occ.def = (opb.varint() & DEFINITION_ROLE) !== 0;
        });
        occ.line = range[0] ?? 0;
        occ.char = range[1] ?? 0;
        doc.occs.push(occ);
      }
    });
    docs.push(doc);
  });
  return docs;
}

/** A SCIP symbol whose last descriptor is a type (`Name#`). */
const isTypeSymbol = (s: string) => s.endsWith("#");

/** scip-go as a candidate: runs it, then reads the symbol at each call and where it is defined. */
export async function scipAnswers(bin: string, repo: string, module: string, out: string, calls: GoCall[], texts: Map<string, string>): Promise<Answers> {
  const t = performance.now();
  const p = spawn([bin, "index", "--quiet", "--output", out], { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  const total0 = Math.round(performance.now() - t);
  const note: string[] = [];
  if (code !== 0) note.push(`scip-go exited ${code}: ${err.slice(0, 300)}`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(out));
  } catch {
    return { answers: new Map(calls.map((c) => [callKey(c.file, c.pos), { kind: "none" } as Answer])), ms: { start: total0, total: total0 }, note: [...note, "no index written"] };
  }
  const docs = readScip(bytes);
  const defs = new Map<string, { file: string; line: number }>();
  const at = new Map<string, string>();
  for (const d of docs) {
    const lines = texts.get(d.path)?.split("\n");
    // The column of an occurrence, as a UTF-16 offset in its line.
    const col = (ln: number, ch: number): number => {
      if (lines === undefined || d.encoding !== UTF8) return ch;
      const lineText = lines[ln] ?? "";
      return Buffer.from(lineText, "utf8").subarray(0, ch).toString("utf8").length;
    };
    if (d.encoding === UTF32) note.push(`${d.path}: UTF-32 positions read as UTF-16`);
    for (const o of d.occs) {
      if (o.def && !o.symbol.startsWith("local ")) defs.set(o.symbol, { file: d.path, line: o.line + 1 });
      if (o.def && o.symbol.startsWith("local ")) defs.set(`${d.path} ${o.symbol}`, { file: d.path, line: o.line + 1 });
      at.set(`${d.path}:${o.line}:${col(o.line, o.char)}`, o.symbol);
    }
  }
  const answers = new Map<string, Answer>();
  for (const c of calls) {
    const sym = at.get(`${c.file}:${c.line - 1}:${c.char}`);
    let a: Answer;
    if (sym === undefined) a = { kind: "none" };
    else if (sym.startsWith("local ")) {
      const d = defs.get(`${c.file} ${sym}`);
      a = d ? { kind: "decl", ...d } : { kind: "none" };
    } else {
      const d = defs.get(sym);
      // A global symbol is `<scheme> <manager> <package> <version> <descriptors>`; with no
      // definition in the index, it is outside only when its package is not the repo's module.
      const pkg = sym.split(" ")[2] ?? "";
      if (d) a = { kind: "decl", ...d, isType: isTypeSymbol(sym) };
      else a = pkg === module ? { kind: "none" } : { kind: "outside", isType: isTypeSymbol(sym) };
    }
    answers.set(callKey(c.file, c.pos), a);
  }
  return { answers, ms: { start: total0, total: Math.round(performance.now() - t) }, note: [...note, `${docs.length} documents`] };
}
