// A fake host program for the processes these tests start: setup looks for an installed
// host on PATH, and a test machine need not have one.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Makes `<dir>/fake-host/claude`, which answers --version as Claude Code does; returns its folder. */
export function fakeClaudeFolder(dir: string): string {
  const folder = path.join(dir, "fake-host");
  mkdirSync(folder, { recursive: true });
  const program = path.join(folder, "claude");
  writeFileSync(program, `#!/bin/sh\n[ "$1" = "--version" ] || exit 9\necho '2.1.37 (Claude Code)'\n`);
  chmodSync(program, 0o755);
  return folder;
}

/** PATH with the fake host's folder first. */
export function pathWithFakeClaude(dir: string): string {
  return `${fakeClaudeFolder(dir)}${path.delimiter}${process.env.PATH ?? ""}`;
}
