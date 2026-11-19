// `tmb setup`: picks the host, has its adapter wire tmb into the project, then asks the
// questions the workflow needs and stores the answers in the record. It reaches a host only
// through the adapter interface, so it names none.
import { createInterface } from "node:readline";
import type { HostAdapter } from "./adapters/index.ts";
import {
  AVAILABLE_REVIEW_MODES,
  detectBaseBranch,
  detectChecks,
  openProjectStore,
  readSettings,
  type ReviewMode,
  SETTING_NAMES,
  SettingError,
  settingLines,
  type Settings,
  type SettingValues,
  validateSetting,
  writeSetting,
} from "./engine/index.ts";
import { installPushGate } from "./engine/push-gate.ts";
import type { Actor } from "./engine/store/index.ts";

/** Answers given on the command line; each one is used without asking. */
export type SetupFlags = { host?: string; base?: string; reviewMode?: string; checks?: string[]; yes?: boolean };

/** Shows a prompt and reads one line; null once input has ended. */
export type Ask = (prompt: string) => Promise<string | null>;

export type SetupOptions = {
  projectDir: string;
  tmbCommand: readonly string[];
  adapters: readonly HostAdapter[];
  flags: SetupFlags;
  /** Asks on the terminal; null when there is none, so every question takes its default. */
  ask: Ask | null;
  out: (line: string) => void;
};

export class SetupError extends Error {
  override name = "SetupError";
}

const HUMAN: Actor = { kind: "human" };
const NO_SETTINGS: Settings = { host: null, base_branch: null, review_mode: null, checks: null };
const DEFAULT_REVIEW_MODE: ReviewMode = "agile";

/** "A", "A and B", "A, B and C". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function supportedHosts(adapters: readonly HostAdapter[]): string {
  return listed(adapters.map((adapter) => `${adapter.name} (${adapter.id})`));
}

/** The settings a previous setup stored, offered as this run's defaults; none without a record. */
function storedSettings(projectDir: string): Settings {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    if (opened.error.failure === "missing") return NO_SETTINGS;
    throw new SetupError(`cannot set up the record: ${opened.error.message}`);
  }
  try {
    return readSettings(opened.store);
  } finally {
    opened.store.close();
  }
}

/** Checks the flag answers before setup changes anything. Throws SettingError. */
function validatedFlags(flags: SetupFlags): Partial<Omit<SettingValues, "host">> {
  return {
    base_branch: flags.base === undefined ? undefined : validateSetting("base_branch", flags.base),
    review_mode: flags.reviewMode === undefined ? undefined : validateSetting("review_mode", flags.reviewMode),
    checks: flags.checks === undefined || flags.checks.length === 0 ? undefined : validateSetting("checks", flags.checks),
  };
}

async function chooseHost(options: SetupOptions, ask: Ask | null, storedHost: string | null): Promise<HostAdapter> {
  const { adapters, flags, out } = options;
  if (flags.host !== undefined) {
    const named = adapters.find((adapter) => adapter.id === flags.host);
    if (!named) throw new SetupError(`unknown host '${flags.host}'; tmb supports ${supportedHosts(adapters)}`);
    if (!named.detect().installed) throw new SetupError(`${named.name} is not installed; install it, then run tmb setup again`);
    out(`Setting tmb up for ${named.name}, as --host asked.`);
    return named;
  }

  const installed = adapters.filter((adapter) => adapter.detect().installed);
  if (installed.length === 0) {
    throw new SetupError(`no supported host is installed; tmb supports ${supportedHosts(adapters)}. Install one, then run tmb setup again.`);
  }
  if (installed.length === 1) {
    out(`Found ${installed[0]!.name}, the one supported host installed; setting tmb up for it.`);
    return installed[0]!;
  }

  const fallback = installed.find((adapter) => adapter.id === storedHost) ?? installed[0]!;
  if (!ask) {
    out(`Several hosts are installed (${listed(installed.map((adapter) => adapter.name))}); taking ${fallback.name}. Pass --host to choose.`);
    return fallback;
  }
  out("Several supported hosts are installed:");
  installed.forEach((adapter, i) => out(`  ${i + 1}. ${adapter.name} (${adapter.id})`));
  for (;;) {
    const answer = (await ask(`Which host should tmb use? [${fallback.id}] `))?.trim();
    if (!answer) return fallback;
    const chosen = installed.find((adapter) => adapter.id === answer) ?? installed[Number(answer) - 1];
    if (chosen) return chosen;
    out(`'${answer}' is not one of them; answer with its number or its id.`);
  }
}

/** Asks for one line of text; an empty answer takes the fallback, and with none, asks again. */
async function askText(ask: Ask, question: string, fallback: string | null): Promise<string | null> {
  for (;;) {
    const answer = await ask(fallback === null ? `${question}: ` : `${question} [${fallback}]: `);
    if (answer === null) return fallback;
    if (answer.trim() !== "") return answer.trim();
    if (fallback !== null) return fallback;
  }
}

async function askReviewMode(ask: Ask, fallback: ReviewMode, out: (line: string) => void): Promise<ReviewMode> {
  for (;;) {
    const answer = await askText(ask, `Review mode, one of: ${AVAILABLE_REVIEW_MODES.join(", ")}`, fallback);
    try {
      return validateSetting("review_mode", answer);
    } catch (error) {
      if (!(error instanceof SettingError)) throw error;
      out(error.message);
    }
  }
}

async function askChecks(ask: Ask, fallback: string[], source: string, out: (line: string) => void): Promise<string[]> {
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

/** Records each answer that differs from the stored one, then prints the settings in force. */
function storeAnswers(projectDir: string, answers: Partial<SettingValues>, out: (line: string) => void): void {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) throw new SetupError(`cannot store the settings: ${opened.error.message}`);
  try {
    let recorded = 0;
    for (const name of SETTING_NAMES) {
      const value = answers[name];
      if (value !== undefined && writeSetting(opened.store, HUMAN, name, value)) recorded++;
    }
    out("Settings in the record:");
    for (const line of settingLines(readSettings(opened.store))) out(`  ${line}`);
    out(recorded === 0 ? "No setting changed, so nothing was recorded." : `Recorded ${recorded} change${recorded === 1 ? "" : "s"} in the record's audit trail.`);
  } finally {
    opened.store.close();
  }
}

/** Runs setup in the project. Throws SetupError or SettingError, before writing anything when it can. */
export async function runSetup(options: SetupOptions): Promise<void> {
  const { projectDir, flags, out } = options;
  const answered = validatedFlags(flags);
  const stored = storedSettings(projectDir);
  const ask = flags.yes === true ? null : options.ask;

  const adapter = await chooseHost(options, ask, stored.host);
  for (const line of adapter.setup(projectDir, options.tmbCommand)) out(line);
  for (const line of installPushGate(projectDir, options.tmbCommand)) out(line);

  if (!ask) {
    out(
      `${flags.yes === true ? "--yes was given" : "There is no terminal to ask on"}, so each question takes its default; ` +
        "--base, --review-mode and --check set them.",
    );
  }
  const baseFallback = stored.base_branch ?? detectBaseBranch(projectDir);
  const base = answered.base_branch ?? (ask ? await askText(ask, "Base branch, the branch pull requests merge into", baseFallback) : baseFallback);
  const reviewFallback = stored.review_mode ?? DEFAULT_REVIEW_MODE;
  const reviewMode = answered.review_mode ?? (ask ? await askReviewMode(ask, reviewFallback, out) : reviewFallback);
  const checksFallback = stored.checks ?? detectChecks(projectDir);
  const checks =
    answered.checks ?? (ask ? await askChecks(ask, checksFallback, stored.checks === null ? "Detected" : "Stored", out) : checksFallback);

  storeAnswers(projectDir, { host: adapter.id, base_branch: base ?? undefined, review_mode: reviewMode, checks }, out);
  if (base === null) out("No base branch is set: this folder is not a git work tree. Run tmb setup --base <branch> to set one.");
  out(`tmb is set up for ${adapter.name}. Open it in this project to start as the planner.`);
}

/** Asks on the process's terminal, one line per question. */
export function terminalAsk(): { ask: Ask; close: () => void } {
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const next = lines[Symbol.asyncIterator]();
  return {
    ask: async (prompt) => {
      lines.setPrompt(prompt);
      lines.prompt();
      const line = await next.next();
      return line.done ? null : (line.value as string);
    },
    close: () => lines.close(),
  };
}
