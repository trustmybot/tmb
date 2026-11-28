// `tmb config`: print the project's settings.
import { openProjectStore, readSettings, runningName, settingLines } from "../../engine/index.ts";
import { parseWithJson } from "../arguments.ts";
import { listed, type Output, ParsedCommand, UsageError } from "../command.ts";

type ConfigOptions = { readonly json: boolean };

/** What a project command works with: where it writes, and the folder it runs in, which is the project's. */
export type ProjectContext = { readonly output: Output; cwd(): string };

export class ConfigCommand extends ParsedCommand<ConfigOptions> {
  readonly name = "config";
  readonly summary = "Print the project's settings";
  readonly listing = listed("Project");

  constructor(private readonly context: ProjectContext) {
    super();
  }

  usage(): string {
    return `  tmb config [--json]       Print the project's settings`;
  }

  protected parse(args: readonly string[]): ConfigOptions {
    const { values, positionals } = parseWithJson(args, {});
    if (positionals.length > 0) throw new UsageError(`config takes no arguments, got ${positionals.join(" ")}`);
    return { json: values.json === true };
  }

  protected execute({ json }: ConfigOptions): number {
    const projectDir = this.context.cwd();
    const { output } = this.context;
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) {
      output.err(
        opened.error.failure === "missing"
          ? `tmb: ${runningName()} init has not run in ${projectDir}, so it has no settings; run \`${runningName()} init\` there first.`
          : `tmb: cannot use the record: ${opened.error.message}`,
      );
      return 1;
    }
    try {
      const settings = readSettings(opened.store);
      // A single-repo project has no repos, and prints its settings as it always has.
      const { repos, ...rest } = settings;
      const printed = repos === null ? rest : settings;
      output.out(json ? JSON.stringify(printed, null, 2) : settingLines(settings).join("\n"));
      return 0;
    } finally {
      opened.store.close();
    }
  }
}
