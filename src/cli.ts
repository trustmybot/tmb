#!/usr/bin/env bun
import path from "node:path";
import { parseArgs } from "node:util";
import type { HookRun } from "./adapters/host-adapter.ts";
import { findPluginDb, HOST_ADAPTERS, hostAdapter, migratePluginProject } from "./adapters/index.ts";
import { CONFIG_USAGE, INDEX_USAGE, isRecordCommand, RECORD_USAGE, runConfigCommand, runIndexCommand, runRecordCommand } from "./engine/doors/command-line.ts";
import { DEFAULT_PORT, startDashboard } from "./engine/doors/dashboard/server.ts";
import { serveTools } from "./engine/doors/tool-server.ts";
import { openProjectStore, projectRootOf } from "./engine/project.ts";
import { judgePush, removePushGate } from "./engine/push-gate.ts";
import { runSetup, terminalAsk } from "./setup.ts";
import { Updater, updaterOptions } from "./update.ts";
import { version, versionLine } from "./version.ts";

const USAGE = `Usage:
  tmb --version             Print the version
  tmb setup [--host <id>] [--base <branch>] [--review-mode <mode>] [--check <command>]... [--yes]
                            Wire tmb into the project in the current directory and store
                            its settings; asks on a terminal, else takes the defaults
  tmb remove                Undo what setup added; the record is kept
  tmb migrate [--from <plugin db>] [--repo <name>]
                            Copy a tmb plugin project's records into this project's new
                            record; the plugin's database is left untouched
${CONFIG_USAGE}
${RECORD_USAGE}
${INDEX_USAGE}
  tmb update [--check]      Look for a newer build on this install's channel now and apply it
                            when no other tmb session is running; with
                            --check, only report
  tmb dashboard [--port <n>] [--project <dir>]
                            Serve the record as a local web page, on port ${DEFAULT_PORT}
                            unless named; 0 picks a free one
  tmb mcp --host <id> [--project <dir>]
                            Serve the record's tools over stdio (the host runs this)
  tmb hook <event>          Answer a host event (the host runs this; reads JSON on stdin)
  tmb pre-push <remote> [<url>]
                            Judge a push (git's pre-push hook runs this; reads its ref lines on stdin)`;

// A compiled tmb runs its entry from Bun's embedded file system; from source, Bun runs this file.
const COMPILED_ENTRY = /^(?:\/\$bunfs\/|[A-Z]:\\~BUN\\)/i;

const adapter = hostAdapter();

/** The command that runs this tmb: the executable, plus this file when run from source. */
function tmbCommand(): string[] {
  return COMPILED_ENTRY.test(Bun.main) ? [process.execPath] : [process.execPath, Bun.main];
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

async function runHook(event: string | undefined): Promise<number> {
  // A hook must never break the host session: any failure exits 0 with a note on stderr.
  try {
    if (!event) throw new Error("missing event name");
    const stdinText = await Bun.stdin.text();
    const output = adapter.answerHook(event, stdinText, hookRun());
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
  const decision = judgePush(projectRootOf(process.cwd()), remote, await Bun.stdin.text());
  if (decision.decision === "deny") {
    console.error(decision.reason ?? `tmb refused the push to ${remote}`);
    return 1;
  }
  return 0;
}

async function runToolServer(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { host: { type: "string" }, project: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`mcp takes no arguments, got ${positionals.join(" ")}`);
  if (values.host === undefined || values.host.trim() === "") throw new Error("mcp needs --host <id>, the host that runs it");
  const projectDir = path.resolve(values.project ?? process.cwd());
  const updater = new Updater(updaterOptions(version, COMPILED_ENTRY.test(Bun.main)));
  if (!updater.active) {
    await serveTools({ projectDir, host: values.host, version });
    return 0;
  }
  // A session start looks for an update in the background; the session's end may apply it.
  updater.tidy();
  updater.startSession(projectDir);
  const abort = new AbortController();
  const checking = updater.check({ signal: abort.signal });
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
  try {
    await serveTools({ projectDir, host: values.host, version });
  } finally {
    await end();
  }
  return 0;
}

async function runUpdateCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { check: { type: "boolean" } }, allowPositionals: true, strict: true });
  if (positionals.length > 0) throw new Error(`update takes no arguments, got ${positionals.join(" ")}`);
  const updater = new Updater(updaterOptions(version, COMPILED_ENTRY.test(Bun.main)));
  if (!updater.active) {
    console.log(
      updater.options.enabled ? `tmb ${version} runs from source and does not update itself.` : `Updates are turned off (TMB_NO_UPDATE=1); this is tmb ${version}.`,
    );
    return 0;
  }
  updater.tidy();
  const checked = await updater.check({ force: true });
  if (checked.outcome === "failed") {
    console.error(`tmb update: could not reach the ${updater.channel} channel: ${checked.error}`);
    return 1;
  }
  if (checked.outcome === "current") {
    console.log(`tmb ${version} is the newest on the ${updater.channel} channel.`);
    return 0;
  }
  const staged = updater.staged();
  if (!staged) {
    console.log(`tmb ${version} is the newest on the ${updater.channel} channel.`);
    return 0;
  }
  if (values.check) {
    console.log(`tmb ${staged.version} is ready on the ${updater.channel} channel; this is ${version}.`);
    return 0;
  }
  const applied = updater.apply();
  if (applied.outcome === "applied") {
    console.log(`Updated tmb from ${version} to ${applied.version}.`);
    return 0;
  }
  if (applied.outcome === "waiting") {
    console.log(`tmb ${applied.version} is ready and applies once no tmb session is running: ${applied.reason}.`);
    return 0;
  }
  console.error(`tmb update: could not apply ${applied.version}: ${applied.reason}`);
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

async function runSetupCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      host: { type: "string" },
      base: { type: "string" },
      "review-mode": { type: "string" },
      check: { type: "string", multiple: true },
      yes: { type: "boolean", short: "y" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`setup takes no arguments, got ${positionals.join(" ")}`);
  // Ask only when a person is at both ends; otherwise never wait for input.
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true ? terminalAsk() : null;
  try {
    await runSetup({
      projectDir: process.cwd(),
      tmbCommand: tmbCommand(),
      adapters: HOST_ADAPTERS,
      flags: { host: values.host, base: values.base, reviewMode: values["review-mode"], checks: values.check, yes: values.yes },
      ask: terminal?.ask ?? null,
      out: (line) => console.log(line),
    });
  } finally {
    terminal?.close();
  }
  return 0;
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
      console.log("The plugin's database is unchanged. Run tmb setup here if you have not, to wire tmb into your host.");
    }
  } finally {
    opened.store.close();
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (isRecordCommand(command)) {
    return runRecordCommand(command, rest, process.cwd(), { out: (text) => console.log(text), err: (text) => console.error(text) });
  }
  switch (command) {
    case "--version":
    case "-v":
    case "version":
      console.log(versionLine());
      return 0;
    case "setup":
      return runSetupCommand(rest);
    case "config":
      return runConfigCommand(rest, process.cwd(), { out: (text) => console.log(text), err: (text) => console.error(text) });
    case "index":
      return runIndexCommand(rest, process.cwd(), { out: (text) => console.log(text), err: (text) => console.error(text) });
    case "remove":
      for (const line of adapter.remove(process.cwd())) console.log(line);
      for (const line of removePushGate(process.cwd())) console.log(line);
      return 0;
    case "pre-push":
      return runPrePush(rest);
    case "update":
      return runUpdateCommand(rest);
    case "migrate":
      return runMigrateCommand(rest);
    case "dashboard":
      return runDashboard(rest);
    case "mcp":
      return runToolServer(rest);
    case "hook":
      return runHook(rest[0]);
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      console.error(`tmb: unknown command '${command}'\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`tmb: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
