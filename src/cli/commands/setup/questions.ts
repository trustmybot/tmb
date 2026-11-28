// The questions onboarding asks on a terminal: each asks until it has an answer it can use, and
// none touches the record.
import { AVAILABLE_REVIEW_MODES, RECOMMENDED_REVIEW_MODE, REVIEW_MODE_COSTS, type RepoPolicies, type ReviewMode, SettingError, validateSetting, WORKSPACE_REVIEW_MODE } from "../../../engine/index.ts";
import type { Ask } from "../../terminal.ts";

/** Asks for one line of text; an empty answer takes the fallback, and with none, asks again. */
export async function askText(ask: Ask, question: string, fallback: string | null): Promise<string | null> {
  for (;;) {
    const answer = await ask(fallback === null ? `${question}: ` : `${question} [${fallback}]: `);
    if (answer === null) return fallback;
    if (answer.trim() !== "") return answer.trim();
    if (fallback !== null) return fallback;
  }
}

/** Asks until the answer passes `validate`, saying why each refused one is wrong. */
export async function askValid<T extends string>(ask: Ask, question: string, fallback: T, validate: (value: unknown) => T, out: (line: string) => void): Promise<T> {
  for (;;) {
    const answer = await askText(ask, question, fallback);
    try {
      return validate(answer);
    } catch (error) {
      if (!(error instanceof SettingError)) throw error;
      out(error.message);
    }
  }
}

/**
 * Asks for the review mode, with one line on what each costs. An empty answer keeps the stored
 * mode, else takes the recommended one; the end of input keeps the stored mode, or none.
 */
export async function askReviewMode(ask: Ask, stored: ReviewMode | null, out: (line: string) => void): Promise<ReviewMode | null> {
  out("The review mode decides who reviews a change and when, and so how many tokens the project uses:");
  for (const mode of AVAILABLE_REVIEW_MODES) out(`  ${mode}: ${REVIEW_MODE_COSTS[mode]}${mode === RECOMMENDED_REVIEW_MODE ? " (recommended)" : ""}`);
  const fallback = stored ?? RECOMMENDED_REVIEW_MODE;
  for (;;) {
    const answer = await ask(`Review mode, one of: ${AVAILABLE_REVIEW_MODES.join(", ")} [${fallback}]: `);
    if (answer === null) return stored;
    if (answer.trim() === "") return fallback;
    try {
      return validateSetting("review_mode", answer.trim());
    } catch (error) {
      if (!(error instanceof SettingError)) throw error;
      out(error.message);
    }
  }
}

/**
 * A repo's own review mode, asked once onboarding offered the change per repo: a mode, or
 * workspace to follow the workspace's. Returns the repo's own mode, undefined to follow the workspace's.
 */
export async function askRepoReviewMode(ask: Ask, repo: string, stored: ReviewMode | undefined, out: (line: string) => void): Promise<ReviewMode | undefined> {
  const choices = [...AVAILABLE_REVIEW_MODES, WORKSPACE_REVIEW_MODE];
  const fallback = stored ?? WORKSPACE_REVIEW_MODE;
  for (;;) {
    const answer = await ask(`Review mode of ${repo}, one of: ${choices.join(", ")} (the workspace's) [${fallback}]: `);
    if (answer === null) return stored;
    const given = answer.trim() === "" ? fallback : answer.trim();
    if (given === WORKSPACE_REVIEW_MODE) return undefined;
    try {
      return validateSetting("review_mode", given);
    } catch (error) {
      if (!(error instanceof SettingError)) throw error;
      out(error.message);
    }
  }
}

/** Whether the Human wants a review mode per repo; offered once, not asked per repo. Yes by default while a repo has one. */
export async function askModePerRepo(ask: Ask, before: RepoPolicies, working: readonly string[]): Promise<boolean> {
  const any = working.some((repo) => before[repo]!.review_mode !== undefined);
  const answer = await ask(`Does any repo take a review mode other than the workspace's? (y/n) [${any ? "y" : "n"}]: `);
  if (answer === null) return any;
  const given = answer.trim().toLowerCase();
  return given === "" ? any : given.startsWith("y");
}

export async function askChecks(ask: Ask, fallback: string[], source: string, out: (line: string) => void): Promise<string[]> {
  out("Checks are the shell commands that must pass before a task closes.");
  if (fallback.length === 0) {
    out(`  ${source}: none.`);
  } else {
    out(`  ${source}:`);
    for (const check of fallback) out(`    ${check}`);
  }
  out("Press Enter to keep these, type none for no checks, or type one command per line and an empty line to finish.");
  const first = (await ask("> "))?.trim();
  if (!first) return fallback;
  if (first === "none") return [];
  const checks = [first];
  for (;;) {
    const next = (await ask("> "))?.trim();
    if (!next) return checks;
    checks.push(next);
  }
}
