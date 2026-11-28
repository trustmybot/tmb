// A fake `gh` for the tests that open pull requests: a shell script on PATH that logs each call's
// arguments, one line per call, then runs the test's own answer. GitHub is never reached.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** What `gh pr create` prints when a test gives no other answer: a pull request's address. */
export const PULL_REQUEST_URL = "https://github.com/example/project/pull/7";

export type FakeGh = {
  /** The folder holding `gh`, to put first on PATH. */
  bin: string;
  /** The file each call's arguments are appended to. */
  log: string;
};

/**
 * Writes `<dir>/fake-gh/gh`, logging to `<dir>/gh.log`. `answer` is the shell after the log line;
 * by default it prints `url`, as `gh pr create` does.
 */
export function fakeGh(dir: string, options: { answer?: string; url?: string } = {}): FakeGh {
  const bin = path.join(dir, "fake-gh");
  const log = path.join(dir, "gh.log");
  mkdirSync(bin, { recursive: true });
  const answer = options.answer ?? `echo "${options.url ?? PULL_REQUEST_URL}"`;
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${answer}\n`, { mode: 0o755 });
  return { bin, log };
}
