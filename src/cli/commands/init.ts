// `tmb init`: prepare the project in the current directory for one host.
import { noArguments } from "../arguments.ts";
import { listed } from "../command.ts";
import { parseArgs } from "node:util";
import { INIT_OPTIONS, PrepareCommand } from "./prepare.ts";
import { runInit, type SetupFlags } from "./setup.ts";

export class InitCommand extends PrepareCommand {
  readonly name = "init";
  readonly summary = "Prepare this project for tmb";
  readonly listing = listed("Project");

  usage(): string {
    return `  tmb init [--host <id>] [--role planner|reviewer]
                            Prepare the project in the current directory: create its record,
                            wire one host in its role, add git's push hook and index the code
                            graph. Asks nothing and leaves the settings empty: the planner
                            applies the ones it recommends at its first session. Run it once
                            per host to use two hosts on one record`;
  }

  /** init takes only the host and its role, as it asks nothing and sets no other setting (trustmybot/tmb#162). */
  protected parse(args: readonly string[]): SetupFlags {
    const { values, positionals } = parseArgs({ args: [...args], options: INIT_OPTIONS, allowPositionals: true, strict: true });
    noArguments(this.name, positionals);
    return { host: values.host, role: values.role };
  }

  protected async execute(flags: SetupFlags): Promise<number> {
    // init never asks or waits for input. The feedback program's notice at its end is for a person
    // at a terminal; with none, the planner gives it.
    const feedback = this.runtime.attended ? this.runtime.feedbackEnvironment() : undefined;
    await runInit(this.setupOptions(flags, null, feedback));
    return 0;
  }
}
