// Preparing a project for tmb, in two commands. `tmb init` picks the host, has its adapter wire
// tmb into the project, adds git's push hook and indexes the code graph; on a terminal it asks
// one question, the review mode, which is the Human's choice, and leaves the other settings
// empty, for the planner to fill at the first session start.
// `tmb onboard` asks the questions the workflow needs and stores the answers; it can be run
// again at any time. They reach a host only through the adapter interface, so they name none.
import { createInterface } from "node:readline";
import { type HostAdapter, SUPPORTED_HOST_IDS } from "./adapters/index.ts";
import {
  AVAILABLE_REVIEW_MODES,
  chooseReviewMode,
  DEFAULT_HOST_ROLE,
  detectBaseBranch,
  HOST_ROLES,
  type HostRole,
  detectChecks,
  openProjectStore,
  readSettings,
  RECOMMENDED_REVIEW_MODE,
  REVIEW_MODE_COSTS,
  type ReviewMode,
  type ReviewModeChooser,
  SETTING_NAMES,
  SettingError,
  settingLines,
  type Settings,
  type SettingValues,
  tieProgram,
  validateHostRole,
  validateSetting,
  writeSetting,
} from "./engine/index.ts";
import { firstRunAtInit } from "./engine/feedback/first-run.ts";
import type { FeedbackEnv } from "./engine/feedback/index.ts";
import { indexProject } from "./engine/graph/fresh.ts";
import { emptySettings } from "./engine/handlers/settings.ts";
import { HandlerError } from "./engine/handlers/errors.ts";
import { MARK_CONTEXT, requiredMarkOn, requireMarkHowTo } from "./engine/handlers/marks.ts";
import { installPushGate } from "./engine/push-gate.ts";
import type { Actor } from "./engine/store/index.ts";
import { version as packageVersion } from "./version.ts";
import { Paint } from "./engine/doors/help.ts";

/** Answers given on the command line; each one is used without asking. */
export type SetupFlags = { host?: string; role?: string; base?: string; reviewMode?: string; checks?: string[]; yes?: boolean };

/** Shows a prompt and reads one line; null once input has ended. */
export type Ask = (prompt: string) => Promise<string | null>;

export type SetupOptions = {
  projectDir: string;
  tmbCommand: readonly string[];
  adapters: readonly HostAdapter[];
  flags: SetupFlags;
  /** Asks on the terminal; null when there is none, so every question takes its default. init asks only for the review mode. */
  ask: Ask | null;
  out: (line: string) => void;
  /** The ids of the hosts this release supports; init warns for any other. SUPPORTED_HOST_IDS unless given. */
  supportedHostIds?: readonly string[];
  /** The tmb program running setup, which the project is tied to; plain tmb at its package version unless given. */
  program?: { name: string; version: string };
  /** Whether `out` may be coloured: the commands init's next steps name are then painted. Plain unless given. */
  colour?: boolean;
  /** The feedback program's environment: init's end on a terminal tells or asks about it once. Nothing is said unless given. */
  feedback?: FeedbackEnv;
};

export class SetupError extends Error {
  override name = "SetupError";
}

const HUMAN: Actor = { kind: "human" };
const NO_SETTINGS: Settings = { host: null, host_roles: null, base_branch: null, review_mode: null, checks: null };
const NOT_INITIALISED = "tmb is not set up in this project; run tmb init first";

/** The flag answers, checked. */
type Answered = Partial<Omit<SettingValues, "host" | "host_roles">> & { role?: HostRole };

/** "A", "A and B", "A, B and C". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function supportedHosts(adapters: readonly HostAdapter[]): string {
  return listed(adapters.map((adapter) => `${adapter.name} (${adapter.id})`));
}

function hostName(adapters: readonly HostAdapter[], id: string): string {
  return adapters.find((adapter) => adapter.id === id)?.name ?? id;
}

/** The settings stored so far; null when the project has no record yet. */
function storedSettings(projectDir: string): Settings | null {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    if (opened.error.failure === "missing") return null;
    throw new SetupError(`cannot read the record: ${opened.error.message}`);
  }
  try {
    return readSettings(opened.store);
  } finally {
    opened.store.close();
  }
}

/** Checks the flag answers before anything is changed. Throws SettingError. */
function validatedFlags(flags: SetupFlags): Answered {
  return {
    role: flags.role === undefined ? undefined : validateHostRole(flags.role),
    base_branch: flags.base === undefined ? undefined : validateSetting("base_branch", flags.base),
    review_mode: flags.reviewMode === undefined ? undefined : validateSetting("review_mode", flags.reviewMode),
    checks: flags.checks === undefined || flags.checks.length === 0 ? undefined : validateSetting("checks", flags.checks),
  };
}

/** The host init wires: the one --host names, else the one installed, else the stored one, else the first. Never asks. */
function chooseHost(options: SetupOptions, storedHost: string | null): HostAdapter {
  const { adapters, flags, out } = options;
  if (flags.host !== undefined) {
    const named = adapters.find((adapter) => adapter.id === flags.host);
    if (!named) throw new SetupError(`unknown host '${flags.host}'; tmb supports ${supportedHosts(adapters)}`);
    if (!named.detect().installed) throw new SetupError(`${named.name} is not installed; install it, then run tmb init again`);
    out(`Setting tmb up for ${named.name}, as --host asked.`);
    return named;
  }

  const installed = adapters.filter((adapter) => adapter.detect().installed);
  if (installed.length === 0) {
    throw new SetupError(`no supported host is installed; tmb supports ${supportedHosts(adapters)}. Install one, then run tmb init again.`);
  }
  if (installed.length === 1) {
    out(`Found ${installed[0]!.name}, the one supported host installed; setting tmb up for it.`);
    return installed[0]!;
  }
  const chosen = installed.find((adapter) => adapter.id === storedHost) ?? installed[0]!;
  out(`Several hosts are installed (${listed(installed.map((adapter) => adapter.name))}); taking ${chosen.name}. Pass --host to choose.`);
  return chosen;
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

/** Asks until the answer passes `validate`, saying why each refused one is wrong. */
async function askValid<T extends string>(ask: Ask, question: string, fallback: T, validate: (value: unknown) => T, out: (line: string) => void): Promise<T> {
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
async function askReviewMode(ask: Ask, stored: ReviewMode | null, out: (line: string) => void): Promise<ReviewMode | null> {
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

/** Ties the project to the program running init, and says so when it moved from another. */
function tieToProgram(projectDir: string, program: { name: string; version: string }, command: readonly string[], out: (line: string) => void): void {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) throw new SetupError(`cannot tie the project to ${program.name}: ${opened.error.message}`);
  try {
    const { from } = tieProgram(opened.store, HUMAN, { program: program.name, version: program.version, command: [...command] });
    if (from !== null && from.program !== program.name) out(`Moved this project from ${from.program} ${from.version} to ${program.name} ${program.version}.`);
    // Another version of the same program, run the same way, is recorded (trustmybot/tmb#128) but not worth a line.
    const rewired = from === null || from.program !== program.name || JSON.stringify(from.command) !== JSON.stringify([...command]);
    if (rewired) out(`This project runs ${program.name}: its hooks and tool server call ${command.join(" ")}.`);
  } finally {
    opened.store.close();
  }
}

/** Records each answer that differs from the stored one; returns how many it recorded. `via` is the command the Human answered in. */
function storeAnswers(projectDir: string, answers: Partial<SettingValues>, via: ReviewModeChooser): number {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) throw new SetupError(`cannot store the settings: ${opened.error.message}`);
  try {
    let recorded = 0;
    for (const name of SETTING_NAMES) {
      const value = answers[name];
      if (value === undefined) continue;
      const wrote = name === "review_mode" ? chooseReviewMode(opened.store, HUMAN, value, via) : writeSetting(opened.store, HUMAN, name, value);
      if (wrote) recorded++;
    }
    return recorded;
  } finally {
    opened.store.close();
  }
}

/** Prints the settings in force and how many changes this run recorded. */
function printSettings(projectDir: string, recorded: number, out: (line: string) => void): void {
  out("Settings in the record:");
  for (const line of settingLines(storedSettings(projectDir) ?? NO_SETTINGS)) out(`  ${line}`);
  out(recorded === 0 ? "No setting changed, so nothing was recorded." : `Recorded ${recorded} change${recorded === 1 ? "" : "s"} in the record's audit trail.`);
}

/** Indexes the base branch into the code graph; a project that cannot be indexed yet is told why, and the run goes on. */
async function indexCodeGraph(projectDir: string, out: (line: string) => void): Promise<void> {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) throw new SetupError(`cannot index the code graph: ${opened.error.message}`);
  try {
    const stats = await indexProject(projectDir, opened.store, { rebuild: false });
    out(`Indexed the code graph of ${stats.baseBranch} at ${stats.commit.slice(0, 12)}: ${stats.files} files, ${stats.symbols} symbols.`);
  } catch (error) {
    // The settings are stored by now, and every lookup indexes the graph itself, so a failed index never fails the run.
    const message = error instanceof Error ? error.message : String(error);
    out(
      error instanceof HandlerError
        ? `The code graph is not indexed yet: ${message}. Lookups index it once the base branch has a commit.`
        : `The code graph could not be indexed now (${message}); the first lookup indexes it.`,
    );
  } finally {
    opened.store.close();
  }
}

/** What init did, for the lines that close the run. */
type Initialised = {
  adapter: HostAdapter;
  role: HostRole;
  recorded: number;
  /** Said first and last when the host is not supported in this release. */
  warning: string | null;
};

/**
 * Wires one host into the project in its role. Asks nothing and sets none of the project's
 * settings: those are the planner's at the first session start, or the Human's with onboard.
 */
async function initProject(options: SetupOptions): Promise<Initialised> {
  const { projectDir, flags, out } = options;
  const answered = validatedFlags({ role: flags.role });
  const stored = storedSettings(projectDir) ?? NO_SETTINGS;

  const adapter = chooseHost(options, stored.host);
  const supported = options.supportedHostIds ?? SUPPORTED_HOST_IDS;
  const warning = supported.includes(adapter.id)
    ? null
    : `Warning: ${adapter.name} is not supported yet in this release: tmb sets it up so you can try it, but nothing guarantees it works.`;
  if (warning) out(warning);

  // The wiring: the host's registrations, which create the record, then git's push hook.
  for (const line of adapter.setup(projectDir, options.tmbCommand)) out(line);
  for (const line of installPushGate(projectDir, options.tmbCommand)) out(line);
  tieToProgram(projectDir, options.program ?? { name: "tmb", version: packageVersion }, options.tmbCommand, out);

  // The role is the host's main agent's: kept from an earlier init of this host unless --role names another.
  const role = answered.role ?? stored.host_roles?.[adapter.id] ?? DEFAULT_HOST_ROLE;
  const hostRoles = { ...(stored.host_roles ?? {}), [adapter.id]: role };
  const recorded = storeAnswers(projectDir, { host: adapter.id, host_roles: hostRoles }, "init");
  // With no base branch set, the graph is built from the one tmb detects.
  if ((stored.base_branch ?? detectBaseBranch(projectDir)) !== null) await indexCodeGraph(projectDir, out);
  return { adapter, role, recorded, warning };
}

/** What onboard stored, for the lines that close the run. */
type Onboarded = { recorded: number; base: string | null; role: HostRole; reviewMode: ReviewMode | null };

/** Asks each question, offering the stored value, and stores the answers. Needs a project init has prepared. */
async function onboardProject(options: SetupOptions): Promise<Onboarded> {
  const { projectDir, adapters, flags, out } = options;
  const answered = validatedFlags(flags);
  const stored = storedSettings(projectDir);
  if (stored === null || stored.host === null) throw new SetupError(NOT_INITIALISED);
  const hostId = flags.host ?? stored.host;
  const name = hostName(adapters, hostId);
  if (hostId !== stored.host && stored.host_roles?.[hostId] === undefined) {
    throw new SetupError(`${name} is not set up in this project; run tmb init --host ${hostId} first`);
  }
  const ask = flags.yes === true ? null : options.ask;
  if (!ask) {
    out(
      `${flags.yes === true ? "--yes was given" : "There is no terminal to ask on"}, so each question takes its default, except the review mode, which is yours to choose; ` +
        "--role, --base, --review-mode and --check set them.",
    );
  }

  const roleFallback = stored.host_roles?.[hostId] ?? DEFAULT_HOST_ROLE;
  const role =
    answered.role ??
    (ask ? await askValid(ask, `Role of ${name}'s main agent, one of: ${HOST_ROLES.join(", ")}`, roleFallback, validateHostRole, out) : roleFallback);
  const baseFallback = stored.base_branch ?? detectBaseBranch(projectDir);
  const base = answered.base_branch ?? (ask ? await askText(ask, "Base branch, the branch pull requests merge into", baseFallback) : baseFallback);
  // The review mode is the Human's choice: with no one to ask and no --review-mode, it stays as it is, set or not.
  const reviewMode = answered.review_mode ?? (ask ? await askReviewMode(ask, stored.review_mode, out) : stored.review_mode);
  const checksFallback = stored.checks ?? detectChecks(projectDir);
  const checks =
    answered.checks ?? (ask ? await askChecks(ask, checksFallback, stored.checks === null ? "Detected" : "Stored", out) : checksFallback);

  const hostRoles = { ...(stored.host_roles ?? {}), [hostId]: role };
  const recorded = storeAnswers(projectDir, { host_roles: hostRoles, base_branch: base ?? undefined, review_mode: reviewMode ?? undefined, checks }, "onboard");
  // A new base branch has its own code graph; init indexed the old one.
  if (base !== null && base !== stored.base_branch) await indexCodeGraph(projectDir, out);
  return { recorded, base, role, reviewMode };
}

/** The refusal every task start meets until the review mode is chosen, said where the Human can act on it. */
const NO_REVIEW_MODE_LINE =
  "No review mode is chosen, so no task starts yet: it is your choice, as it decides how many tokens the project uses. " +
  `Run tmb onboard on a terminal, or tmb onboard --review-mode <${AVAILABLE_REVIEW_MODES.join("|")}> --yes.`;

function sayNoReviewMode(reviewMode: ReviewMode | null, out: (line: string) => void): void {
  if (reviewMode === null) out(NO_REVIEW_MODE_LINE);
}

/** init's one question: the review mode, asked on a terminal when none is chosen. Returns how many changes it recorded. */
async function askReviewModeAtInit(options: SetupOptions): Promise<number> {
  const { projectDir, ask, out } = options;
  if (ask === null || (storedSettings(projectDir) ?? NO_SETTINGS).review_mode !== null) return 0;
  const reviewMode = await askReviewMode(ask, null, out);
  return reviewMode === null ? 0 : storeAnswers(projectDir, { review_mode: reviewMode }, "init");
}

function sayNoBase(base: string | null, out: (line: string) => void): void {
  if (base === null) out("No base branch is set: this folder is not a git work tree. Run tmb onboard --base <branch> to set one.");
}

/**
 * The steps the Human must take before the host runs tmb, then what to do next: start the host
 * here and, for the planner, greet bro. `code` paints a command to run or text to send.
 */
function sayReady(projectDir: string, adapter: HostAdapter, role: HostRole, code: (text: string) => string, out: (line: string) => void): void {
  const steps = adapter.pendingSteps?.(projectDir) ?? [];
  if (steps.length > 0) {
    out(`Before ${adapter.name} runs tmb in this project, you need to:`);
    for (const step of steps) out(`  - ${step}`);
  }
  out(`tmb is set up for ${adapter.name}. Next:`);
  if (role === "planner") {
    out(`  1. Run ${code(adapter.command)} in this folder.`);
    out(`  2. Send ${code("@bro")}.`);
  } else {
    out(`  1. Run ${code(adapter.command)} in this folder; it starts as the ${role}.`);
  }
}

/** Who fills the empty settings when the Human does not, except the review mode, which is the Human's (howReviewModeIsChosen). */
function howEmptySettingsFill(role: HostRole): string {
  return role === "planner" ? "bro applies the ones it recommends" : "the planner's host applies the ones it recommends at its first session";
}

/**
 * Who chooses the review mode while none is: always the Human, as it decides how many tokens the
 * project uses (trustmybot/tmb#114). A planner host asks them before the first task.
 */
function howReviewModeIsChosen(role: HostRole, onboard: string): string {
  const who = role === "planner" ? `bro asks you before the first task, or run ${onboard}` : `run ${onboard}`;
  return `No review mode is chosen yet: it is your choice, as it decides how many tokens the project uses. To choose it, ${who}; no task starts until it is set.`;
}

/** `tmb init`. Throws SetupError or SettingError, before writing anything when it can. */
export async function runInit(options: SetupOptions): Promise<void> {
  const { projectDir, out } = options;
  const init = await initProject(options);
  const chosen = await askReviewModeAtInit(options);
  printSettings(projectDir, init.recorded + chosen, out);
  const paint = new Paint(options.colour === true);
  const code = (text: string) => `\`${paint.command(text)}\``;
  sayReady(projectDir, init.adapter, init.role, code, out);
  const onboard = code(`${options.program?.name ?? "tmb"} onboard`);
  const settings = storedSettings(projectDir) ?? NO_SETTINGS;
  // The review mode is the Human's to choose; the planner applies only the others.
  const empty = emptySettings(settings)
    .filter((name) => name !== "review_mode")
    .map((name) => name.replace("_", " "));
  if (empty.length === 0) {
    out(`To change the settings, run ${onboard}.`);
  } else {
    out(`The settings are still empty: ${listed(empty)}; ${howEmptySettingsFill(init.role)}. To set them yourself, run ${onboard}.`);
  }
  if (settings.review_mode === null) out(howReviewModeIsChosen(init.role, onboard));
  // The feedback program's notice or question, once per program on this machine, only with someone to answer.
  if (options.ask !== null && options.feedback !== undefined) await firstRunAtInit(options.feedback, options.ask, out);
  // Said again last, so it is not lost above init's other lines.
  if (init.warning) out(init.warning);
}

/** `tmb onboard`. Throws SetupError or SettingError, before writing anything when it can. */
export async function runOnboard(options: SetupOptions): Promise<void> {
  const { projectDir, out } = options;
  const onboarded = await onboardProject(options);
  printSettings(projectDir, onboarded.recorded, out);
  sayNoBase(onboarded.base, out);
  sayNoReviewMode(onboarded.reviewMode, out);
  sayMarkRule(projectDir, onboarded.base, out);
}

/** Whether the base branch's protection requires tmb's mark on GitHub, and how to turn it on; nothing when origin is no GitHub repository. */
function sayMarkRule(projectDir: string, base: string | null, out: (line: string) => void): void {
  if (base === null) return;
  const answer = requiredMarkOn(projectDir, base);
  if (answer === null) return;
  if ("unknown" in answer) {
    out(`tmb could not tell whether branch protection on ${base} requires ${MARK_CONTEXT}: ${answer.unknown}`);
    return;
  }
  if (answer.required) {
    out(`Branch protection on ${base} requires ${MARK_CONTEXT}, the mark tmb sets on GitHub on each commit it reviewed.`);
    return;
  }
  out(`${requireMarkHowTo(base)} GitHub offers this rule on a private repository only on its paid plans.`);
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
