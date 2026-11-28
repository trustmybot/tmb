// `tmb remove`: undo what init added, for one host or for every host and the push gate.
import { parseArgs } from "node:util";
import { adapterById, HOST_ADAPTERS } from "../../adapters/index.ts";
import { removePushGates } from "../../engine/index.ts";
import { noArguments } from "../arguments.ts";
import { listed, ParsedCommand } from "../command.ts";
import type { Runtime } from "../runtime.ts";

/** The host whose wiring goes, or every host's and then the push gate, which serves them all. */
type RemoveOptions = { readonly host: string | undefined };

export class RemoveCommand extends ParsedCommand<RemoveOptions> {
  readonly name = "remove";
  readonly summary = "Undo what init added";
  readonly listing = listed("Project");

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb remove [--host <id>]  Undo what init added for one host, or for every host and the
                            push gate when none is named; the record is kept`;
  }

  protected parse(args: readonly string[]): RemoveOptions {
    const { values, positionals } = parseArgs({ args: [...args], options: { host: { type: "string" } }, allowPositionals: true, strict: true });
    noArguments(this.name, positionals);
    return { host: values.host };
  }

  protected execute({ host }: RemoveOptions): number {
    const cwd = this.runtime.cwd();
    const adapters = host === undefined ? HOST_ADAPTERS : [adapterById(host)];
    // One host's broken config must not leave the others, or the push gate, wired.
    const failures: string[] = [];
    const lines = adapters.flatMap((adapter) => {
      try {
        return adapter.remove(cwd);
      } catch (error) {
        failures.push(`tmb could not remove ${adapter.name} (${adapter.id}): ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    if (host === undefined) lines.push(...removePushGates(cwd));
    // Each adapter says the record is kept; say it once.
    for (const line of new Set(lines)) this.runtime.out(line);
    for (const failure of failures) this.runtime.err(failure);
    return failures.length === 0 ? 0 : 1;
  }
}
