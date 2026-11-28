// `tmb hook`: answer a host event. A hook must never break the host session: any failure exits 0
// with a note on stderr.
import path from "node:path";
import { parseArgs } from "node:util";
import { adapterById, DEFAULT_HOST_ID, type HostAdapter } from "../../adapters/index.ts";
import { pushGateOffLine } from "../../engine/index.ts";
import { unusedBuildsLine } from "../builds.ts";
import { HIDDEN, ParsedCommand } from "../command.ts";
import type { Runtime } from "../runtime.ts";
import type { Updater } from "../updater.ts";
import { sessionStartLine } from "./doctor/index.ts";

/** The one event that may tell the Human about the feedback program, or bring the project's host files to this tmb. */
const SESSION_START_EVENT = "session-start";

type HookOptions = { readonly event: string; readonly host: string | undefined };

export class HookCommand extends ParsedCommand<HookOptions> {
  readonly name = "hook";
  readonly summary = "Answer a host event";
  readonly listing = HIDDEN;

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb hook <event> [--host <id>]
                            Answer a host event (the host runs this; reads JSON on stdin);
                            with no host, the event is the first host's tmb wired`;
  }

  override async run(args: readonly string[]): Promise<number> {
    try {
      return await super.run(args);
    } catch (error) {
      this.runtime.err(`tmb hook: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  protected parse(args: readonly string[]): HookOptions {
    const { values, positionals } = parseArgs({ args: [...args], options: { host: { type: "string" } }, allowPositionals: true, strict: true });
    const [event, ...extra] = positionals;
    if (!event) throw new Error("missing event name");
    if (extra.length > 0) throw new Error(`hook takes one event name, got ${positionals.join(" ")}`);
    return { event, host: values.host };
  }

  protected async execute({ event, host }: HookOptions): Promise<number> {
    const adapter = adapterById(host ?? DEFAULT_HOST_ID);
    const stdinText = await this.runtime.ports.readStdin();
    const run =
      event === SESSION_START_EVENT
        ? {
            ...this.runtime.hookRun(),
            feedback: this.runtime.feedbackEnvironment([adapter]),
            refresh: (projectDir: string) => this.sessionStartLines(projectDir, adapter, stdinText),
            doctor: (projectDir: string) => this.doctorLine(projectDir),
          }
        : this.runtime.hookRun();
    const output = adapter.answerHook(event, stdinText, run);
    // An empty answer means nothing to say, such as an allow: the host goes on as it would without tmb.
    if (output !== "") this.runtime.out(output);
    return 0;
  }

  /** What a session start says about this tmb's own state: the host files' refresh and old builds; it also names the session. Never throws. */
  private sessionStartLines(projectDir: string, adapter: HostAdapter, stdinText: string): string | null {
    // A repo whose pre-push hook is another tool's has no push gate: said at every start until it has (trustmybot/tmb#184).
    const lines = [this.runtime.hostFileRefresh(projectDir), pushGateOffLine(projectDir)];
    try {
      const updater = this.runtime.updater();
      if (updater.tracksSessions) {
        const title = adapter.sessionTitle?.(stdinText) ?? null;
        if (title !== null) this.nameSession(updater, projectDir, title);
        lines.push(unusedBuildsLine(updater));
      }
    } catch {
      // Naming the session and counting builds are extras; the session starts without them.
    }
    const said = lines.filter((line): line is string => line !== null);
    return said.length === 0 ? null : said.join("\n");
  }

  /**
   * Names the running session a session start belongs to with the title the Human gave it: the
   * session whose tool server shares the nearest process above this hook, in the same project.
   */
  private nameSession(updater: Updater, projectDir: string, title: string): void {
    const mine = this.runtime.ancestors();
    const project = path.resolve(projectDir);
    const leases = updater.leases(-1).filter((lease) => path.resolve(lease.project) === project && (lease.ancestors?.length ?? 0) > 0);
    for (const ancestor of mine) {
      const matches = leases.filter((lease) => lease.ancestors!.includes(ancestor));
      if (matches.length === 1) return updater.updateSession(matches[0]!.pid, { title });
      if (matches.length > 1) return;
    }
  }

  /** The planner's one line on what doctor finds, at a session start (trustmybot/tmb#160). Never throws. */
  private doctorLine(projectDir: string): string | null {
    try {
      return sessionStartLine(this.runtime.doctorEnvironment(projectDir));
    } catch {
      return null;
    }
  }
}
