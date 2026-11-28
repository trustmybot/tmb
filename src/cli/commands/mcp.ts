// `tmb mcp`: serve the record's tools over stdio to a host. In a build that tracks its sessions it
// runs as a front: the session's own engine serves the tools, the installed build may take over,
// and the session's end may apply an update.
import path from "node:path";
import { parseArgs } from "node:util";
import { HOST_ADAPTERS } from "../../adapters/index.ts";
import { openProjectStore, projectRootOf, recordProgramMove, runningProgram, serveTools, type SubagentRole } from "../../engine/index.ts";
import { HIDDEN, HUMAN, ParsedCommand } from "../command.ts";
import type { Runtime } from "../runtime.ts";
import { runFront } from "../tool-front.ts";
import { HANDED_OVER_VARIABLE, INSTALLED_FILE_VARIABLE, installedVersionOf, type Updater } from "../updater.ts";

/** Set by a front for the engine it starts in place of an older build's: the version it moved from. */
const MOVED_FROM_VARIABLE = "TMB_MOVED_FROM";
/** The flag a front starts its engine with. */
const ENGINE_FLAG = "--engine";
const PROJECT_FLAG = "--project";
/** The signals that end a session's tool server. */
const END_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
/** What a host is told to do when it names no way to reconnect its tool server. */
const RECONNECT_FALLBACK = "restart this session";

/** The host that runs the server, the project it serves, and whether this is the engine behind a front. */
type McpOptions = { readonly host: string; readonly projectDir: string; readonly engine: boolean };

export class McpCommand extends ParsedCommand<McpOptions> {
  readonly name = "mcp";
  readonly summary = "Serve the record's tools to a host";
  readonly listing = HIDDEN;

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb mcp --host <id> [--project <dir>]
                            Serve the record's tools over stdio (the host runs this)`;
  }

  /** The project the call names with `--project`; null when it names none. */
  projectOf(args: readonly string[]): string | null {
    const flag = args.findIndex((arg) => arg === PROJECT_FLAG || arg.startsWith(`${PROJECT_FLAG}=`));
    if (flag < 0) return null;
    const value = args[flag]!.includes("=") ? args[flag]!.slice(`${PROJECT_FLAG}=`.length) : args[flag + 1];
    return value ? path.resolve(value) : null;
  }

  protected parse(args: readonly string[]): McpOptions {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { host: { type: "string" }, project: { type: "string" }, engine: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new Error(`mcp takes no arguments, got ${positionals.join(" ")}`);
    if (values.host === undefined || values.host.trim() === "") throw new Error("mcp needs --host <id>, the host that runs it");
    // A host may start the server in a subfolder; the record is in the project that holds it.
    const projectDir = values.project === undefined ? projectRootOf(this.runtime.cwd()) : path.resolve(values.project);
    return { host: values.host, projectDir, engine: values.engine === true };
  }

  protected async execute(options: McpOptions): Promise<number> {
    if (options.engine) {
      // The engine behind a front: it serves the tools and nothing else.
      const from = this.runtime.env[MOVED_FROM_VARIABLE];
      if (from) this.movedIn(options.projectDir, from);
      await this.serve(options);
      return 0;
    }
    const updater = this.runtime.updater();
    if (!updater.tracksSessions) {
      await this.serve(options);
      return 0;
    }
    return this.front(options, updater);
  }

  private serve({ host, projectDir }: McpOptions): Promise<void> {
    const adapter = HOST_ADAPTERS.find((candidate) => candidate.id === host);
    // The report the planner's tools send names the host that runs them.
    const feedback = this.runtime.feedbackEnvironment(adapter === undefined ? [] : [adapter]);
    // A change to the shared folders reaches the host's own files, so the worktrees it makes link them too.
    const onSharedFolders = adapter?.shareFolders === undefined ? undefined : (dir: string, folders: readonly string[]) => void adapter.shareFolders!(dir, folders);
    // A role created or deleted reaches the host's agent files, so the host can start its agent.
    const onRoles = adapter?.writeRoles === undefined ? undefined : (dir: string, roles: readonly SubagentRole[]) => void adapter.writeRoles!(dir, roles);
    return serveTools({ projectDir, host, version: this.runtime.version, unattended: this.runtime.hookRun().unattended, feedback, onSharedFolders, onRoles });
  }

  /** A session's front: its engine serves the tools; a session start looks for an update in the background, and the session's end may apply it. */
  private async front({ host, projectDir }: McpOptions, updater: Updater): Promise<number> {
    const { runtime } = this;
    const pid = runtime.ports.pid;
    if (updater.active) updater.tidy();
    updater.startSession(projectDir, pid, { build: runtime.version, ancestors: runtime.ancestors() });
    const abort = new AbortController();
    const checking = updater.active ? updater.check({ signal: abort.signal }) : Promise.resolve();
    let ended = false;
    const end = async () => {
      if (ended) return;
      ended = true;
      abort.abort();
      await checking;
      updater.endSession();
      const applied = updater.apply();
      if (applied.outcome === "applied") runtime.err(`tmb: updated to ${applied.version}; the next session runs it`);
      // A kept build that stays kept says why, so a host's log shows what holds the update back.
      else if (applied.outcome === "waiting") runtime.err(`tmb: the update to ${applied.version} waits: ${applied.reason}`);
      else if (applied.outcome === "failed") runtime.err(`tmb: the update to ${applied.version} failed: ${applied.reason}`);
    };
    const onSignal = () => void end().finally(() => runtime.ports.exit(0));
    for (const signal of END_SIGNALS) runtime.ports.once(signal, onSignal);
    const engineArgs = [this.name, ENGINE_FLAG, "--host", host, PROJECT_FLAG, projectDir];
    const installed = updater.options.target!;
    const adapter = HOST_ADAPTERS.find((candidate) => candidate.id === host);
    try {
      // The engines know they are behind a front, so none hands the call over again.
      return await runFront({
        ownEngine: [...runtime.ownCommand(), ...engineArgs],
        installedEngine: [installed, ...engineArgs],
        installedVersion: () => installedVersionOf(installed),
        hasOpenTask: () => updater.hasOpenTask(projectDir),
        env: { ...runtime.env, [HANDED_OVER_VARIABLE]: "1", [INSTALLED_FILE_VARIABLE]: installed },
        onVersion: (running) => updater.updateSession(pid, { build: running, moveError: null }),
        onMoveFailed: (_installed, reason) => updater.updateSession(pid, { moveError: reason }),
        reconnect: adapter?.reconnectToolServer ?? RECONNECT_FALLBACK,
        program: updater.program.name,
      });
    } finally {
      await end();
    }
  }

  /** An engine that replaced an older build's in a running session: the record keeps it, and the host files catch up. */
  private movedIn(projectDir: string, from: string): void {
    const program = runningProgram(this.runtime.version).name;
    try {
      const opened = openProjectStore(projectDir, { create: false });
      if (opened.ok) {
        try {
          recordProgramMove(opened.store, HUMAN, { program, from, to: this.runtime.version });
        } finally {
          opened.store.close();
        }
      }
    } catch {
      // The move stands without its entry.
    }
    // The host files refresh as at a session start; the line goes to stderr, never into the protocol.
    const line = this.runtime.hostFileRefresh(projectDir);
    if (line !== null) this.runtime.err(`tmb: ${line}`);
  }
}
