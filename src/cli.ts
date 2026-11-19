#!/usr/bin/env bun
import { adapter } from "#host-adapter";
import { versionLine } from "./version.ts";

const USAGE = `Usage:
  tmb --version             Print the version
  tmb setup                 Wire tmb into the project in the current directory
  tmb remove                Undo what setup added
  tmb hook <event>          Answer a host event (the host runs this; reads JSON on stdin)`;

async function runHook(event: string | undefined): Promise<number> {
  // A hook must never break the host session: any failure exits 0 with a note on stderr.
  try {
    if (!event) throw new Error("missing event name");
    const stdinText = await Bun.stdin.text();
    process.stdout.write(adapter.answerHook(event, stdinText) + "\n");
  } catch (error) {
    process.stderr.write(`tmb hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "--version":
    case "-v":
    case "version":
      console.log(versionLine());
      return 0;
    case "setup":
      for (const line of adapter.setup(process.cwd(), process.execPath)) console.log(line);
      console.log(`tmb is set up for ${adapter.name}. Open it in this project to start as the planner.`);
      return 0;
    case "remove":
      for (const line of adapter.remove(process.cwd())) console.log(line);
      return 0;
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
