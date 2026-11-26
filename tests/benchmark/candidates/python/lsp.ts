// A small Language Server Protocol client for the Python way B A/B test (trustmybot/tmb#338).
// It asks a language server one question, `textDocument/definition`, at the place where each
// call's name is written, and returns the server's answer as it gave it: nothing is resolved
// here. Positions are UTF-16 code units, as the protocol's default and as the graph records them.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** A declaration the server names: its file (absolute), and the range of its name, 0-based. */
export type Declared = { file: string; line: number; character: number; endLine: number; endCharacter: number };

/** One question: the file (relative to the root) and the 0-based line and UTF-16 character. */
export type Question = { file: string; line: number; character: number };

/** The answer to one question: the declarations, or why there is none. */
export type Answer = { decls: Declared[] } | { error: string };

/** How a server is started and what it is told. */
export type ServerSpec = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** The settings returned to `workspace/configuration`, by section; a section not named gets null. */
  settings?: Record<string, unknown>;
  initializationOptions?: unknown;
  /** How many questions are in flight at once. */
  inFlight?: number;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** One running server. */
class Client {
  private proc: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private settings: Record<string, unknown>;
  stderr = "";

  constructor(spec: ServerSpec, cwd: string) {
    this.settings = spec.settings ?? {};
    this.proc = spawn(spec.command, spec.args, { cwd, env: { ...process.env, ...spec.env } });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < 20_000) this.stderr += chunk.toString();
    });
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`server exited (${code}): ${this.stderr.slice(-2000)}`));
      this.pending.clear();
    });
  }

  private send(msg: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const m = /Content-Length: *(\d+)/i.exec(this.buf.subarray(0, head).toString());
      if (m === null) throw new Error("bad header from server");
      const len = Number(m[1]);
      if (this.buf.length < head + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(head + 4, head + 4 + len).toString("utf8")) as {
        id?: number | string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message: string };
      };
      this.buf = this.buf.subarray(head + 4 + len);
      this.onMessage(msg);
    }
  }

  private onMessage(msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
    if (msg.method !== undefined && msg.id !== undefined) {
      // A request from the server.
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const items = (msg.params as { items: { section?: string }[] }).items;
        result = items.map((i) => (i.section !== undefined && i.section in this.settings ? this.settings[i.section] : null));
      }
      this.send({ id: msg.id, result });
      return;
    }
    if (msg.method !== undefined) return; // a notification
    const p = this.pending.get(msg.id as number);
    if (p === undefined) return;
    this.pending.delete(msg.id as number);
    if (msg.error !== undefined) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  kill(): void {
    this.proc.kill("SIGKILL");
  }
}

type Range = { start: { line: number; character: number }; end: { line: number; character: number } };
type Location = { uri: string; range: Range };
type LocationLink = { targetUri: string; targetRange: Range; targetSelectionRange: Range };

/** The declarations a definition result names, the name's range of each. */
function declsOf(result: unknown): Declared[] {
  if (result === null || result === undefined) return [];
  const list = (Array.isArray(result) ? result : [result]) as (Location | LocationLink)[];
  return list.map((l) => {
    const [uri, r] = "targetUri" in l ? [l.targetUri, l.targetSelectionRange] : [l.uri, l.range];
    return { file: fileURLToPath(uri), line: r.start.line, character: r.start.character, endLine: r.end.line, endCharacter: r.end.character };
  });
}

/** The time each step took, in milliseconds. */
export type Timing = { startMs: number; answerMs: number };

/**
 * Starts the server on `root`, asks every question, and stops it. Questions are asked file by
 * file: each file is opened, its questions asked, and closed.
 */
export async function askDefinitions(spec: ServerSpec, root: string, questions: readonly Question[]): Promise<{ answers: Answer[]; timing: Timing; stderr: string; server: unknown }> {
  const t0 = performance.now();
  const client = new Client(spec, root);
  const rootUri = pathToFileURL(root).href;
  const init = (await client.request("initialize", {
    processId: process.pid,
    rootUri,
    rootPath: root,
    workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
    initializationOptions: spec.initializationOptions ?? null,
    capabilities: {
      workspace: { configuration: true, workspaceFolders: true },
      textDocument: { definition: { linkSupport: true }, synchronization: { didSave: false } },
      general: { positionEncodings: ["utf-16"] },
    },
  })) as { serverInfo?: unknown };
  client.notify("initialized", {});
  client.notify("workspace/didChangeConfiguration", { settings: spec.settings ?? {} });
  const startMs = Math.round(performance.now() - t0);

  const t1 = performance.now();
  const answers: Answer[] = new Array(questions.length);
  const byFile = new Map<string, number[]>();
  questions.forEach((q, i) => byFile.set(q.file, [...(byFile.get(q.file) ?? []), i]));
  const inFlight = spec.inFlight ?? 64;
  try {
    for (const [file, indexes] of byFile) {
      const abs = path.join(root, file);
      const uri = pathToFileURL(abs).href;
      client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "python", version: 1, text: readFileSync(abs, "utf8") } });
      for (let i = 0; i < indexes.length; i += inFlight) {
        await Promise.all(
          indexes.slice(i, i + inFlight).map(async (qi) => {
            const q = questions[qi]!;
            try {
              const result = await client.request("textDocument/definition", { textDocument: { uri }, position: { line: q.line, character: q.character } });
              answers[qi] = { decls: declsOf(result) };
            } catch (error) {
              answers[qi] = { error: error instanceof Error ? error.message : String(error) };
            }
          }),
        );
      }
      client.notify("textDocument/didClose", { textDocument: { uri } });
    }
    const answerMs = Math.round(performance.now() - t1);
    try {
      await Promise.race([client.request("shutdown", null), new Promise((r) => setTimeout(r, 5000))]);
    } catch {
      // A server that fails to shut down is stopped below.
    }
    return { answers, timing: { startMs, answerMs }, stderr: client.stderr, server: init.serverInfo ?? null };
  } finally {
    client.kill();
  }
}
