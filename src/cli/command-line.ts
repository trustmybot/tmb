// The command line: one call, run by the command table. Program-wide words (none, `--help`,
// `--version`) are read here; every command's own work is the command's.
import { isParseArgsError } from "./arguments.ts";
import { UsageError } from "./command.ts";
import { HandOver } from "./hand-over.ts";
import { HumanGate } from "./human-gate.ts";
import type { CommandTable } from "./registry.ts";
import type { Runtime } from "./runtime.ts";
import { writeUsageError } from "./usage-error.ts";

/** The words that ask for the short help with no command. */
const HELP_WORDS: ReadonlySet<string> = new Set(["--help", "-h"]);
/** The words that print the version. */
const VERSION_WORDS: ReadonlySet<string> = new Set(["--version", "-v", "version"]);
const ALL_FLAG = "--all";
/** The exit code of a call the command line does not take. */
const USAGE_EXIT = 2;
/** The exit code of a call the Human-only gate refuses. */
const REFUSED_EXIT = 1;

export class CommandLine {
  private readonly handOver: HandOver;
  private readonly gate: HumanGate;

  constructor(
    private readonly runtime: Runtime,
    private readonly table: CommandTable,
  ) {
    this.handOver = new HandOver(runtime);
    this.gate = new HumanGate(runtime);
  }

  /** Runs the call `argv`; resolves to its exit code. */
  async run(argv: readonly string[]): Promise<number> {
    const { runtime, table } = this;
    const [name, ...rest] = argv;
    // A command is required: none given is the same usage error as an unknown one.
    if (name === undefined) {
      runtime.ports.stderr.write(table.help.shortHelp(runtime.errPaint(), false));
      return USAGE_EXIT;
    }
    if (HELP_WORDS.has(name)) return table.help.run(rest.filter((arg) => arg === ALL_FLAG));
    const command = table.get(name);
    if (command?.handsOver !== false) {
      const handed = this.handOver.run(name, command, rest);
      if (handed !== null) return handed;
    }
    if (command === undefined) {
      if (!VERSION_WORDS.has(name)) return table.help.writeUnknown(name);
      runtime.out(runtime.versionLine());
      return 0;
    }
    if (command.asksHelp(rest)) return table.help.writeCommandHelp(name, rest[0]?.startsWith("-") ? undefined : rest[0]);
    if (!(await this.gate.allows(argv))) return REFUSED_EXIT;
    try {
      return await command.run(rest);
    } catch (error) {
      if (!(error instanceof UsageError) && !isParseArgsError(error)) throw error;
      writeUsageError(command, error, runtime.output);
      return USAGE_EXIT;
    }
  }
}
