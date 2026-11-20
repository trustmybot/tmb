// The one line tmb adds first in another tool's pre-push hook (trustmybot/tmb#218), run as git
// runs a hook: with sh, here under `sh -e` as husky runs hooks, and git's ref lines on its input.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addedLine } from "../src/engine/push-gate.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const root = mkdtempSync(path.join(tmpdir(), "tmb-push-line-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const REFS = "refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n";
// A PATH with sh and the usual tools, and no tmb on it.
const BASE_PATH = process.platform === "win32" ? process.env.PATH! : "/usr/bin:/bin";

/** A repo whose hook is tmb's line and then the other tool's, which reads the ref lines into a file. */
function setUp(name: string): { repo: string; hook: string; bin: string; temp: string } {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const hook = path.join(repo, "hook");
  writeFileSync(hook, `#!/bin/sh\n${addedLine("tmb", repo, repo)}\ncat > other-tool-saw\necho the other tool ran\n`);
  const bin = path.join(repo, "bin");
  const temp = path.join(repo, "temp");
  mkdirSync(bin);
  mkdirSync(temp);
  return { repo, hook, bin, temp };
}

/** A tmb on PATH that reads the ref lines into a file and answers with the given status. */
function fakeTmb(bin: string, status: number): void {
  writeFileSync(path.join(bin, "tmb"), `#!/bin/sh\ncat > "$(dirname "$0")/tmb-saw"\nexit ${status}\n`, { mode: 0o755 });
}

function runHook(repo: string, hook: string, pathEnv: string, temp: string) {
  const result = spawnSync("sh", ["-e", hook, "origin", "git@example.com:o/r.git"], {
    cwd: repo,
    input: REFS,
    encoding: "utf8",
    env: { ...process.env, PATH: pathEnv, TMPDIR: temp },
  });
  return { status: result.status, stdout: result.stdout };
}

describe("tmb's line in another tool's hook", () => {
  test("where tmb is not installed it does nothing: the rest of the hook reads the ref lines, and the push goes", () => {
    const { repo, hook, temp } = setUp("absent");
    const ran = runHook(repo, hook, BASE_PATH, temp);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("the other tool ran");
    expect(readFileSync(path.join(repo, "other-tool-saw"), "utf8")).toBe(REFS);
    expect(readdirSync(temp)).toEqual([]);
  });

  test("a push the gate lets through: tmb and the rest of the hook both read the ref lines, and the file is removed", () => {
    const { repo, hook, bin, temp } = setUp("allowed");
    fakeTmb(bin, 0);
    const ran = runHook(repo, hook, `${bin}${path.delimiter}${BASE_PATH}`, temp);
    expect(ran.status).toBe(0);
    expect(readFileSync(path.join(bin, "tmb-saw"), "utf8")).toBe(REFS);
    expect(readFileSync(path.join(repo, "other-tool-saw"), "utf8")).toBe(REFS);
    expect(readdirSync(temp)).toEqual([]);
  });

  test("a push the gate refuses ends the hook there, and the file is removed", () => {
    const { repo, hook, bin, temp } = setUp("refused");
    fakeTmb(bin, 1);
    const ran = runHook(repo, hook, `${bin}${path.delimiter}${BASE_PATH}`, temp);
    expect(ran.status).toBe(1);
    expect(ran.stdout).not.toContain("the other tool ran");
    expect(readFileSync(path.join(bin, "tmb-saw"), "utf8")).toBe(REFS);
    expect(readdirSync(temp)).toEqual([]);
  });
});
