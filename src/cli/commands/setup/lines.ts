// The words setup says that depend only on what they are given: lists, host names and the lines on
// the review mode.
import type { HostAdapter } from "../../../adapters/index.ts";
import { AVAILABLE_REVIEW_MODES, type HostRole, type RepoPolicies, type ReviewMode, runningName, workingRepos } from "../../../engine/index.ts";

/** "A", "A and B", "A, B and C". */
export function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function supportedHosts(adapters: readonly HostAdapter[]): string {
  return listed(adapters.map((adapter) => `${adapter.name} (${adapter.id})`));
}

export function hostName(adapters: readonly HostAdapter[], id: string): string {
  return adapters.find((adapter) => adapter.id === id)?.name ?? id;
}

export const notInitialised = () => `tmb is not set up in this project; run ${runningName()} init first`;

/** The refusal every task start meets until the review mode is chosen, said where the Human can act on it. */
export const noReviewModeLine = () =>
  "No review mode is chosen, so no task starts yet: it is your choice, as it decides how many tokens the project uses. " +
  `Run ${runningName()} onboard, or ${runningName()} onboard --review-mode <${AVAILABLE_REVIEW_MODES.join("|")}>, on a terminal.`;

/**
 * Whether some repo tmb works in has no review mode: none for the project, and in a workspace,
 * a repo that is not exempt with no mode of its own either (trustmybot/tmb#263).
 */
export function reviewModeMissing(reviewMode: ReviewMode | null, repos: RepoPolicies | null | undefined): boolean {
  if (reviewMode !== null) return false;
  if (repos === null || repos === undefined) return true;
  return workingRepos(repos).some((name) => repos[name]!.review_mode === undefined);
}

/** Who fills the empty settings when the Human does not, except the review mode, which is the Human's (howReviewModeIsChosen). */
export function howEmptySettingsFill(role: HostRole): string {
  return role === "planner" ? "bro applies the ones it recommends" : "the planner's host applies the ones it recommends at its first session";
}

/**
 * Who chooses the review mode while none is: always the Human, as it decides how many tokens the
 * project uses (trustmybot/tmb#114). A planner host asks them before the first task.
 */
export function howReviewModeIsChosen(role: HostRole, onboard: string): string {
  const who = role === "planner" ? `bro asks you among its onboarding questions at the first session, or run ${onboard}` : `run ${onboard}`;
  return `No review mode is chosen yet: it is your choice, as it decides how many tokens the project uses. To choose it, ${who}; no task starts until it is set.`;
}
