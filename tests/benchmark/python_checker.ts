// The benchmark's type checker for Python's links (trustmybot/tmb#399): pyright, asked through its
// own language server for the declarations of the name written at a place, the question an editor
// asks with "go to definition". It is tmb's pinned copy of pyright, the one way B loads, installed
// into the tools folder by the test setup (tests/lib/pinned-tools.ts) and found by the find order;
// this file runs that copy's own language server. Nothing of the graph's way B is used, so the
// reference is pyright's own answer, not tmb's reading of it.
//
// The server reads the repo's files as this file opens them, from the commit, and the project's
// config from the working tree, which is at the commit. It is set up as way B sets pyright up: it
// looks for a `src` layout, and it runs no Python, so with no environment named it reads no
// installed package and a call into one has no answer. A place it gives no declaration for has no
// answer, and is never guessed.
import type { FileSink } from "bun";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { PYRIGHT_PIN, pyright } from "../../src/engine/graph/languages/python/tool.ts";
import { findCopy, machinePlaces } from "../../src/engine/graph/tool-copy.ts";
import { installPinnedTools } from "../lib/pinned-tools.ts";

/** The version of pyright the reference asks: tmb's pin. */
export const CHECKER_VERSION: string = PYRIGHT_PIN.version;
/** The language server's entry file, in pyright's package. */
const SERVER_ENTRY = "langserver.index.js";

/** The language server of tmb's pinned copy of pyright, installed first if the tools folder has none. */
async function server(): Promise<string> {
  await installPinnedTools();
  const found = findCopy(pyright.copy, machinePlaces());
  if ("missing" in found) throw new Error(`the Python reference has no pyright: ${found.missing}`);
  if (found.version !== CHECKER_VERSION) throw new Error(`the Python reference found pyright ${found.version}, not ${CHECKER_VERSION}`);
  const entry = path.join(found.path, SERVER_ENTRY);
  if (!existsSync(entry)) throw new Error(`the Python reference's pyright at ${found.path} has no ${SERVER_ENTRY}`);
  return entry;
}

/** A place in a file as the language server counts it: a line from 0 and a character, in UTF-16 units, from 0. */
export type LspPosition = { line: number; character: number };
/** A declaration pyright names: its file, as an absolute path, and the range of its name. */
export type Declaration = { file: string; start: LspPosition; end: LspPosition };

/**
 * An interpreter that is not there. pyright runs the configured Python to find its installed
 * packages; this one cannot run, so pyright reads none and runs nothing, as way B runs nothing.
 */
const NO_INTERPRETER = "/nonexistent/tmb-benchmark/python";

/** The settings the server asks for, by section. `autoSearchPaths` looks for a `src` layout, as way B does. */
const SETTINGS: Record<string, unknown> = {
  python: { pythonPath: NO_INTERPRETER },
  "python.analysis": { autoSearchPaths: true, diagnosticMode: "openFilesOnly", logLevel: "Error" },
  pyright: {},
};

/** How many questions are in flight at once: the server answers them in order, and a reply is only waited for in batches. */
const BATCH = 500;

type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };

/** A JSON-RPC client over the server's standard input and output, framed as the Language Server Protocol frames it. */
class Client {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = Buffer.alloc(0);
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly stdin: FileSink;
  private exited = false;

  constructor(serverEntry: string, cwd: string) {
    this.proc = Bun.spawn([process.execPath, serverEntry, "--stdio"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.stdin = this.proc.stdin as FileSink;
    void this.read();
    void this.proc.exited.then(() => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new Error("pyright's language server exited"));
      this.pending.clear();
    });
  }

  private async read(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      this.buffer = Buffer.concat([this.buffer, Buffer.from(value)]);
      for (;;) {
        const head = this.buffer.indexOf("\r\n\r\n");
        if (head < 0) break;
        const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, head).toString("ascii"))?.[1] ?? NaN);
        if (Number.isNaN(length)) throw new Error("pyright's language server sent a message with no length");
        if (this.buffer.length < head + 4 + length) break;
        const body = JSON.parse(this.buffer.subarray(head + 4, head + 4 + length).toString("utf8")) as Message;
        this.buffer = this.buffer.subarray(head + 4 + length);
        this.receive(body);
      }
    }
  }

  private receive(m: Message): void {
    if (m.method !== undefined && m.id !== undefined) {
      // A request from the server: the settings it asks for, by section; anything else is acknowledged.
      const result = m.method === "workspace/configuration" ? ((m.params as { items: { section?: string }[] }).items ?? []).map((i) => SETTINGS[i.section ?? ""] ?? null) : null;
      this.send({ id: m.id, result });
      return;
    }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (p === undefined) return;
    this.pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }

  private send(m: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m }), "utf8");
    this.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.stdin.write(body);
    this.stdin.flush();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("pyright's language server exited"));
    const id = this.next++;
    const done = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ id, method, params });
    return done;
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  async close(): Promise<void> {
    if (!this.exited) {
      try {
        await this.request("shutdown", null);
        this.notify("exit", null);
      } catch {
        // It has gone already.
      }
    }
    const killed = setTimeout(() => this.proc.kill(), 5_000);
    await this.proc.exited;
    clearTimeout(killed);
  }
}

type Location = { uri: string; range: { start: LspPosition; end: LspPosition } };
type LocationLink = { targetUri: string; targetSelectionRange: { start: LspPosition; end: LspPosition } };

/**
 * pyright's declarations for the name written at each place asked, in order: null when it names
 * none. `files` are the repo's Python files at the commit, by path from `root`, each opened with
 * its text; `asked` are the places, a file and a position.
 */
export async function checkerDeclarations(root: string, files: ReadonlyMap<string, string>, asked: readonly { file: string; at: LspPosition }[]): Promise<(Declaration[] | null)[]> {
  const rootDir = path.resolve(root);
  const client = new Client(await server(), rootDir);
  const uriOf = (file: string) => pathToFileURL(path.join(rootDir, file)).href;
  try {
    const rootUri = pathToFileURL(rootDir).href;
    await client.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(rootDir) }],
      // No `declaration` capability: pyright then answers a definition with every declaration
      // (DefinitionFilter.All), as way B asks it.
      capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: { definition: { linkSupport: false } } },
    });
    client.notify("initialized", {});
    for (const [file, text] of files) client.notify("textDocument/didOpen", { textDocument: { uri: uriOf(file), languageId: "python", version: 1, text } });
    const out: (Declaration[] | null)[] = [];
    for (let i = 0; i < asked.length; i += BATCH) {
      const answers = await Promise.all(
        asked.slice(i, i + BATCH).map((q) => client.request("textDocument/definition", { textDocument: { uri: uriOf(q.file) }, position: q.at }) as Promise<Location | Location[] | LocationLink[] | null>),
      );
      for (const a of answers) {
        const list = a === null ? [] : Array.isArray(a) ? a : [a];
        const decls = list.map((l): Declaration => {
          const uri = "targetUri" in l ? l.targetUri : l.uri;
          const range = "targetUri" in l ? l.targetSelectionRange : l.range;
          return { file: uri.startsWith("file:") ? fileURLToPath(uri) : uri, start: range.start, end: range.end };
        });
        out.push(decls.length === 0 ? null : decls);
      }
    }
    return out;
  } finally {
    await client.close();
  }
}
