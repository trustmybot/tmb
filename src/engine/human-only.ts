// The Human's own steps from the command line: the rows of the permission table the Human may
// take that change something (both waivers, setting the review mode, granting or revoking a role's
// action, `tmb remove` and `tmb purge`).
// The command line records its caller as the Human, so it runs one only on a terminal, after the
// Human types yes, as an agent's shell has none. tmb reads no shell command.
import { type Action, ACTIONS } from "./permissions.ts";
import { runningName } from "./program.ts";

/** One of the Human's own steps, as the command line was asked to run it. */
export type HumanOnlyStep = {
  /** The action in the permission table. */
  action: Action;
  /** The command, as `tmb task waive`; a message names the running program in its place. */
  command: string;
  /** What it does, in a few words: "waive a task's review". */
  what: string;
};

/** The word a person types to go on with a Human-only step. */
export const HUMAN_YES = "yes";

const REVIEW_MODE_FLAG = "--review-mode";

function step(action: Action, command: string): HumanOnlyStep {
  return { action, command, what: ACTIONS[action] };
}

/**
 * The Human-only step `args` asks for, or null. `args` is what follows the program's name, as
 * `["task", "waive", "T-3", "--reason", "x"]`. `tmb update` is not one.
 */
export function humanOnlyStep(args: readonly string[]): HumanOnlyStep | null {
  const [command, action] = args;
  if (command === "feature" && action === "waive") return step("feature.waive", "tmb feature waive");
  if (command === "task" && action === "waive") return step("task.waive", "tmb task waive");
  if (command === "role" && (action === "grant" || action === "revoke")) return step("permissions.manage", `tmb role ${action}`);
  if (command === "remove") return step("project.remove", "tmb remove");
  if (command === "purge") return step("project.purge", "tmb purge");
  if (command === "onboard" && args.some((arg) => arg === REVIEW_MODE_FLAG || arg.startsWith(`${REVIEW_MODE_FLAG}=`))) {
    return step("settings.review-mode", "tmb onboard --review-mode");
  }
  return null;
}

/** The step's command as a message names it: under the running program's name, as `tmb-dev task waive`. */
function spoken(step: HumanOnlyStep): string {
  return step.command.replace(/^tmb /, `${runningName()} `);
}

/** The refusal of a Human-only step run with no terminal: nothing was done, and the Human runs it in their own terminal. */
export function noTerminalRefusal(step: HumanOnlyStep): string {
  return (
    `${spoken(step)} is a step only the Human may take (to ${step.what}): it runs only on a terminal, where the Human types ${HUMAN_YES}. ` +
    "There is no terminal here, so nothing was done. An agent asks the Human to run it in their own terminal."
  );
}

/**
 * The refusal of an unattended run with no terminal that would change a review mode already set
 * (trustmybot/tmb#223): unattended mode only sets one where none is set, as for a fresh project in CI.
 */
export function unattendedChangeRefusal(mode: string): string {
  return (
    `the review mode is already ${mode}, and unattended mode only sets one where none is set, so nothing was done. ` +
    `Changing it is a step only the Human may take: it runs only on a terminal, where the Human types ${HUMAN_YES}.`
  );
}

/** The question a Human-only step asks on a terminal before it runs. */
export function humanYesQuestion(step: HumanOnlyStep, args: readonly string[], folder?: string): string {
  const where = folder === undefined ? "" : ` Project folder: ${folder}.${step.action === "project.purge" ? ` Its record there cannot be recovered.` : ""}`;
  return `Only the Human may ${step.what}.${where} Type ${HUMAN_YES} to run ${runningName()} ${args.join(" ")}: `;
}

/** The refusal of a Human-only step whose question was answered with anything but yes. */
export function notConfirmedRefusal(step: HumanOnlyStep): string {
  return `${spoken(step)} needs ${HUMAN_YES} typed on the terminal; nothing was done.`;
}
