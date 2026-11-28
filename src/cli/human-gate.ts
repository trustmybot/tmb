// The Human's own steps from the permission table run only on a terminal, once the Human types yes there
// (trustmybot/tmb#179): an agent's shell has no terminal, so it is refused before the record is
// opened. A run that is truly the Human's with no terminal, such as CI, may set the review mode
// only when unattended mode is on for that run, and only where none is set: an agent can turn
// unattended mode on for its own command, so it never changes a mode the Human chose
// (trustmybot/tmb#223).
import { HUMAN_YES, humanOnlyStep, humanYesQuestion, isHumanStep, mayTake, notConfirmedRefusal, noTerminalRefusal, openProjectStore, readSettings, reviewModeOf, unattendedChangeRefusal } from "../engine/index.ts";
import { optionValue } from "./arguments.ts";
import { HUMAN } from "./command.ts";
import { isFolderName, projectHome } from "./commands/remove.ts";
import type { Runtime } from "./runtime.ts";

/** The one Human-only step an unattended run may take with no terminal. */
const UNATTENDED_STEP = "tmb onboard --review-mode";
const REPO_FLAG = "--repo";

export class HumanGate {
  constructor(private readonly runtime: Runtime) {}

  /** True when the call `argv` may go on. */
  async allows(argv: readonly string[]): Promise<boolean> {
    const step = humanOnlyStep(argv);
    if (step === null) return true;
    // The command line records its caller as the Human: it asks the same check as a tool call.
    if (!mayTake(HUMAN, step.action)) {
      this.runtime.err(`tmb: the Human may not ${step.what}; nothing was done.`);
      return false;
    }
    if (!isHumanStep(step.action)) return true;
    // remove and purge name the project's home folder; the question names its full path.
    let folder: string | undefined;
    if (step.action === "project.remove" || step.action === "project.purge") {
      const given = firstPositional(argv.slice(1));
      // With no name, or a path, the command refuses with its usage, and does nothing.
      if (given === undefined || !isFolderName(given)) return true;
      const home = projectHome(this.runtime.cwd(), given);
      if (!home.ok) {
        this.runtime.err(`tmb ${argv[0]}: ${home.reason}`);
        return false;
      }
      folder = home.dir;
    }
    if (!this.runtime.attended) {
      if (step.command === UNATTENDED_STEP && this.runtime.hookRun().unattended) {
        const mode = reviewModeSet(this.runtime.cwd(), optionValue(argv, REPO_FLAG));
        if (mode === null) return true;
        this.runtime.err(`tmb: ${unattendedChangeRefusal(mode)}`);
        return false;
      }
      this.runtime.err(`tmb: ${noTerminalRefusal(step)}`);
      return false;
    }
    const terminal = this.runtime.openTerminal();
    let answer: string | null;
    try {
      answer = await terminal.ask(humanYesQuestion(step, [...argv], folder));
    } finally {
      terminal.close();
    }
    if (answer?.trim().toLowerCase() === HUMAN_YES) return true;
    this.runtime.err(`tmb: ${notConfirmedRefusal(step)}`);
    return false;
  }
}

/**
 * The review mode `tmb onboard` would change in `projectDir`: with `--repo`, the mode that repo's work
 * follows, else the project's. Null while none is set, or while there is no record yet.
 */
function reviewModeSet(projectDir: string, repo: string | null): string | null {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) return null;
  try {
    return reviewModeOf(readSettings(opened.store), repo);
  } finally {
    opened.store.close();
  }
}

/** The first word of `args` that is not an option or an option's value (`--host <id>`). */
function firstPositional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--host") i += 1;
    else if (!arg.startsWith("--")) return arg;
  }
  return undefined;
}
