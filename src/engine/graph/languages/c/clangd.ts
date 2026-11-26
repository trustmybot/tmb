// Way B for C and C++ (trustmybot/tmb#355): clangd, the user's own, makes the links of the graph's
// calls. It asks the compiler; it does not imitate it. C and C++ share it: one run reads both, and a
// file's language is what the compile database's command for it says, not its ending.
//
// clangd reads the repo as the project's compile database says (CODE_GRAPH.md, "C and C++ without
// the project's compile database"): `compile_commands.json` at the repo's root, else in `build/`,
// where clangd looks for it beside the code. With none, or a partial one, way B does not run: an
// entry that is not one clangd can read, or one whose file is not on disk, is a database the
// project did not finish, and clangd would guess the commands it lacks.
//
// Which files are asked: each file the database compiles, first, with its own command; then each
// header those files include, which clangd reads with the command of a file that includes it. A
// file of neither kind, such as another platform's source, gets no command from the database, so
// clangd would guess one, and its calls are not known.
//
// For each call the built-in parser found, clangd is asked which symbol the name at the call's
// position refers to, from its syntax tree alone (its `textDocument/symbolInfo`, which never
// guesses by text). Inside a macro, the parser cannot see what the macro makes of its input, so
// clangd's answer is all there is: a name it does not answer is not known. The symbol is:
// - linked, when its definition, else its declaration, is in the repo and one node of the graph fits
//   it by place: of its name, in its file, the innermost over its line. A construction, which names
//   a class, links to the class: clangd answers a class name, or a constructor, whose class is the
//   outermost node of the name around the constructor's declaration (C++ [class.ctor]: a
//   constructor is named by its class's name);
// - outside, when it is declared and defined outside the repo: the system's headers;
// - not known, otherwise: no answer, more than one symbol, an answer for a name other than the
//   call's, a declaration with no node (a function the repo declares and never defines), or an
//   error clangd reports at the call ("An answer given on an error is no answer").
//
// clangd runs with no background index, so it writes nothing into the repo, and with no
// `--query-driver`, so it runs no compiler of the repo's. Without `clangd` on PATH, way B for C and
// C++ cannot run, and the built-in rules make the links.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { LanguageTool, OpenedTool, ToolAnswer, ToolInput } from "../contract.ts";

const NOT_KNOWN: ToolAnswer = { state: "not_known" };
const OUTSIDE: ToolAnswer = { state: "outside" };

/** Where clangd looks for the project's compile database beside the code: the folder, then its `build/`. */
export const DATABASE_PLACES = ["compile_commands.json", "build/compile_commands.json"] as const;

/** clangd's flags: no index written to disk, no driver of the repo run, no checks beside the compiler's. */
const CLANGD_FLAGS = ["--background-index=false", "--clang-tidy=false", "--header-insertion=never", "--pch-storage=memory", "--log=error"];

/** The longest one file's answers may take, in milliseconds. */
const FILE_TIMEOUT_MS = 300_000;

/** One entry of the database, as clangd reads it (JSON Compilation Database). */
type DatabaseEntry = { directory: string; file: string; arguments?: string[]; command?: string };

/** The language a command compiles its file in. */
export type Dialect = "c" | "cpp";

/** The database's files in the repo, by path, with the language each one's command says. */
export type Database = { folder: string; files: Map<string, Dialect> };

/** Splits a shell command line the way the database's `command` is written (POSIX shell words). */
export function shellWords(command: string): string[] {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? command.length : end;
      inWord = true;
    } else if (ch === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) i++;
        word += command[i++];
      }
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(word);
  return out;
}

/** The C++ endings clang's driver compiles as C++ (clang's types.def): the rest it compiles as C. */
const CPP_ENDINGS = new Set(["cc", "cp", "cxx", "cpp", "c++", "cppm", "ixx", "hh", "hpp", "hxx", "h++", "C", "CC", "CPP", "CXX", "C++", "ii", "mm", "M"]);

/** The language a command compiles its file in (clang's driver): the last `-x` before it, else a C++ driver (`clang++`, `g++`, `c++`), else the ending. */
export function dialectOf(argv: readonly string[], file: string): Dialect {
  let x: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-x" && i + 1 < argv.length) x = argv[++i];
    else if (a.startsWith("-x") && a.length > 2) x = a.slice(2);
  }
  if (x !== undefined) return x.startsWith("c++") || x.startsWith("objective-c++") ? "cpp" : "c";
  const driver = path.basename(argv[0] ?? "");
  if (/\+\+/.test(driver) || argv.includes("--driver-mode=g++")) return "cpp";
  const ending = file.slice(file.lastIndexOf(".") + 1);
  return CPP_ENDINGS.has(ending) ? "cpp" : "c";
}

/**
 * The project's compile database for the repo, or why there is none to use: none at its places, or
 * a partial one, whose entries clangd cannot all read or whose files are not all on disk.
 */
export function findDatabase(repoDir: string): Database | { unavailable: string } {
  const root = realpathSync(repoDir);
  const place = DATABASE_PLACES.find((p) => existsSync(path.join(root, p)));
  if (place === undefined) return { unavailable: `no compile database: no ${DATABASE_PLACES.join(" or ")} in the repo` };
  const file = path.join(root, place);
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { unavailable: `the compile database ${place} is partial: it is not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!Array.isArray(entries) || entries.length === 0) return { unavailable: `the compile database ${place} is partial: it holds no entry` };
  const files = new Map<string, Dialect>();
  for (const [i, raw] of entries.entries()) {
    const e = raw as Partial<DatabaseEntry>;
    const argv = Array.isArray(e.arguments) ? e.arguments : typeof e.command === "string" ? shellWords(e.command) : undefined;
    if (typeof e.directory !== "string" || typeof e.file !== "string" || argv === undefined || argv.length === 0) {
      return { unavailable: `the compile database ${place} is partial: entry ${i + 1} has no directory, file and command` };
    }
    const abs = path.resolve(e.directory, e.file);
    if (!existsSync(abs)) return { unavailable: `the compile database ${place} is partial: entry ${i + 1} names ${e.file}, which is not on disk` };
    const real = realpathSync(abs);
    const rel = path.relative(root, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const key = rel.split(path.sep).join("/");
    if (!files.has(key)) files.set(key, dialectOf(argv, real));
  }
  return { folder: path.dirname(file), files };
}

/** Whether the `clangd` on PATH runs, or why not. */
function clangdOnPath(): true | { unavailable: string } {
  const run = spawnSync("clangd", ["--version"], { encoding: "utf8" });
  if (run.error !== undefined) return { unavailable: "no `clangd` on PATH" };
  if (run.status !== 0) return { unavailable: `\`clangd --version\` failed: ${run.stderr.trim()}` };
  return true;
}

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Location = { uri: string; range: Range };
type Diagnostic = { range: Range; severity?: number };
/** clangd's `textDocument/symbolInfo` answer for one symbol. */
export type SymbolDetails = { name: string; containerName?: string; usr?: string; declarationRange?: Location; definitionRange?: Location };

/** A language server's connection over its standard input and output (the LSP base protocol). */
class Connection {
  private buffer = Buffer.alloc(0);
  private next = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private waiting = new Map<string, () => void>();
  private failed: Error | null = null;
  private readonly child;

  constructor(folder: string, cwd: string) {
    this.child = spawn("clangd", [`--compile-commands-dir=${folder}`, ...CLANGD_FLAGS], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdout.on("data", (data: Buffer) => this.read(data));
    const fail = (error: Error) => {
      this.failed = error;
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      for (const w of this.waiting.values()) w();
    };
    this.child.on("error", fail);
    this.child.on("exit", (code, signal) => fail(new Error(`clangd stopped (${signal ?? code})`)));
  }

  private read(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const head = this.buffer.indexOf("\r\n\r\n");
      if (head < 0) return;
      const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, head).toString("ascii"))?.[1] ?? NaN);
      if (Number.isNaN(length) || this.buffer.length < head + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(head + 4, head + 4 + length).toString("utf8")) as {
        id?: number;
        method?: string;
        params?: { uri: string; diagnostics: Diagnostic[] };
        result?: unknown;
        error?: { message: string };
      };
      this.buffer = this.buffer.subarray(head + 4 + length);
      if (message.method === undefined && message.id !== undefined) {
        const p = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) p?.reject(new Error(message.error.message));
        else p?.resolve(message.result ?? null);
      } else if (message.method === "textDocument/publishDiagnostics" && message.params) {
        this.diagnostics.set(message.params.uri, message.params.diagnostics);
        this.waiting.get(message.params.uri)?.();
      } else if (message.method !== undefined && message.id !== undefined) {
        // A request from clangd, such as one for its work-done progress: answered with nothing.
        this.send({ id: message.id, result: null });
      }
    }
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  request<T>(method: string, params: object): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: object): void {
    this.send({ method, params });
  }

  /** Opens a file with its text, and waits for clangd's diagnostics for it, which come once its syntax tree is built. */
  async open(uri: string, languageId: string, text: string): Promise<Diagnostic[]> {
    this.diagnostics.delete(uri);
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`clangd gave no answer for ${fileURLToPath(uri)} in ${FILE_TIMEOUT_MS / 1000}s`)), FILE_TIMEOUT_MS);
      this.waiting.set(uri, () => {
        clearTimeout(timer);
        this.waiting.delete(uri);
        if (this.failed) reject(this.failed);
        else resolve();
      });
    });
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    await done;
    return this.diagnostics.get(uri) ?? [];
  }

  async close(): Promise<void> {
    if (!this.failed) {
      try {
        await this.request("shutdown", {});
        this.notify("exit", {});
      } catch {
        // Stopped already.
      }
    }
    this.child.kill();
  }
}

/** A UTF-16 offset in a text as an LSP position: its line and its UTF-16 column, both from 0. */
export function positionAt(text: string, offset: number): Position {
  let line = 0;
  let start = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, character: offset - start };
}

/** Whether an error clangd reports is at the call: its range holds the call's name, or starts on its line. */
function errorAt(errors: readonly Diagnostic[], at: Position): boolean {
  const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  return errors.some((d) => d.range.start.line === at.line || (before(d.range.start, at) && before(at, d.range.end)));
}

type Place = { index: number; name: string; start: number; end: number };

/** The repo's path of a URI clangd gives, or null outside the repo. */
function repoPath(root: string, uri: string): string | null {
  let file = fileURLToPath(uri);
  try {
    file = realpathSync(file);
  } catch {
    // A file that is gone: its path as given.
  }
  const rel = path.relative(root, file);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/");
}

/** The last part of a qualified C++ name, `a::b::` or `a::b`, or "" for none. */
const lastPart = (container: string | undefined): string => (container ?? "").replace(/::$/, "").split("::").at(-1) ?? "";

/**
 * The answer for one call from clangd's symbol at its position (see the head of the file): `nodes`
 * are the graph's nodes by file.
 */
export function answerOf(root: string, nodes: ReadonlyMap<string, Place[]>, name: string, symbols: readonly SymbolDetails[] | null, definitions: readonly Location[] | null): ToolAnswer {
  // A using-declaration names the declarations it brings in (C++ [namespace.udecl]): clangd gives
  // both, and the call goes to what it names. clang's USR marks one with `@UD@`.
  const named = (symbols ?? []).filter((s) => !s.usr?.includes("@UD@"));
  if (named.length !== 1) return NOT_KNOWN;
  const s = named[0]!;
  if (s.name !== name) return NOT_KNOWN;
  const constructor = lastPart(s.containerName) === s.name;
  const definition = definitions?.length === 1 ? definitions[0] : s.definitionRange;
  const where = constructor ? s.declarationRange : (definition ?? s.declarationRange);
  if (where === undefined) return NOT_KNOWN;
  const file = repoPath(root, where.uri);
  if (file === null) {
    // Declared outside the repo: outside, unless the repo defines it.
    const def = definition === undefined ? null : repoPath(root, definition.uri);
    return def === null ? OUTSIDE : NOT_KNOWN;
  }
  const line = where.range.start.line + 1;
  const fit = (nodes.get(file) ?? []).filter((n) => n.name === s.name && n.start <= line && n.end >= line);
  if (fit.length === 0) return NOT_KNOWN;
  const sizes = fit.map((n) => n.end - n.start);
  const pick = constructor ? Math.max(...sizes) : Math.min(...sizes);
  const chosen = fit.filter((n) => n.end - n.start === pick);
  return chosen.length === 1 ? { nodes: [chosen[0]!.index] } : NOT_KNOWN;
}

/** The files to ask, in order: the database's own, then the headers they include, as clangd resolves each `#include`. */
async function filesToAsk(conn: Connection, root: string, database: Database, input: ToolInput, opened: Map<string, Diagnostic[]>): Promise<string[]> {
  const order: string[] = [];
  const queue = [...database.files.keys()].filter((f) => input.files.has(f)).sort();
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.shift()!;
    const uri = pathToFileURL(path.join(root, file)).href;
    const dialect = database.files.get(file);
    opened.set(file, (await conn.open(uri, dialect === "cpp" ? "cpp" : "c", input.files.get(file)!)).filter((d) => d.severity === 1));
    order.push(file);
    const links = (await conn.request<{ target?: string }[] | null>("textDocument/documentLink", { textDocument: { uri } })) ?? [];
    for (const link of links) {
      if (link.target === undefined) continue;
      const included = repoPath(root, link.target);
      if (included === null || seen.has(included) || !input.files.has(included)) continue;
      seen.add(included);
      queue.push(included);
    }
  }
  return order;
}

/** Asks clangd about every call of the files it can read by the database; the rest are not known. */
export async function answerCalls(repoDir: string, database: Database, input: ToolInput, note: (text: string) => void): Promise<ToolAnswer[]> {
  const root = realpathSync(repoDir);
  const nodes = new Map<string, Place[]>();
  input.nodes.forEach((node, index) => {
    const here = nodes.get(node.path) ?? [];
    here.push({ index, name: node.name, start: node.start, end: node.end });
    nodes.set(node.path, here);
  });
  const answers: ToolAnswer[] = input.calls.map(() => NOT_KNOWN);
  const conn = new Connection(database.folder, root);
  try {
    await conn.request("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: { textDocument: { publishDiagnostics: {} } } });
    conn.notify("initialized", {});
    const errors = new Map<string, Diagnostic[]>();
    // Every file is opened before any is asked, so a definition in one is known to a call in another.
    const asked = await filesToAsk(conn, root, database, input, errors);
    const callsOf = new Map<string, number[]>();
    input.calls.forEach((call, i) => callsOf.set(call.path, [...(callsOf.get(call.path) ?? []), i]));
    for (const file of asked) {
      const uri = pathToFileURL(path.join(root, file)).href;
      const text = input.files.get(file)!;
      const fileErrors = errors.get(file) ?? [];
      await Promise.all(
        (callsOf.get(file) ?? []).map(async (i) => {
          const call = input.calls[i]!;
          const at = positionAt(text, call.pos);
          if (errorAt(fileErrors, at)) return;
          const where = { textDocument: { uri }, position: at };
          const [symbols, definitions] = await Promise.all([
            conn.request<SymbolDetails[] | null>("textDocument/symbolInfo", where),
            conn.request<Location[] | null>("textDocument/definition", where),
          ]);
          answers[i] = answerOf(root, nodes, call.name, symbols, definitions);
        }),
      );
    }
    const unasked = new Set(input.calls.map((c) => c.path).filter((f) => !asked.includes(f)));
    if (unasked.size > 0) note(`${unasked.size} file${unasked.size === 1 ? "" : "s"} the compile database neither compiles nor includes, whose calls are not known`);
  } finally {
    await conn.close();
  }
  return answers;
}

/** clangd, way B's tool for C and C++. */
export const clangdTool: LanguageTool = {
  name: "clangd",
  open(repoDir: string): OpenedTool {
    const clangd = clangdOnPath();
    if (clangd !== true) return clangd;
    const database = findDatabase(repoDir);
    if ("unavailable" in database) return database;
    return { answer: (input, note) => answerCalls(repoDir, database, input, note) };
  },
};
