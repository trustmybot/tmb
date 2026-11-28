// `tmb help`: the short help, read from the command table, or one command's detail.
import { runningName } from "../../engine/index.ts";
import { type Command, GROUP_HEADINGS, HIDDEN_HEADING, listed } from "../command.ts";
import { actionUsage, asksHelp, detailHelpText, type HelpGroup, OTHER_NAMES, type Paint, shortHelpText, unknownCommandText } from "../help.ts";
import type { Runtime } from "../runtime.ts";

/** The commands the help reads: every one, in the order the help lists them. */
export interface CommandList {
  readonly commands: readonly Command[];
  get(name: string): Command | undefined;
}

export class HelpCommand implements Command {
  readonly name = "help";
  readonly summary = "Show help for a command";
  readonly listing = listed("Program");
  /** Help always runs in this build. */
  readonly handsOver = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly table: CommandList,
  ) {}

  usage(): string {
    return `  tmb help [<command>] [--all]
                            Show the commands, or one command's detail; with --all, also
                            the commands only a host or git calls
  tmb --version             Print the version`;
  }

  /** Help reads `--help` among its own arguments itself. */
  asksHelp(): boolean {
    return false;
  }

  /** `tmb help [<command> [<action>]] [--all]`. */
  async run(args: readonly string[]): Promise<number> {
    const all = args.includes("--all");
    const [command, action] = args.filter((arg) => !arg.startsWith("-"));
    if (command === undefined) {
      if (asksHelp([...args])) return this.writeCommandHelp(this.name, undefined);
      this.runtime.ports.stdout.write(this.shortHelp(this.runtime.outPaint(), all));
      return 0;
    }
    return this.writeCommandHelp(command, action);
  }

  /** The short help, with the hidden commands last when `all`. */
  shortHelp(paint: Paint, all: boolean): string {
    return shortHelpText(this.groups(all), paint);
  }

  /** The commands a typo may be told of: every listed one, never a hidden one. */
  listedNames(): string[] {
    return this.table.commands.filter((command) => command.listing.kind === "listed").map((command) => command.name);
  }

  /** What a command name no command has prints, on stderr; resolves to its exit code. */
  writeUnknown(name: string): number {
    this.runtime.ports.stderr.write(unknownCommandText(runningName(), name, this.listedNames(), this.runtime.errPaint(), OTHER_NAMES));
    return 2;
  }

  /**
   * Writes the help for `name`, or for one of its actions, on stdout; a name it does not know is
   * answered as a typo on stderr with exit code 2.
   */
  writeCommandHelp(name: string, action: string | undefined): number {
    const command = this.table.get(name);
    if (command === undefined) return this.writeUnknown(name);
    const { actions } = command;
    if (actions !== undefined && action !== undefined && !actions.includes(action)) {
      this.runtime.ports.stderr.write(unknownCommandText(`${runningName()} ${name}`, action, actions, this.runtime.errPaint()));
      return 2;
    }
    this.runtime.ports.stdout.write(detailHelpText(actionUsage(command.usage(), name, actions === undefined ? undefined : action), this.runtime.outPaint()));
    return 0;
  }

  /** The short help's groups in their order, and the hidden commands' last when `all`. */
  private groups(all: boolean): HelpGroup[] {
    const line = (command: Command) => ({ name: command.name, summary: command.summary });
    const groups: HelpGroup[] = GROUP_HEADINGS.map((heading) => ({
      heading,
      commands: this.table.commands.filter((command) => command.listing.kind === "listed" && command.listing.group === heading).map(line),
    }));
    if (!all) return groups;
    return [...groups, { heading: HIDDEN_HEADING, commands: this.table.commands.filter((command) => command.listing.kind === "hidden").map(line) }];
  }
}
