// Packaging probe (trustmybot/tmb#2): proves one `bun build --compile` file can,
// with no network, run SQLite FTS5, parse TypeScript with an embedded tree-sitter
// grammar, and answer a stdio MCP tool call.
//   probe [all]   run every check, print one line each, then `PROBE OK`
//   probe fts     FTS5 check only
//   probe parse   tree-sitter check only
//   probe serve   stdio MCP server (newline-delimited JSON-RPC 2.0)
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { Language, Parser, type Node } from "web-tree-sitter";
// `with { type: "file" }` makes `bun build --compile` embed both WASM files in the
// binary; at run time these resolve to the embedded copies, not node_modules.
import runtimeWasmPath from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import typescriptWasmPath from "tree-sitter-typescript/tree-sitter-typescript.wasm" with { type: "file" };

export const ECHO_TOOL = "probe_echo";

export function checkFts(): string {
  const db = new Database(":memory:");
  try {
    db.run("CREATE VIRTUAL TABLE docs USING fts5(title, body)");
    const insert = db.prepare("INSERT INTO docs (title, body) VALUES (?, ?)");
    insert.run("alpha", "the quick brown fox");
    insert.run("beta", "a lazy sleeping dog");
    insert.run("gamma", "compiled binaries embed wasm grammars");
    const hits = db.query("SELECT title FROM docs WHERE docs MATCH ? ORDER BY rank").all("wasm") as { title: string }[];
    const titles = hits.map((hit) => hit.title);
    if (titles.length !== 1 || titles[0] !== "gamma") throw new Error(`fts: expected [gamma], got ${JSON.stringify(titles)}`);
    return `fts ok: MATCH 'wasm' -> ${titles[0]}`;
  } finally {
    db.close();
  }
}

const SAMPLE_TS = `
function greet(name: string): string { return "hi " + name; }
class Greeter { hello() { return greet("x"); } }
export const answer = 42;
`;

const DECLARATION_TYPES = new Set(["function_declaration", "class_declaration", "lexical_declaration", "export_statement"]);

function declaredNames(node: Node): string[] {
  if (node.type === "export_statement") return node.namedChildren.flatMap((child) => (child ? declaredNames(child) : []));
  if (node.type === "lexical_declaration") {
    return node.namedChildren.flatMap((declarator) => declarator?.childForFieldName("name")?.text ?? []);
  }
  const name = node.childForFieldName("name")?.text;
  return name ? [name] : [];
}

export async function parseSymbols(): Promise<string[]> {
  await Parser.init({ locateFile: () => runtimeWasmPath });
  const language = await Language.load(new Uint8Array(await Bun.file(typescriptWasmPath).arrayBuffer()));
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(SAMPLE_TS);
    if (!tree) throw new Error("parse: parser returned no tree");
    const names = tree.rootNode.namedChildren
      .filter((node): node is Node => node !== null && DECLARATION_TYPES.has(node.type))
      .flatMap(declaredNames);
    tree.delete();
    return names;
  } finally {
    parser.delete();
  }
}

export async function checkParse(): Promise<string> {
  const names = await parseSymbols();
  const expected = ["greet", "Greeter", "answer"];
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`parse: missing ${missing.join(", ")}; got ${JSON.stringify(names)}`);
  return `parse ok: ${names.join(", ")}`;
}

type JsonRpcRequest = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

export function handleRequest(request: JsonRpcRequest): object | null {
  // Notifications (no id) get no response.
  if (request.id === undefined) return null;
  const reply = (result: object) => ({ jsonrpc: "2.0", id: request.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: (request.params?.protocolVersion as string | undefined) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "tmb-packaging-probe", version: "0.0.0" },
      });
    case "tools/list":
      return reply({
        tools: [
          {
            name: ECHO_TOOL,
            description: "Returns the input text unchanged.",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      });
    case "tools/call": {
      const name = request.params?.name;
      const text = (request.params?.arguments as { text?: unknown } | undefined)?.text;
      if (name !== ECHO_TOOL) return fail(-32602, `unknown tool: ${String(name)}`);
      if (typeof text !== "string") return fail(-32602, "probe_echo needs a string `text` argument");
      return reply({ content: [{ type: "text", text }] });
    }
    default:
      return fail(-32601, `method not found: ${request.method}`);
  }
}

export async function serve(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response: object | null;
    try {
      response = handleRequest(JSON.parse(line) as JsonRpcRequest);
    } catch (error) {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${String(error)}` } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

// Sends initialize + tools/call to a `serve` child and checks the echo comes back.
export async function checkServe(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const timeout = setTimeout(() => child.kill(), 15_000);
  const request = async (id: number, method: string, params: object) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const next = await lines.next();
    if (next.done) throw new Error(`serve: server closed stdout before answering ${method}`);
    const response = JSON.parse(next.value) as { id: number; result?: unknown; error?: { message: string } };
    if (response.id !== id || response.error) throw new Error(`serve: ${method} failed: ${next.value}`);
    return response.result;
  };
  try {
    await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "probe-client", version: "0.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const text = "hello from the probe";
    const result = (await request(2, "tools/call", { name: ECHO_TOOL, arguments: { text } })) as {
      content: { type: string; text: string }[];
    };
    const echoed = result.content[0]?.text;
    if (echoed !== text) throw new Error(`serve: expected echo ${JSON.stringify(text)}, got ${JSON.stringify(echoed)}`);
    child.stdin.end();
    const code = await exited;
    if (code !== 0) throw new Error(`serve: server exited with ${code}`);
    return `serve ok: tools/call ${ECHO_TOOL} echoed ${JSON.stringify(echoed)}`;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
}

// From source, process.execPath is bun and needs the script path; compiled, it is the probe itself.
function selfCommand(): string[] {
  const runByBun = /^bun(\.exe)?$/i.test(path.basename(process.execPath));
  return runByBun ? [process.execPath, process.argv[1]!, "serve"] : [process.execPath, "serve"];
}

async function main(mode: string): Promise<void> {
  switch (mode) {
    case "fts":
      console.log(checkFts());
      return;
    case "parse":
      console.log(await checkParse());
      return;
    case "serve":
      await serve();
      return;
    case "all": {
      console.log(checkFts());
      console.log(await checkParse());
      const [command, ...args] = selfCommand();
      console.log(await checkServe(command!, args));
      console.log("PROBE OK");
      return;
    }
    default:
      throw new Error(`unknown mode: ${mode}; use all, fts, parse or serve`);
  }
}

if (import.meta.main) {
  main(process.argv[2] ?? "all").catch((error: unknown) => {
    console.error(`PROBE FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
