// Hands a call over to the build a running session pinned its project to (trustmybot/tmb#159): a
// hook, the tool server, git's push hook or a command typed by hand all run that build while the
// session runs. Only the installed tmb hands over, once: the kept build never hands over again.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { projectRootOf } from "../engine/index.ts";
import type { Command } from "./command.ts";
import type { Runtime } from "./runtime.ts";
import { HANDED_OVER_VARIABLE, INSTALLED_FILE_VARIABLE, type Updater } from "./updater.ts";

export class HandOver {
  constructor(private readonly runtime: Runtime) {}

  /**
   * Runs the call `name rest` in the kept build when one holds its project; its exit code, or null
   * to run this build. `command` is the table's command of that name, if there is one.
   */
  run(name: string, command: Command | undefined, rest: readonly string[]): number | null {
    const { runtime } = this;
    if (runtime.env[HANDED_OVER_VARIABLE] === "1") return null;
    let updater: Updater;
    let pinned: string | null;
    try {
      updater = runtime.updater();
      if (!updater.active) return null;
      pinned = updater.pinOf(command?.projectOf?.(rest) ?? projectRootOf(runtime.cwd()));
    } catch {
      return null;
    }
    if (pinned === null) return null;
    const kept = updater.keptFile(pinned);
    if (!existsSync(kept)) {
      runtime.err(`tmb: a session in this project started on ${updater.program.name} ${pinned}, which is no longer kept; this call runs ${runtime.version}.`);
      return null;
    }
    const result = spawnSync(kept, [name, ...rest], {
      stdio: "inherit",
      env: { ...runtime.env, [HANDED_OVER_VARIABLE]: "1", [INSTALLED_FILE_VARIABLE]: updater.options.target! },
    });
    if (result.error) {
      runtime.err(`tmb: could not run ${updater.program.name} ${pinned} for this project (${result.error.message}); this call runs ${runtime.version}.`);
      return null;
    }
    return result.status ?? 1;
  }
}
