// `tmb update`: look for a newer build on this program's channel now, and apply it when it may.
import { parseArgs } from "node:util";
import { unusedBuildsLine } from "../builds.ts";
import { listed, ParsedCommand } from "../command.ts";
import type { Runtime } from "../runtime.ts";
import type { Updater } from "../updater.ts";

/** Whether the call only reports, or also applies a newer build. */
type UpdateOptions = { readonly checkOnly: boolean };

export class UpdateCommand extends ParsedCommand<UpdateOptions> {
  readonly name = "update";
  readonly summary = "Look for a newer build";
  readonly listing = listed("Program");
  /** An update always runs in this build: it is what moves the program on. */
  override readonly handsOver = false;

  constructor(private readonly runtime: Runtime) {
    super();
  }

  usage(): string {
    return `  tmb update [--check]      Look for a newer build on this program's channel now and apply it
                            when no session of it is running and no task is open; with
                            --check, only report. tmb follows stable, tmb-rc rc and tmb-dev
                            dev; tmb-<version> never updates`;
  }

  protected parse(args: readonly string[]): UpdateOptions {
    const { values, positionals } = parseArgs({ args: [...args], options: { check: { type: "boolean" } }, allowPositionals: true, strict: true });
    if (positionals.length > 0) throw new Error(`update takes no arguments, got ${positionals.join(" ")}`);
    return { checkOnly: values.check === true };
  }

  protected async execute({ checkOnly }: UpdateOptions): Promise<number> {
    const { out, err, version } = this.runtime;
    const updater = this.runtime.updater();
    const name = updater.program.name;
    if (!updater.active) {
      out(this.inactiveLine(updater));
      return 0;
    }
    updater.tidy();
    const checked = await updater.check({ force: true });
    if (checked.outcome === "failed") {
      err(`${name} update: could not reach the ${updater.channel} channel: ${checked.error}`);
      return 1;
    }
    const staged = checked.outcome === "current" ? null : updater.staged();
    if (!staged) {
      out(`${name} ${version} is the newest on the ${updater.channel} channel.`);
      return 0;
    }
    if (checkOnly) {
      out(`${name} ${staged.version} is ready on the ${updater.channel} channel; this is ${version}.`);
      return 0;
    }
    const applied = updater.apply();
    if (applied.outcome === "applied") {
      out(`Updated ${name} from ${version} to ${applied.version}.`);
      for (const { lease, reason } of updater.waiting(applied.version!)) {
        const title = lease.title ? `"${lease.title}", ` : "";
        out(`The session in ${lease.project} (${title}started ${new Date(lease.startedAt).toLocaleString()}) stays on ${lease.build}: ${reason}.`);
      }
      const unused = unusedBuildsLine(updater);
      if (unused !== null) out(unused);
      return 0;
    }
    if (applied.outcome === "waiting") {
      out(`${name} ${applied.version} is ready but not installed yet: ${applied.reason}. Run \`${name} update\` again.`);
      return 0;
    }
    err(`${name} update: could not apply ${applied.version}: ${applied.reason}`);
    return 1;
  }

  /** Why this build never updates itself: it is pinned, runs from source, or updates are off. */
  private inactiveLine(updater: Updater): string {
    const name = updater.program.name;
    const { version } = this.runtime;
    if (updater.pinned) return `${name} is pinned to ${version} and never updates itself; install tmb, tmb-rc or tmb-dev to follow a channel.`;
    if (updater.options.enabled) return `tmb ${version} runs from source and does not update itself.`;
    return `Updates are turned off (TMB_NO_UPDATE=1); this is ${name} ${version}.`;
  }
}
