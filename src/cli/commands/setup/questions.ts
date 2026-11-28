// The questions onboarding asks on a terminal: each asks until it has an answer it can use, and
// none touches the record.
import { AVAILABLE_REVIEW_MODES, DEFAULT_ISSUE_SYNC, ISSUE_SYNC_COSTS, ISSUE_SYNC_MODES, type IssueSync, RECOMMENDED_REVIEW_MODE, REVIEW_MODE_COSTS, type RepoPolicies, type ReviewMode, SettingError, validateSetting, WORKSPACE_REVIEW_MODE } from "../../../engine/index.ts";
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
 * Asks how much of the remote's issues the record copies in, with one line on what each costs. An
 * empty answer keeps the stored choice, else takes the default; the end of input keeps the stored one, or none.
 */
export async function askIssueSync(ask: Ask, stored: IssueSync | null, out: (line: string) => void): Promise<IssueSync | null> {
  out("Issue sync decides how much of the GitHub repo's issues tmb copies into its record:");
  for (const mode of ISSUE_SYNC_MODES) out(`  ${mode}: ${ISSUE_SYNC_COSTS[mode]}${mode === DEFAULT_ISSUE_SYNC ? " (the default)" : ""}`);
  const fallback = stored ?? DEFAULT_ISSUE_SYNC;
  for (;;) {
    const answer = await ask(`Issue sync, one of: ${ISSUE_SYNC_MODES.join(", ")} [${fallback}]: `);
    if (answer === null) return stored;
    if (answer.trim() === "") return fallback;
    try {
      return validateSetting("issue_sync", answer.trim());
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

/**
 * Asks for the shared folders: the folders, inside the repo, every task worktree links from the main
 * folder, such as its dependency folders. tmb detects none; the planner names them from the repo's toolchain.
 */
export async function askSharedFolders(ask: Ask, fallback: string[], source: string, out: (line: string) => void): Promise<string[]> {
  out("Shared folders are the folders, such as the dependency folders, that every task worktree links from the main folder instead of installing them again.");
  out(fallback.length === 0 ? `  ${source}: none.` : `  ${source}: ${fallback.join(", ")}`);
  out("Press Enter to keep these, type none for no shared folders, or type the folders separated by spaces.");
  for (;;) {
    const answer = (await ask("> "))?.trim();
    if (!answer) return fallback;
    if (answer === "none") return [];
    try {
      return validateSetting("shared_folders", answer.split(/\s+/));
    } catch (error) {
      if (!(error instanceof SettingError)) throw error;
      out(error.message);
    }
  }
}
