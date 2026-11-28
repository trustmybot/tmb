// The running tmb as its commands see it: the process it runs in, its streams and terminal, and
// the program it is. The entry makes one and hands it to each command; no command reads the
// process itself.
import { spawnSync } from "node:child_process";
import { HOST_ADAPTERS, type HookRun, type HostAdapter } from "../adapters/index.ts";
import { type FeedbackEnv, feedbackEnv, GH_FEEDBACK_GITHUB, type Program, runningProgram, version, versionLine } from "../engine/index.ts";
import type { Output } from "./command.ts";
import { isProcessRunning } from "./builds.ts";
import type { DoctorEnv } from "./commands/doctor/types.ts";
import { refreshProject } from "./refresh.ts";
import { mergedPullsByGh } from "./github.ts";
import { colourOn, Paint } from "./help.ts";
import { ancestorsOf } from "./process-tree.ts";
import { TerminalPrompt } from "./terminal.ts";
import { HANDED_OVER_VARIABLE, INSTALLED_FILE_VARIABLE, isCompiledEntry, Updater, type UpdaterOptions, updaterOptions } from "./updater.ts";

/**
 * Whoever starts a run sets this to `1` when no one can answer in it. Only this door reads it;
 * the adapter and the engine get a plain flag.
 */
const UNATTENDED_VARIABLE = "TMB_UNATTENDED";

/** How long doctor waits for another tmb program's `--version`. */
const VERSION_TIMEOUT_MS = 5_000;

/** The signals that stop a command that runs until stopped. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** The parts of the process a run uses. */
export type ProcessPorts = {
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly execPath: string;
  readonly pid: number;
  readonly ppid: number;
  readonly platform: NodeJS.Platform;
  readonly cwd: () => string;
  /** The file the run started from: the executable when compiled, else this source's entry. */
  readonly main: string;
  /** Reads all of stdin. */
  readonly readStdin: () => Promise<string>;
  readonly once: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly exit: (code: number) => void;
};

export class Runtime {
  readonly version = version;
  readonly compiled: boolean;
  /** Where the record commands write; what goes to `err` is coloured as stderr allows. */
  readonly output: Output;

  constructor(readonly ports: ProcessPorts) {
    this.compiled = isCompiledEntry(ports.main);
    this.output = { out: this.out, err: this.err, colour: colourOn(ports.stderr, ports.env) };
  }

  readonly out = (text: string): void => {
    this.ports.stdout.write(`${text}\n`);
  };

  readonly err = (text: string): void => {
    this.ports.stderr.write(`${text}\n`);
  };

  get env(): NodeJS.ProcessEnv {
    return this.ports.env;
  }

  cwd(): string {
    return this.ports.cwd();
  }

  outPaint(): Paint {
    return new Paint(colourOn(this.ports.stdout, this.ports.env));
  }

  errPaint(): Paint {
    return new Paint(colourOn(this.ports.stderr, this.ports.env));
  }

  /** Whether a person is at both ends: stdin and stdout are a terminal. */
  get attended(): boolean {
    return this.ports.stdin.isTTY === true && this.ports.stdout.isTTY === true;
  }

  /** A prompt on the terminal when a person is at both ends; null otherwise. The caller closes it. */
  terminal(): TerminalPrompt | null {
    return this.attended ? this.openTerminal() : null;
  }

  /** A prompt on the terminal, whoever is there. The caller closes it. */
  openTerminal(): TerminalPrompt {
    return new TerminalPrompt(this.ports.stdin, this.ports.stdout);
  }

  /** Resolves when the process is asked to stop: Ctrl+C or a termination signal. */
  untilStopped(): Promise<void> {
    return new Promise<void>((resolve) => {
      for (const signal of STOP_SIGNALS) this.ports.once(signal, () => resolve());
    });
  }

  /** Only `1` turns unattended mode on; unset or any other value leaves the run attended. */
  hookRun(): HookRun {
    return { unattended: this.ports.env[UNATTENDED_VARIABLE] === "1" };
  }

  updaterOptions(): UpdaterOptions {
    return updaterOptions(version, this.compiled, this.ports.env);
  }

  updater(): Updater {
    return new Updater(this.updaterOptions());
  }

  /** The program this build is, as its version line names it. */
  program(): Program {
    return this.updaterOptions().program!;
  }

  versionLine(): string {
    return versionLine(this.program());
  }

  /** The running program's name and version, which a project is tied to. */
  runningProgram(): { name: string; version: string } {
    return { name: runningProgram(version).name, version };
  }

  /** The command that runs this tmb: the executable, plus the entry file when run from source. */
  ownCommand(): string[] {
    return this.compiled ? [this.ports.execPath] : [this.ports.execPath, this.ports.main];
  }

  /**
   * The command a project's wiring calls: this tmb, or the installed file when this is a kept build
   * serving a handed-over call, so wiring never names a kept build.
   */
  tmbCommand(): string[] {
    const installed = this.ports.env[HANDED_OVER_VARIABLE] === "1" ? this.ports.env[INSTALLED_FILE_VARIABLE] : undefined;
    return installed ? [installed] : this.ownCommand();
  }

  /** The processes above this one, nearest first. */
  ancestors(): number[] {
    return ancestorsOf(this.ports.pid, this.ports.ppid, this.ports.platform);
  }

  /** The feedback program's environment for this tmb; `hosts` are the ones a report names, every supported one unless given. */
  feedbackEnvironment(hosts: readonly HostAdapter[] = HOST_ADAPTERS): FeedbackEnv {
    const options = this.updaterOptions();
    const program = options.program!;
    return feedbackEnv({ stateDir: options.stateDir, program, version, versionLine: versionLine(program), hosts: () => hostLines(hosts) });
  }

  /** Brings a project's host files to this tmb after an update (trustmybot/tmb#128). Never throws. */
  hostFileRefresh(projectDir: string): string | null {
    return refreshProject({ projectDir, program: this.runningProgram(), tmbCommand: this.tmbCommand(), adapters: HOST_ADAPTERS });
  }

  /** What `tmb doctor` works with, for this tmb in `cwd`. */
  doctorEnvironment(cwd: string): DoctorEnv {
    const options = this.updaterOptions();
    return {
      program: options.program!,
      version,
      installed: this.compiled ? this.ports.execPath : null,
      stateDir: options.stateDir,
      tmbCommand: this.tmbCommand(),
      adapters: HOST_ADAPTERS,
      cwd,
      path: this.ports.env.PATH ?? "",
      platform: this.ports.platform,
      isRunning: isProcessRunning,
      versionOf: (file) => {
        const result = spawnSync(file, ["--version"], { encoding: "utf8", timeout: VERSION_TIMEOUT_MS });
        return result.status === 0 ? result.stdout.trim().split("\n")[0] || null : null;
      },
      gh: () => {
        if (Bun.which("gh") === null) return { installed: false, signedIn: false };
        return { installed: true, signedIn: GH_FEEDBACK_GITHUB.signedIn() };
      },
      now: () => new Date(),
      mergedPulls: mergedPullsByGh,
    };
  }
}

/** Each host with its version, as `<host> 2.1.0`, for a report; a host that is not installed is left out. */
function hostLines(adapters: readonly HostAdapter[]): string[] {
  return adapters.flatMap((adapter) => {
    const found = adapter.detect();
    return found.installed ? [`${adapter.name} ${found.version ?? "(version unknown)"}`] : [];
  });
}
