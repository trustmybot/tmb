// A step only the Human may take runs only on a terminal, once the Human types yes there
// (trustmybot/tmb#179): an agent's shell has no terminal, so it is refused before the record is
// opened. A run that is truly the Human's with no terminal, such as CI, may set the review mode
// only when unattended mode is on for that run, and only where none is set: an agent can turn
// unattended mode on for its own command, so it never changes a mode the Human chose
// (trustmybot/tmb#223).
import { HUMAN_YES, humanOnlyStep, humanYesQuestion, notConfirmedRefusal, noTerminalRefusal, openProjectStore, readSettings, reviewModeOf, unattendedChangeRefusal } from "../engine/index.ts";
import { optionValue } from "./arguments.ts";
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
      answer = await terminal.ask(humanYesQuestion(step, [...argv]));
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
