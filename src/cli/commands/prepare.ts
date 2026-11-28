// What `tmb init` and `tmb onboard` share: the setup options they run with, from the call's flags.
import { HOST_ADAPTERS } from "../../adapters/index.ts";
import type { FeedbackEnv } from "../../engine/index.ts";
import { ParsedCommand } from "../command.ts";
import { colourOn } from "../help.ts";
import type { Runtime } from "../runtime.ts";
import type { Ask } from "../terminal.ts";
import type { SetupFlags, SetupOptions } from "./setup.ts";

export const INIT_OPTIONS = { host: { type: "string" }, role: { type: "string" } } as const;

export abstract class PrepareCommand extends ParsedCommand<SetupFlags> {
  constructor(protected readonly runtime: Runtime) {
    super();
  }

  /** The setup run's options in the folder the command runs in. */
  protected setupOptions(flags: SetupFlags, ask: Ask | null, feedback: FeedbackEnv | undefined): SetupOptions {
    const { runtime } = this;
    return {
      projectDir: runtime.cwd(),
      tmbCommand: runtime.tmbCommand(),
      program: runtime.runningProgram(),
      adapters: HOST_ADAPTERS,
      flags,
      ask,
      out: runtime.out,
      colour: colourOn(runtime.ports.stdout, runtime.env),
      feedback,
    };
  }
}
