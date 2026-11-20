#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { HookRun } from "./adapters/host-adapter.ts";
import { adapterById, DEFAULT_HOST_ID, findPluginDb, HOST_ADAPTERS, migratePluginProject } from "./adapters/index.ts";
import {
  CONFIG_USAGE,
  INDEX_USAGE,
  isRecordCommand,
  type Output,
  RECORD_ACTIONS,
  RECORD_USAGE,
  runConfigCommand,
  runIndexCommand,
  runRecordCommand,
} from "./engine/doors/command-line.ts";
import {
  actionUsage,
  asksHelp,
  colourOn,
  detailHelpText,
  type HelpGroup,
  OTHER_NAMES,
  Paint,
  shortHelpText,
  unknownCommandText,
  usageErrorText,
} from "./engine/doors/help.ts";
import { DEFAULT_PORT, startDashboard } from "./engine/doors/dashboard/server.ts";
import { FEEDBACK_USAGE, runFeedbackCommand } from "./engine/doors/feedback.ts";
import { type FeedbackEnv, feedbackEnv, keepLastError } from "./engine/feedback/index.ts";
import { serveTools } from "./engine/doors/tool-server.ts";
import { openProjectStore, projectRootOf } from "./engine/project.ts";
import { judgePush, removePushGates } from "./engine/push-gate.ts";
import { runInit, runOnboard, type SetupOptions, terminalAsk } from "./setup.ts";
import { runningProgram } from "./program.ts";
import { refreshProject } from "./refresh.ts";
import { runFront } from "./tool-front.ts";
import { HANDED_OVER_VARIABLE, INSTALLED_FILE_VARIABLE, installedVersionOf, isCompiledEntry, Updater, updaterOptions } from "./update.ts";
import { version, versionLine } from "./version.ts";
import type { HostAdapter } from "./adapters/host-adapter.ts";

/** Each command's detail, as `tmb help <command>` and `tmb <command> --help` show it. */
const USAGE: Record<string, string> = {
  ...RECORD_USAGE,
  config: CONFIG_USAGE,
  index: INDEX_USAGE,
  init: `  tmb init [--host <id>] [--role planner|reviewer]
                            Prepare the project in the current directory: create its record,
                            wire one host in its role, add git's push hook and index the code
                            graph. Asks nothing and leaves the settings empty: the planner
                            applies the ones it recommends at its first session. Run it once
                            per host to use two hosts on one record`,
  onboard: `  tmb onboard [--host <id>] [--role planner|reviewer] [--base <branch>] [--review-mode <mode>]
              [--check <command>]... [--repo <name> [--exempt]] [--yes]
                            Set the project's settings: a host's role, the base branch, the
                            review mode and the checks. In a workspace of several repos, --repo
                            names the repo --base and --check set, and --exempt makes tmb do no
                            work in it. Asks on a terminal, else keeps the stored values; run it
                            again at any time`,
  remove: `  tmb remove [--host <id>]  Undo what init added for one host, or for every host and the
                            push gate when none is named; the record is kept`,
  migrate: `  tmb migrate [--from <plugin db>] [--repo <name>] [--json]
                            Copy a tmb plugin project's records into this project's new
                            record; the plugin's database is left untouched`,
  dashboard: `  tmb dashboard [--port <n>] [--project <dir>]
                            Serve the record as a local web page, on port ${DEFAULT_PORT}
                            unless named; 0 picks a free one`,
  feedback: FEEDBACK_USAGE,
  update: `  tmb update [--check]      Look for a newer build on this program's channel now and apply it
                            when no session of it is running and no task is open; with
                            --check, only report. tmb follows stable, tmb-rc rc and tmb-dev
                            dev; tmb-<version> never updates`,
  help: `  tmb help [<command>] [--all]
                            Show the commands, or one command's detail; with --all, also
                            the commands only a host or git calls
  tmb --version             Print the version`,
  mcp: `  tmb mcp --host <id> [--project <dir>]
                            Serve the record's tools over stdio (the host runs this)`,
  hook: `  tmb hook <event> [--host <id>]
                            Answer a host event (the host runs this; reads JSON on stdin);
                            with no host, the event is the first host's tmb wired`,
  "pre-push": `  tmb pre-push <remote> [<url>]
                            Judge a push (git's pre-push hook runs this; reads its ref lines on stdin)`,
};

/** The short help's groups, most used first. */
const GROUPS: HelpGroup[] = [
  {
    heading: "Project",
    commands: [
      { name: "init", summary: "Prepare this project for tmb" },
      { name: "onboard", summary: "Set the project's settings" },
      { name: "config", summary: "Print the project's settings" },
      { name: "remove", summary: "Undo what init added" },
      { name: "migrate", summary: "Copy a plugin project's records" },
    ],
  },
  {
    heading: "Work",
    commands: [
      { name: "issue", summary: "Create, list, show, close and reopen issues" },
      { name: "note", summary: "Add a note or a decision to an issue" },
      { name: "feature", summary: "Start and review feature branches" },
      { name: "task", summary: "Start, close and review tasks" },
      { name: "search", summary: "Search issues, notes and decisions" },
      { name: "history", summary: "Show every change to an issue or note" },
    ],
  },
  {
    heading: "Code",
    commands: [
      { name: "graph", summary: "Find code by symbol, file or topic" },
      { name: "index", summary: "Index the base branch now" },
    ],
  },
  {
    heading: "Program",
    commands: [
      { name: "dashboard", summary: "Open the dashboard" },
      { name: "update", summary: "Look for a newer build" },
      { name: "feedback", summary: "Report a bug in tmb itself" },
      { name: "help", summary: "Show help for a command" },
    ],
  },
];

/** Commands only a host or git calls: left out of the short help and of the tips; `tmb help --all` lists them last. */
const HIDDEN_GROUP: HelpGroup = {
  heading: "Called by a host or git",
  commands: [
    { name: "mcp", summary: "Serve the record's tools to a host" },
    { name: "hook", summary: "Answer a host event" },
    { name: "pre-push", summary: "Judge a push for git's pre-push hook" },
  ],
};

/** The commands a typo may be told of: every listed one, never a hidden one. */
const LISTED = GROUPS.flatMap((group) => group.commands.map((command) => command.name));
const KNOWN = new Set([...LISTED, ...HIDDEN_GROUP.commands.map((command) => command.name)]);
const VERSION_WORDS = new Set(["--version", "-v", "version"]);

const stdout = (text: string) => process.stdout.write(`${text}\n`);
const stderr = (text: string) => process.stderr.write(`${text}\n`);
const outPaint = () => new Paint(colourOn(process.stdout));
const errPaint = () => new Paint(colourOn(process.stderr));
const OUTPUT: Output = { out: stdout, err: stderr, colour: colourOn(process.stderr) };

/** The short help, with the hidden commands last when `all`. */
function shortHelp(paint: Paint, all: boolean): string {
  return shortHelpText(all ? [...GROUPS, HIDDEN_GROUP] : GROUPS, paint);
}

/**
 * Writes the help for `command`, or for one of its actions, on stdout; a name it does not know
 * is answered as a typo on stderr with exit code 2.
 */
function writeCommandHelp(command: string, action: string | undefined): number {
  if (!KNOWN.has(command)) {
    process.stderr.write(unknownCommandText("tmb", command, LISTED, errPaint(), OTHER_NAMES));
    return 2;
  }
  const actions = isRecordCommand(command) ? RECORD_ACTIONS[command] : undefined;
  if (actions !== undefined && action !== undefined && !actions.includes(action)) {
    process.stderr.write(unknownCommandText(`tmb ${command}`, action, actions, errPaint()));
    return 2;
  }
  process.stdout.write(detailHelpText(actionUsage(USAGE[command]!, command, actions === undefined ? undefined : action), outPaint()));
  return 0;
}

/** `tmb help [<command> [<action>]] [--all]`. */
function runHelpCommand(args: string[]): number {
  const all = args.includes("--all");
  const [command, action] = args.filter((arg) => !arg.startsWith("-"));
  if (command === undefined) {
    if (asksHelp(args)) return writeCommandHelp("help", undefined);
    process.stdout.write(shortHelp(outPaint(), all));
    return 0;
  }
  return writeCommandHelp(command, action);
}

/** The command that runs this tmb: the executable, plus this file when run from source. */
function ownCommand(): string[] {
  return isCompiledEntry(Bun.main) ? [process.execPath] : [process.execPath, Bun.main];
}

/**
 * The command a project's wiring calls: this tmb, or the installed file when this is a kept build
 * serving a handed-over call, so wiring never names a kept build.
 */
function tmbCommand(): string[] {
  const installed = process.env[HANDED_OVER_VARIABLE] === "1" ? process.env[INSTALLED_FILE_VARIABLE] : undefined;
  return installed ? [installed] : ownCommand();
}

/** The processes above this one, nearest first, up to `depth`; empty where they cannot be read. */
function ancestorsOf(pid: number = process.pid, depth = 6): number[] {
  if (process.platform === "win32") return [process.ppid];
  const found: number[] = [];
  let current = pid;
  for (let step = 0; step < depth; step++) {
    const parent = Number.parseInt(spawnSync("ps", ["-o", "ppid=", "-p", String(current)], { encoding: "utf8" }).stdout?.trim() ?? "", 10);
    if (!Number.isInteger(parent) || parent <= 1) break;
    found.push(parent);
    current = parent;
  }
  return found;
}

/**
 * Names the running session a session start belongs to with the title the Human gave it: the
 * session whose tool server shares the nearest process above this hook, in the same project.
 */
function nameSession(updater: Updater, projectDir: string, title: string): void {
  const mine = ancestorsOf();
  const project = path.resolve(projectDir);
  const leases = updater.leases(-1).filter((lease) => path.resolve(lease.project) === project && (lease.ancestors?.length ?? 0) > 0);
  for (const ancestor of mine) {
    const matches = leases.filter((lease) => lease.ancestors!.includes(ancestor));
    if (matches.length === 1) return updater.updateSession(matches[0]!.pid, { title });
    if (matches.length > 1) return;
  }
}

/** Builds kept for sessions that no running session uses any more, as one line; null when there are none. */
function unusedBuildsLine(updater: Updater): string | null {
  const unused = updater.keptBuilds().filter((build) => !build.used);
  if (unused.length === 0) return null;
  const megabytes = Math.round(unused.reduce((sum, build) => sum + build.bytes, 0) / (1024 * 1024));
  return `${unused.length} old ${updater.program.name} build${unused.length === 1 ? "" : "s"} (${megabytes} MB) no running session uses can be removed.`;
}

/** Each host with its version, as `<host> 2.1.0`, for a report; a host that is not installed is left out. */
function hostLines(adapters: readonly HostAdapter[]): string[] {
  return adapters.flatMap((adapter) => {
    const found = adapter.detect();
    return found.installed ? [`${adapter.name} ${found.version ?? "(version unknown)"}`] : [];
  });
}

/** The feedback program's environment for this tmb; `hosts` are the ones a report names, every supported one unless given. */
function feedbackEnvironment(hosts: readonly HostAdapter[] = HOST_ADAPTERS): FeedbackEnv {
  const options = updaterOptions(version, isCompiledEntry(Bun.main));
  const program = options.program!;
  return feedbackEnv({ stateDir: options.stateDir, program, version, versionLine: versionLine(program), hosts: () => hostLines(hosts) });
}

/** Brings a project's host files to this tmb after an update, at a session start (trustmybot/tmb#128). Never throws. */
function hostFileRefresh(projectDir: string): string | null {
  return refreshProject({ projectDir, program: { name: runningProgram(version).name, version }, tmbCommand: tmbCommand(), adapters: HOST_ADAPTERS });
}

/**
 * Whoever starts a run sets this to `1` when no one can answer in it. Only this door reads it;
 * the adapter and the engine get a plain flag.
 */
const UNATTENDED_VARIABLE = "TMB_UNATTENDED";

/** Only `1` turns unattended mode on; unset or any other value leaves the run attended. */
function hookRun(): HookRun {
  return { unattended: process.env[UNATTENDED_VARIABLE] === "1" };
}

/** What a session start says about this tmb's own state: the host files' refresh and old builds; it also names the session. Never throws. */
function sessionStartLines(projectDir: string, adapter: HostAdapter, stdinText: string): string | null {
  const lines = [hostFileRefresh(projectDir)];
  try {
    const updater = new Updater(updaterOptions(version, isCompiledEntry(Bun.main)));
    if (updater.tracksSessions) {
      const title = adapter.sessionTitle?.(stdinText) ?? null;
      if (title !== null) nameSession(updater, projectDir, title);
      lines.push(unusedBuildsLine(updater));
    }
  } catch {
    // Naming the session and counting builds are extras; the session starts without them.
  }
  const said = lines.filter((line): line is string => line !== null);
  return said.length === 0 ? null : said.join("\n");
}

async function runHook(args: string[]): Promise<number> {
  // A hook must never break the host session: any failure exits 0 with a note on stderr.
  try {
    const { values, positionals } = parseArgs({ args, options: { host: { type: "string" } }, allowPositionals: true, strict: true });
    const [event, ...extra] = positionals;
    if (!event) throw new Error("missing event name");
    if (extra.length > 0) throw new Error(`hook takes one event name, got ${positionals.join(" ")}`);
    const adapter = adapterById(values.host ?? DEFAULT_HOST_ID);
    const stdinText = await Bun.stdin.text();
    // Only a session's start may tell the Human about the feedback program, or bring the project's host files to this tmb.
    const run = event === "session-start" ? { ...hookRun(), feedback: feedbackEnvironment([adapter]), refresh: (projectDir: string) => sessionStartLines(projectDir, adapter, stdinText) } : hookRun();
    const output = adapter.answerHook(event, stdinText, run);
    // An empty answer means nothing to say, such as an allow: the host goes on as it would without tmb.
    if (output !== "") process.stdout.write(output + "\n");
  } catch (error) {
    process.stderr.write(`tmb hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return 0;
}

/** git's pre-push hook: exit 1 refuses the push, and git shows what tmb wrote on stderr. */
async function runPrePush(args: string[]): Promise<number> {
  const remote = args[0];
  if (remote === undefined) throw new Error("pre-push needs the remote's name, as git passes it");
  // A push from a task worktree runs the hook there; the record is in the project that holds it.
  // In a workspace, the folder git runs the hook in names the repo whose base branch is judged.
  const decision = judgePush(projectRootOf(process.cwd()), remote, await Bun.stdin.text(), process.cwd());
  if (decision.decision === "deny") {
    console.error(decision.reason ?? `tmb refused the push to ${remote}`);
    return 1;
  }
  return 0;
}

/** The feedback environment the planner's tools use: the report names the host that runs them. */
function toolFeedback(host: string): FeedbackEnv {
  const adapter = HOST_ADAPTERS.find((candidate) => candidate.id === host);
  return feedbackEnvironment(adapter === undefined ? [] : [adapter]);
}

/** An engine that replaced an older build's in a running session: the record keeps it, and the host files catch up. */
function movedIn(projectDir: string, from: string): void {
  const program = runningProgram(version).name;
  try {
    const opened = openProjectStore(projectDir, { create: false });
    if (opened.ok) {
      try {
        opened.store.recordAudit({ kind: "human" }, { what: "tmb-moved", detail: JSON.stringify({ program, from, to: version }) });
      } finally {
        opened.store.close();
      }
    }
  } catch {
    // The move stands without its entry.
  }
  // The host files refresh as at a session start; the line goes to stderr, never into the protocol.
  const line = hostFileRefresh(projectDir);
  if (line !== null) process.stderr.write(`tmb: ${line}\n`);
}

async function runToolServer(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { host: { type: "string" }, project: { type: "string" }, engine: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`mcp takes no arguments, got ${positionals.join(" ")}`);
  if (values.host === undefined || values.host.trim() === "") throw new Error("mcp needs --host <id>, the host that runs it");
  // A host may start the server in a subfolder; the record is in the project that holds it.
  const projectDir = values.project === undefined ? projectRootOf(process.cwd()) : path.resolve(values.project);
  const serve = () => serveTools({ projectDir, host: values.host!, version, unattended: hookRun().unattended, feedback: toolFeedback(values.host!) });
  if (values.engine) {
    // The engine behind a front: it serves the tools and nothing else.
    const from = process.env.TMB_MOVED_FROM;
    if (from) movedIn(projectDir, from);
    await serve();
    return 0;
  }
  const updater = new Updater(updaterOptions(version, isCompiledEntry(Bun.main)));
  if (!updater.tracksSessions) {
    await serve();
    return 0;
  }
  // A session start looks for an update in the background; the session's end may apply it.
  if (updater.active) updater.tidy();
  updater.startSession(projectDir, process.pid, { version, ancestors: ancestorsOf() });
  const abort = new AbortController();
  const checking = updater.active ? updater.check({ signal: abort.signal }) : Promise.resolve();
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    abort.abort();
    await checking;
    updater.endSession();
    const applied = updater.apply();
    if (applied.outcome === "applied") process.stderr.write(`tmb: updated to ${applied.version}; the next session runs it\n`);
  };
  const onSignal = () => void end().finally(() => process.exit(0));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, onSignal);
  const engineArgs = ["mcp", "--engine", "--host", values.host, "--project", projectDir];
  const installed = updater.options.target!;
  const adapter = HOST_ADAPTERS.find((candidate) => candidate.id === values.host);
  try {
    // The engines know they are behind a front, so none hands the call over again.
    const code = await runFront({
      ownEngine: [...ownCommand(), ...engineArgs],
      installedEngine: [installed, ...engineArgs],
      installedVersion: () => installedVersionOf(installed),
      hasOpenTask: () => updater.hasOpenTask(projectDir),
      env: { ...process.env, [HANDED_OVER_VARIABLE]: "1", [INSTALLED_FILE_VARIABLE]: installed },
      onVersion: (running) => updater.updateSession(process.pid, { version: running, moveError: null }),
      onMoveFailed: (_installed, reason) => updater.updateSession(process.pid, { moveError: reason }),
      reconnect: adapter?.reconnectToolServer ?? "restart this session",
      program: updater.program.name,
    });
    return code;
  } finally {
    await end();
  }
}

async function runUpdateCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { check: { type: "boolean" } }, allowPositionals: true, strict: true });
  if (positionals.length > 0) throw new Error(`update takes no arguments, got ${positionals.join(" ")}`);
  const updater = new Updater(updaterOptions(version, isCompiledEntry(Bun.main)));
  if (!updater.active) {
    const name = updater.program.name;
    console.log(
      updater.pinned
        ? `${name} is pinned to ${version} and never updates itself; install tmb, tmb-rc or tmb-dev to follow a channel.`
        : updater.options.enabled
          ? `tmb ${version} runs from source and does not update itself.`
          : `Updates are turned off (TMB_NO_UPDATE=1); this is ${name} ${version}.`,
    );
    return 0;
  }
  const name = updater.program.name;
  updater.tidy();
  const checked = await updater.check({ force: true });
  if (checked.outcome === "failed") {
    console.error(`${name} update: could not reach the ${updater.channel} channel: ${checked.error}`);
    return 1;
  }
  if (checked.outcome === "current") {
    console.log(`${name} ${version} is the newest on the ${updater.channel} channel.`);
    return 0;
  }
  const staged = updater.staged();
  if (!staged) {
    console.log(`${name} ${version} is the newest on the ${updater.channel} channel.`);
    return 0;
  }
  if (values.check) {
    console.log(`${name} ${staged.version} is ready on the ${updater.channel} channel; this is ${version}.`);
    return 0;
  }
  const applied = updater.apply();
  if (applied.outcome === "applied") {
    console.log(`Updated ${name} from ${version} to ${applied.version}.`);
    for (const { lease, reason } of updater.waiting(applied.version!)) {
      const title = lease.title ? `"${lease.title}", ` : "";
      console.log(`The session in ${lease.project} (${title}started ${new Date(lease.startedAt).toLocaleString()}) stays on ${lease.version}: ${reason}.`);
    }
    const unused = unusedBuildsLine(updater);
    if (unused !== null) console.log(unused);
    return 0;
  }
  if (applied.outcome === "waiting") {
    console.log(`${name} ${applied.version} is ready but not installed yet: ${applied.reason}. Run \`${name} update\` again.`);
    return 0;
  }
  console.error(`${name} update: could not apply ${applied.version}: ${applied.reason}`);
  return 1;
}

async function runDashboard(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { port: { type: "string" }, project: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`dashboard takes no arguments, got ${positionals.join(" ")}`);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a whole number from 0 to 65535, got ${values.port}`);
  const projectDir = projectRootOf(values.project ?? process.cwd());
  const dashboard = startDashboard({ projectDir, port });
  console.log(`tmb dashboard for ${projectDir}: ${dashboard.url}`);
  console.log("Press Ctrl+C to stop.");
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await dashboard.stop();
  return 0;
}

const INIT_OPTIONS = { host: { type: "string" }, role: { type: "string" } } as const;

const SETTING_OPTIONS = {
  ...INIT_OPTIONS,
  base: { type: "string" },
  "review-mode": { type: "string" },
  check: { type: "string", multiple: true },
  repo: { type: "string" },
  exempt: { type: "boolean" },
} as const;

/** `tmb init` or `tmb onboard`; init takes only the host and its role, as it asks nothing and sets no other setting. */
async function runPrepareCommand(command: "init" | "onboard", args: string[]): Promise<number> {
  const options = command === "init" ? INIT_OPTIONS : { ...SETTING_OPTIONS, yes: { type: "boolean", short: "y" } as const };
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
  if (positionals.length > 0) throw new Error(`${command} takes no arguments, got ${positionals.join(" ")}`);
  const given = values as { host?: string; role?: string; base?: string; "review-mode"?: string; check?: string[]; yes?: boolean; repo?: string; exempt?: boolean };
  // Ask only when a person is at both ends; otherwise never wait for input. init asks only for the review mode.
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true ? terminalAsk() : null;
  const run = { init: runInit, onboard: runOnboard }[command];
  const setupOptions: SetupOptions = {
    projectDir: process.cwd(),
    tmbCommand: tmbCommand(),
    program: { name: runningProgram(version).name, version },
    adapters: HOST_ADAPTERS,
    flags: { host: given.host, role: given.role, base: given.base, reviewMode: given["review-mode"], checks: given.check, yes: given.yes, repo: given.repo, exempt: given.exempt },
    ask: terminal?.ask ?? null,
    out: (line) => process.stdout.write(`${line}\n`),
    colour: colourOn(process.stdout),
    feedback: command === "init" ? feedbackEnvironment() : undefined,
  };
  try {
    await run(setupOptions);
  } finally {
    terminal?.close();
  }
  return 0;
}

/** One host's wiring, or every host's and then the push gate, which serves them all. */
function runRemoveCommand(args: string[]): number {
  const { values, positionals } = parseArgs({ args, options: { host: { type: "string" } }, allowPositionals: true, strict: true });
  if (positionals.length > 0) throw new Error(`remove takes no arguments, got ${positionals.join(" ")}`);
  const adapters = values.host === undefined ? HOST_ADAPTERS : [adapterById(values.host)];
  // One host's broken config must not leave the others, or the push gate, wired.
  const failures: string[] = [];
  const lines = adapters.flatMap((adapter) => {
    try {
      return adapter.remove(process.cwd());
    } catch (error) {
      failures.push(`tmb could not remove ${adapter.name} (${adapter.id}): ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  if (values.host === undefined) lines.push(...removePushGates(process.cwd()));
  // Each adapter says the record is kept; say it once.
  for (const line of new Set(lines)) console.log(line);
  for (const failure of failures) console.error(failure);
  return failures.length === 0 ? 0 : 1;
}

function runMigrateCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: { from: { type: "string" }, repo: { type: "string" }, json: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`migrate takes no arguments, got ${positionals.join(" ")}`);
  const projectDir = projectRootOf(process.cwd());
  const from = values.from === undefined ? findPluginDb(projectDir) : path.resolve(values.from);
  if (from === null) throw new Error(`no plugin database in ${projectDir} or a folder above it; name one with --from`);
  const opened = openProjectStore(projectDir, { create: true });
  if (!opened.ok) throw opened.error;
  try {
    const result = migratePluginProject(opened.store, { pluginDbPath: from, projectDir, repo: values.repo });
    if (values.json) {
      console.log(JSON.stringify(result));
    } else {
      const { counts } = result;
      console.log(`Copied from ${result.from}${result.repo === null ? "" : ` (repo ${result.repo})`}:`);
      console.log(
        `  ${counts.issues} issues, ${counts.discussions} notes and decisions, ${counts.tasks} tasks, ` +
          `${counts.reviews} reviews, ${counts.checkRuns} check runs, ${counts.runs} agent runs.`,
      );
      if (counts.openTasks > 0) {
        console.log(`${counts.openTasks} of the tasks are still open, as the plugin left them. While a task is open, a running session stays on the tmb build it started with.`);
      }
      const left = Object.entries(result.leftBehind).sort(([a], [b]) => a.localeCompare(b));
      if (left.length > 0) {
        console.log(`Left behind, as tmb has no such kind: ${left.map(([kind, count]) => `${count} ${kind}`).join(", ")}.`);
      }
      console.log("The plugin's database is unchanged. Run tmb init here if you have not, to wire tmb into your host.");
    }
  } finally {
    opened.store.close();
  }
  return 0;
}

/** `tmb feedback`: asks only when a person is at both ends. */
async function runFeedback(args: string[]): Promise<number> {
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true ? terminalAsk() : null;
  try {
    return await runFeedbackCommand(args, feedbackEnvironment(), { out: stdout, err: stderr, ask: terminal?.ask ?? null, cwd: process.cwd() });
  } finally {
    terminal?.close();
  }
}

async function dispatch(command: string, rest: string[]): Promise<number> {
  if (isRecordCommand(command)) return runRecordCommand(command, rest, process.cwd(), OUTPUT);
  switch (command) {
    case "init":
    case "onboard":
      return runPrepareCommand(command, rest);
    case "config":
      return runConfigCommand(rest, process.cwd(), OUTPUT);
    case "index":
      return runIndexCommand(rest, process.cwd(), OUTPUT);
    case "remove":
      return runRemoveCommand(rest);
    case "pre-push":
      return runPrePush(rest);
    case "update":
      return runUpdateCommand(rest);
    case "migrate":
      return runMigrateCommand(rest);
    case "dashboard":
      return runDashboard(rest);
    case "feedback":
      return runFeedback(rest);
    case "mcp":
      return runToolServer(rest);
    case "hook":
      return runHook(rest);
    default:
      throw new Error(`no runner for ${command}`);
  }
}

/** The project a call works in: the tool server's `--project`, or the one holding the folder it runs in. */
function callProject(command: string, rest: string[]): string {
  const flag = command === "mcp" ? rest.findIndex((arg) => arg === "--project" || arg.startsWith("--project=")) : -1;
  if (flag >= 0) {
    const value = rest[flag]!.includes("=") ? rest[flag]!.slice("--project=".length) : rest[flag + 1];
    if (value) return path.resolve(value);
  }
  return projectRootOf(process.cwd());
}

/**
 * Hands the call over to the build a running session pinned its project to (trustmybot/tmb#159):
 * a hook, the tool server, git's push hook or a command typed by hand all run that build while
 * the session runs. Returns the kept build's exit code, or null to run this build. Only the
 * installed tmb hands over, once: the kept build never hands over again. `update` and help run here.
 */
function handOver(command: string, rest: string[]): number | null {
  if (process.env[HANDED_OVER_VARIABLE] === "1" || command === "update" || command === "help" || command === "--help" || command === "-h") return null;
  let updater: Updater;
  let pinned: string | null;
  try {
    updater = new Updater(updaterOptions(version, isCompiledEntry(Bun.main)));
    if (!updater.active) return null;
    pinned = updater.pinOf(callProject(command, rest));
  } catch {
    return null;
  }
  if (pinned === null) return null;
  const kept = updater.keptFile(pinned);
  if (!existsSync(kept)) {
    process.stderr.write(`tmb: a session in this project started on ${updater.program.name} ${pinned}, which is no longer kept; this call runs ${version}.\n`);
    return null;
  }
  const result = spawnSync(kept, [command, ...rest], {
    stdio: "inherit",
    env: { ...process.env, [HANDED_OVER_VARIABLE]: "1", [INSTALLED_FILE_VARIABLE]: updater.options.target! },
  });
  if (result.error) {
    process.stderr.write(`tmb: could not run ${updater.program.name} ${pinned} for this project (${result.error.message}); this call runs ${version}.\n`);
    return null;
  }
  return result.status ?? 1;
}

/** An error node:util's parseArgs throws for a flag or argument a command does not take. */
function isParseArgsError(error: unknown): error is Error {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // A command is required: none given is the same usage error as an unknown one.
  if (command === undefined) {
    process.stderr.write(shortHelp(errPaint(), false));
    return 2;
  }
  if (command === "--help" || command === "-h") return runHelpCommand(rest.filter((arg) => arg === "--all"));
  const handed = handOver(command, rest);
  if (handed !== null) return handed;
  if (command === "help") return runHelpCommand(rest);
  if (VERSION_WORDS.has(command)) {
    stdout(versionLine(updaterOptions(version, isCompiledEntry(Bun.main)).program!));
    return 0;
  }
  if (!KNOWN.has(command)) {
    process.stderr.write(unknownCommandText("tmb", command, LISTED, errPaint(), OTHER_NAMES));
    return 2;
  }
  if (asksHelp(rest)) return writeCommandHelp(command, rest[0]?.startsWith("-") ? undefined : rest[0]);
  try {
    return await dispatch(command, rest);
  } catch (error) {
    if (!isParseArgsError(error)) throw error;
    process.stderr.write(usageErrorText(`tmb ${command}`, error.message, errPaint()));
    return 2;
  }
}

/** The command a failure came from, for a report: its name and, when it is a plain word, its action; never its values. */
function failedCommand(argv: string[]): string {
  const [command, action] = argv;
  return [command, action !== undefined && /^[a-z][a-z-]*$/.test(action) ? action : undefined].filter((word) => word !== undefined).join(" ");
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`tmb: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  // Kept for `tmb feedback`, which may put it in a report the Human reads first.
  try {
    keepLastError(updaterOptions(version, isCompiledEntry(Bun.main)).stateDir, {
      at: new Date().toISOString(),
      command: failedCommand(process.argv.slice(2)),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
  } catch {
    // The error above is what matters.
  }
}
