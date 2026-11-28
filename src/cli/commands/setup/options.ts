// What a setup run is given: the flags the command line passed, and the project and host it works on.
import type { HostAdapter } from "../../../adapters/index.ts";
import { type FeedbackEnv, type HostRole, type InstallOptions, type ReviewMode, type SettingValues, validateHostRole, validateSetting, WORKSPACE_REVIEW_MODE } from "../../../engine/index.ts";
import type { Ask } from "../../terminal.ts";

/** Answers given on the command line; each one is used without asking. */
export type SetupFlags = {
  host?: string;
  role?: string;
  base?: string;
  reviewMode?: string;
  checks?: string[];
  yes?: boolean;
  /** onboard in a workspace: the repo --base, --check and --exempt set. */
  repo?: string;
  /** onboard in a workspace: the repo --repo names is one tmb does no work in. */
  exempt?: boolean;
  /** onboard: the Human's yes to adding tmb's one line to each pre-push hook that is another tool's (trustmybot/tmb#184). --yes does not give it. */
  addPushGate?: boolean;
};

export type SetupOptions = {
  projectDir: string;
  tmbCommand: readonly string[];
  adapters: readonly HostAdapter[];
  flags: SetupFlags;
  /** Asks on the terminal; null when there is none, so every question takes its default. init never asks, whatever is given. */
  ask: Ask | null;
  out: (line: string) => void;
  /** The ids of the hosts this release supports; init warns for any other. SUPPORTED_HOST_IDS unless given. */
  supportedHostIds?: readonly string[];
  /** The tmb program running setup, which the project is tied to; plain tmb at its package version unless given. */
  program?: { name: string; version: string };
  /** Whether `out` may be coloured: the commands init's next steps name are then painted. Plain unless given. */
  colour?: boolean;
  /** The feedback program's environment: init's end on a terminal gives its notice once; the question is the planner's. Nothing is said unless given. */
  feedback?: FeedbackEnv;
  /** Where init looks for the tools the repo's languages miss; this machine's places unless given. */
  tools?: Pick<InstallOptions, "places">;
};

export class SetupError extends Error {
  override name = "SetupError";
}

/** The program a project is tied to when the caller names none. */
export const DEFAULT_PROGRAM_NAME = "tmb";

/** The base branch a workspace repo takes when its own git names none. */
export const FALLBACK_BASE_BRANCH = "main";

/** The flag answers, checked. */
export type Answered = Partial<Omit<SettingValues, "host" | "host_roles">> & { role?: HostRole };

/** Checks the flag answers before anything is changed. Throws SettingError. */
export function validatedFlags(flags: SetupFlags): Answered {
  return {
    role: flags.role === undefined ? undefined : validateHostRole(flags.role),
    base_branch: flags.base === undefined ? undefined : validateSetting("base_branch", flags.base),
    // With --repo, --review-mode is that repo's own, which the workspace's onboarding reads (trustmybot/tmb#216).
    review_mode: flags.reviewMode === undefined || flags.repo !== undefined ? undefined : validateSetting("review_mode", flags.reviewMode),
    checks: flags.checks === undefined || flags.checks.length === 0 ? undefined : validateSetting("checks", flags.checks),
  };
}

/** --review-mode with --repo: the repo's own mode, or none for workspace. Throws SettingError. */
export function repoModeFlag(value: string): { mode: ReviewMode | undefined } {
  return { mode: value === WORKSPACE_REVIEW_MODE ? undefined : validateSetting("review_mode", value) };
}
