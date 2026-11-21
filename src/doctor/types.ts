// What `tmb doctor` works with: the program that runs it, the project it looks at, and the
// outside calls a test replaces (trustmybot/tmb#160).
import type { HostAdapter } from "../adapters/host-adapter.ts";
import type { Program } from "../program.ts";

export type Status = "ok" | "warn" | "fail";
export type Scope = "machine" | "project";

/**
 * How a finding is fixed. `say` is the command or the step, as the Human reads it. `apply`, when
 * set, is what `tmb doctor --fix` does after the Human's yes to `ask`; it returns what it did.
 */
export type Fix = { say: string; ask?: string; apply?: () => string };

export type Finding = {
  /** The check's name, the same for every finding it gives. */
  check: string;
  scope: Scope;
  status: Status;
  /** One line: what is fine or what is wrong. */
  summary: string;
  /** More lines, one per item, when the check found several. */
  details?: string[];
  fix?: Fix;
  /** The check itself failed: likely tmb's own bug, which `tmb feedback` reports. */
  bug?: boolean;
};

export type DoctorEnv = {
  program: Program;
  version: string;
  /** The installed file this program runs from; null when it runs from source. */
  installed: string | null;
  /** The program's machine-wide state folder. */
  stateDir: string;
  /** The command that runs this tmb, as init wires it. */
  tmbCommand: readonly string[];
  adapters: readonly HostAdapter[];
  /** The folder doctor was run in; the project is the one that holds it. */
  cwd: string;
  /** The PATH to look programs up on. */
  path: string;
  platform: NodeJS.Platform;
  isRunning: (pid: number) => boolean;
  /** Another tmb program's version, as its `--version` prints it; null when it does not answer. */
  versionOf: (file: string) => string | null;
  /** Whether `gh` is installed and signed in to github.com. */
  gh: () => { installed: boolean; signedIn: boolean };
  now: () => Date;
  /**
   * The pull requests merged in the repo at `repoDir` since `since`, by number, as GitHub says; `why`
   * when GitHub cannot be asked. Left out, doctor uses git alone (trustmybot/tmb#257).
   */
  mergedPulls?: (repoDir: string, since: string) => { numbers: number[] } | { why: string };
};

/** Checks a session start skips: they start other programs, or bring themselves up to date anyway. */
export const SLOW_CHECKS: ReadonlySet<string> = new Set(["other programs", "code graph", "gh"]);
