#!/usr/bin/env bun
// tmb's entry: builds the running tmb from this process, and runs the call by the command table.
import { keepLastError } from "../engine/index.ts";
import { CommandLine } from "./command-line.ts";
import { CommandTable } from "./registry.ts";
import { type ProcessPorts, Runtime } from "./runtime.ts";

/** The command a failure came from, for a report: its name and, when it is a plain word, its action; never its values. */
function failedCommand(argv: readonly string[]): string {
  const [command, action] = argv;
  return [command, action !== undefined && /^[a-z][a-z-]*$/.test(action) ? action : undefined].filter((word) => word !== undefined).join(" ");
}

const ports: ProcessPorts = {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  execPath: process.execPath,
  pid: process.pid,
  ppid: process.ppid,
  platform: process.platform,
  cwd: () => process.cwd(),
  main: Bun.main,
  readStdin: () => Bun.stdin.text(),
  once: (signal, listener) => void process.once(signal, listener),
  exit: (code) => process.exit(code),
};
const runtime = new Runtime(ports);
const argv = process.argv.slice(2);

try {
  process.exitCode = await new CommandLine(runtime, new CommandTable(runtime)).run(argv);
} catch (error) {
  process.stderr.write(`tmb: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  // Kept for `tmb feedback`, which may put it in a report the Human reads first.
  try {
    keepLastError(runtime.updaterOptions().stateDir, {
      at: new Date().toISOString(),
      command: failedCommand(argv),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
  } catch {
    // The error above is what matters.
  }
}
