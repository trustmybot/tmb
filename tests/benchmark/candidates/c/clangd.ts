// Candidate: clangd, LLVM's language server for C and C++, asked over LSP for the definition of
// the name each call is written at (textDocument/definition). With a compile database, clangd
// first builds its background index of the whole project, so a definition in another unit is
// found; with none, it reads each file alone with its default flags.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { callKey, type Answers, type Decl, type GraphCall } from "./lib.ts";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** The few LSP messages the harness needs, framed with Content-Length. */
class Lsp {
  private buf = Buffer.alloc(0);
  private id = 0;
  private pending = new Map<number, Pending>();
  onNotify: (method: string, params: any) => void = () => {};
  constructor(private proc: ReturnType<typeof spawn>) {
    proc.stdout!.on("data", (d: Buffer) => this.read(d));
  }
  private read(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const head = this.buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, head).toString())?.[1]);
      if (this.buf.length < head + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(head + 4, head + 4 + len).toString("utf8"));
      this.buf = this.buf.subarray(head + 4 + len);
      if (msg.id !== undefined && msg.method !== undefined) this.send({ jsonrpc: "2.0", id: msg.id, result: null });
      else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) this.onNotify(msg.method, msg.params);
    }
  }
  private send(msg: unknown) {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.proc.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin!.write(body);
  }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }
}

export type ClangdOptions = {
  binary: string;
  root: string;
  /** The folder holding compile_commands.json, or null to run with none. clangd keeps its index under it. */
  cdbDir: string | null;
  language: "c" | "cpp";
  /** Most milliseconds to wait for the background index. */
  indexTimeoutMs: number;
  /** Files asked at once. */
  parallelFiles: number;
  /**
   * The source files the database compiles, by path from the root. When given, these and the headers
   * are asked first, and the other files (another platform's, say) only after them: clangd indexes
   * an open file, so while one is open its definitions can answer a call asked in any other file.
   */
  databaseFiles?: ReadonlySet<string>;
};

export type ClangdRun = { answers: Answers; startMs: number; indexMs: number; askMs: number; version: string };

const LANGUAGE_ID = { c: "c", cpp: "cpp" } as const;

/** Each call's definitions as clangd gives them. */
export async function clangdAnswers(opts: ClangdOptions, calls: readonly GraphCall[]): Promise<ClangdRun> {
  const t0 = performance.now();
  const args = ["--log=error", "--enable-config=0", "--pch-storage=memory", "-j=8"];
  if (opts.cdbDir !== null) args.push(`--compile-commands-dir=${opts.cdbDir}`, "--background-index");
  else args.push("--background-index=false");
  const proc = spawn(opts.binary, args, { stdio: ["pipe", "pipe", "ignore"] });
  const lsp = new Lsp(proc);
  let indexDone: () => void = () => {};
  const indexed = new Promise<void>((r) => (indexDone = r));
  let indexing = false;
  lsp.onNotify = (method, params) => {
    if (method === "$/progress" && params?.token === "backgroundIndexProgress") {
      if (params.value?.kind === "begin") indexing = true;
      if (params.value?.kind === "end") indexDone();
    }
  };
  const init = await lsp.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(opts.root).href,
    capabilities: { offsetEncoding: ["utf-8"], window: { workDoneProgress: true }, general: { positionEncodings: ["utf-8"] }, textDocument: { definition: { linkSupport: false } } },
    initializationOptions: {},
  });
  if (init?.capabilities?.positionEncoding !== "utf-8" && init?.offsetEncoding !== "utf-8") throw new Error("clangd did not agree to UTF-8 positions");
  lsp.notify("initialized", {});
  const startMs = performance.now() - t0;

  const byFile = new Map<string, GraphCall[]>();
  for (const c of calls) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const inDatabase = (f: string) => opts.databaseFiles === undefined || opts.databaseFiles.has(f) || !/\.(c|cc|cpp|cxx)$/.test(f);
  const first = [...byFile.keys()].filter(inDatabase);
  const later = [...byFile.keys()].filter((f) => !inDatabase(f));

  const t1 = performance.now();
  if (opts.cdbDir !== null) {
    // The background index starts once a file is opened; open the first, then wait for its end.
    const opened = first[0] ?? later[0];
    if (opened !== undefined) open(lsp, opts, opened);
    const timeout = new Promise<void>((r) => setTimeout(r, opts.indexTimeoutMs));
    await Promise.race([indexed, timeout]);
    if (!indexing) process.stderr.write("clangd: background index never reported progress\n");
    if (opened !== undefined) lsp.notify("textDocument/didClose", { textDocument: { uri: uriOf(opts.root, opened) } });
  }
  const indexMs = performance.now() - t1;

  const t2 = performance.now();
  const answers: Answers = new Map();
  let files: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++]!;
      open(lsp, opts, file);
      const uri = uriOf(opts.root, file);
      await Promise.all(
        byFile.get(file)!.map(async (c) => {
          const res = await lsp.request("textDocument/definition", { textDocument: { uri }, position: { line: c.line - 1, character: c.col - 1 } }).catch(() => null);
          answers.set(callKey(c.file, c.line, c.col), toDecls(opts.root, res));
        }),
      );
      lsp.notify("textDocument/didClose", { textDocument: { uri } });
    }
  };
  for (const group of [first, later]) {
    files = group;
    next = 0;
    await Promise.all(Array.from({ length: opts.parallelFiles }, worker));
  }
  const askMs = performance.now() - t2;
  await lsp.request("shutdown", null).catch(() => null);
  lsp.notify("exit", null);
  proc.kill();
  return { answers, startMs, indexMs, askMs, version: init?.serverInfo?.version ?? "" };
}

const uriOf = (root: string, file: string) => pathToFileURL(path.join(root, file)).href;

function open(lsp: Lsp, opts: ClangdOptions, file: string) {
  lsp.notify("textDocument/didOpen", { textDocument: { uri: uriOf(opts.root, file), languageId: LANGUAGE_ID[opts.language], version: 1, text: readFileSync(path.join(opts.root, file), "utf8") } });
}

/** An LSP definition result as declarations: in the repo by relative path and lines, else outside. */
function toDecls(root: string, res: unknown): Decl[] {
  const list = res === null || res === undefined ? [] : Array.isArray(res) ? res : [res];
  const prefix = path.resolve(root) + path.sep;
  return list.map((loc: any) => {
    const uri: string = loc.uri ?? loc.targetUri;
    const range = loc.range ?? loc.targetSelectionRange;
    const file = fileURLToPath(uri);
    if (!file.startsWith(prefix)) return { outside: file };
    return { file: file.slice(prefix.length), start: range.start.line + 1, end: range.end.line + 1 };
  });
}
