// Preparing a project for tmb, in two commands: `tmb init` wires tmb in and asks nothing; `tmb
// onboard` asks the questions the workflow needs and stores the answers. They reach a host only
// through the adapter interface, so they name none.
import { InitRun } from "./setup/init-run.ts";
import { OnboardRun } from "./setup/onboard-run.ts";
import type { SetupOptions } from "./setup/options.ts";

export { SetupError, type SetupFlags, type SetupOptions } from "./setup/options.ts";
export type { Ask } from "../terminal.ts";

/** `tmb init`. Throws SetupError or SettingError, before writing anything when it can. */
export function runInit(options: SetupOptions): Promise<void> {
  return new InitRun(options).run();
}

/** `tmb onboard`. Throws SetupError or SettingError, before writing anything when it can. */
export function runOnboard(options: SetupOptions): Promise<void> {
  return new OnboardRun(options).run();
}
