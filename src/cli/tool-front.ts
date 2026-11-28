// The tool server in two parts (trustmybot/tmb#159). The front holds the host's connection for
// the whole session and passes every message through to the engine, a child tmb that serves the
// tools. When a newer build is installed and the project is free (between two tool calls, with
// no task open), the front starts the installed build's engine, repeats the opening exchange
// with it, and retires the old one, so the host sees no break and the session moves to the new
// build by itself. When the move fails, the old engine keeps serving and the session is told how
// to restart the tool server in its host.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };

/** How long a new engine has to answer the opening exchange before the move counts as failed. */
const MOVE_TIMEOUT_MS = 30_000;
/** Ids of the front's own requests to an engine, never one a host would use. */
const FRONT_ID = "tmb-front-";

export type FrontOptions = {
  /** Runs this build's engine: the command, then its arguments. */
  ownEngine: string[];
  /** Runs the installed build's engine, or null when there is no installed file. */
  installedEngine: string[] | null;
  /** The version the installed file reports, or null when it cannot say. */
  installedVersion: () => string | null;
  /** True while the project has an open task: the session stays on its build until it closes. */
  hasOpenTask: () => boolean;
  /** Env for every engine. A moved-in engine also gets TMB_MOVED_FROM, the version it replaces. */
  env: NodeJS.ProcessEnv;
  /** Called when the engine the session runs changes version: at its first answer, and after a move. */
  onVersion: (version: string) => void;
  /** Called when a move failed, with why. */
  onMoveFailed: (version: string, reason: string) => void;
  /** What the Human does in this host to restart the tool server, in the host's words. */
  reconnect: string;
  /** The program's name, for the lines the session reads. */
  program: string;
  /** The host's input and output; the process's own unless given. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

class Engine {
  readonly child: ChildProcess;
  private readonly waiting = new Map<string, (message: Message) => void>();
  private nextId = 0;
  exited: Promise<number | null>;

  constructor(command: string[], env: NodeJS.ProcessEnv, onMessage: (engine: Engine, message: Message, line: string) => void) {
    this.child = spawn(command[0]!, command.slice(1), { env, stdio: ["pipe", "pipe", "inherit"] });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code) => resolve(code));
      this.child.once("error", () => resolve(null));
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      if (line.trim() === "") return;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        return;
      }
      const own = typeof message.id === "string" && message.id.startsWith(FRONT_ID) ? this.waiting.get(message.id) : undefined;
      if (own) {
        this.waiting.delete(message.id as string);
        own(message);
        return;
      }
      onMessage(this, message, line);
    });
  }

  send(message: Message | string): void {
    this.child.stdin?.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  /** Sends a request of the front's own and waits for its answer. */
  request(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<Message> {
    const id = `${FRONT_ID}${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`no answer to ${method} within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
        else resolve(message);
      });
      void this.exited.then((code) => {
        clearTimeout(timer);
        if (this.waiting.delete(id)) reject(new Error(`it exited (${code ?? "no code"}) before answering ${method}`));
      });
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** Lets the engine end on its own: its input closes, as at a session's end. */
  retire(): void {
    this.child.stdin?.end();
  }
}

function versionOf(message: Message): string | null {
  const info = message.result?.serverInfo as { version?: unknown } | undefined;
  return typeof info?.version === "string" ? info.version : null;
}

/** Serves the host through an engine until the host closes the connection; resolves with the engine's exit code. */
export async function runFront(options: FrontOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const toHost = (message: Message | string) => output.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);

  let opening: Message | null = null;
  let engineVersion: string | null = null;
  let failedFor: string | null = null;
  /** Requests the host sent that the engine has not answered yet. */
  const inFlight = new Set<string | number>();
  /** A line to add to the answer of the tool call with this id. */
  const notes = new Map<string | number, string>();
  let hostClosed = false;

  const fromEngine = (from: Engine, message: Message, line: string) => {
    if (from !== engine) return;
    const answer = message.method === undefined && message.id !== undefined && message.id !== null;
    if (answer) inFlight.delete(message.id!);
    if (answer && opening !== null && message.id === opening.id && message.result) {
      // The front can move the session to a build with other tools, so it says the list may change.
      const capabilities = (message.result.capabilities ?? {}) as Record<string, unknown>;
      message.result.capabilities = { ...capabilities, tools: { ...((capabilities.tools as object | undefined) ?? {}), listChanged: true } };
      engineVersion = versionOf(message);
      if (engineVersion !== null) options.onVersion(engineVersion);
      toHost(message);
      return;
    }
    const note = answer ? notes.get(message.id!) : undefined;
    if (note !== undefined && message.result) {
      notes.delete(message.id!);
      const content = Array.isArray(message.result.content) ? message.result.content : [];
      message.result.content = [...content, { type: "text", text: note }];
      toHost(message);
      return;
    }
    toHost(line);
  };

  const start = (command: string[], env: NodeJS.ProcessEnv) => {
    const started = new Engine(command, env, fromEngine);
    void started.exited.then((code) => {
      // An engine that ends while it serves ends the session's tool server with it.
      if (started === engine && !hostClosed) finish(code ?? 1);
    });
    return started;
  };

  let engine = start(options.ownEngine, options.env);
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  /** Moves the session to the installed build when one other than its own is there and the project is free. Returns the line to tell the session, or null. */
  const maybeMove = async (): Promise<string | null> => {
    if (options.installedEngine === null || opening === null || engineVersion === null || inFlight.size > 0) return null;
    const installed = options.installedVersion();
    if (installed === null || installed === engineVersion || installed === failedFor) return null;
    if (options.hasOpenTask()) return null;
    const from = engineVersion;
    const next = start(options.installedEngine, { ...options.env, TMB_MOVED_FROM: from });
    try {
      const answer = await next.request("initialize", opening.params, MOVE_TIMEOUT_MS);
      next.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const old = engine;
      engine = next;
      old.retire();
      engineVersion = versionOf(answer) ?? installed;
      options.onVersion(engineVersion);
      // The new build may serve other tools; the host asks for the list again.
      toHost({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      return `${options.program} moved this session from ${from} to ${engineVersion}.`;
    } catch (error) {
      next.child.kill();
      failedFor = installed;
      const reason = error instanceof Error ? error.message : String(error);
      options.onMoveFailed(installed, reason);
      return `${options.program} ${installed} is installed, but this session stays on ${from}: its tool server could not move (${reason}). To move it, ${options.reconnect}.`;
    }
  };

  // Host messages are handled one at a time, so a move never starts while a request is on its way.
  let queue = Promise.resolve();
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    queue = queue.then(async () => {
      if (line.trim() === "") return;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        engine.send(line);
        return;
      }
      const request = message.method !== undefined && message.id !== undefined && message.id !== null;
      if (message.method === "initialize" && request) opening = message;
      if (request && message.method === "tools/call") {
        const note = await maybeMove();
        if (note !== null) notes.set(message.id!, note);
      }
      if (request) inFlight.add(message.id!);
      engine.send(line);
    });
  });
  lines.once("close", () => {
    void queue.then(async () => {
      hostClosed = true;
      engine.retire();
      finish((await engine.exited) ?? 0);
    });
  });
  return done;
}
