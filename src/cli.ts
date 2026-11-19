#!/usr/bin/env bun
import path from "node:path";
import { parseArgs } from "node:util";
import type { HookRun } from "./adapters/host-adapter.ts";
import { HOST_ADAPTERS, hostAdapter } from "./adapters/index.ts";
import { CONFIG_USAGE, INDEX_USAGE, isRecordCommand, RECORD_USAGE, runConfigCommand, runIndexCommand, runRecordCommand } from "./engine/doors/command-line.ts";
import { serveTools } from "./engine/doors/tool-server.ts";
import { runSetup, terminalAsk } from "./setup.ts";
import { version, versionLine } from "./version.ts";

const USAGE = `Usage:
  tmb --version             Print the version
  tmb setup [--host <id>] [--base <branch>] [--review-mode <mode>] [--check <command>]... [--yes]
                            Wire tmb into the project in the current directory and store
                            its settings; asks on a terminal, else takes the defaults
  tmb remove                Undo what setup added; the record is kept
${CONFIG_USAGE}
${RECORD_USAGE}
${INDEX_USAGE}
  tmb mcp --host <id> [--project <dir>]
                            Serve the record's tools over stdio (the host runs this)
  tmb hook <event>          Answer a host event (the host runs this; reads JSON on stdin)`;

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

async function runToolServer(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { host: { type: "string" }, project: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`mcp takes no arguments, got ${positionals.join(" ")}`);
  if (values.host === undefined || values.host.trim() === "") throw new Error("mcp needs --host <id>, the host that runs it");
  await serveTools({ projectDir: path.resolve(values.project ?? process.cwd()), host: values.host, version });
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
      return 0;
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
