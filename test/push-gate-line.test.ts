// The one line tmb adds first in another tool's pre-push hook (trustmybot/tmb#218), run as git
// runs a hook: with sh, here under `sh -e` as husky runs hooks, and git's ref lines on its input.
// It runs on Windows too, with Git for Windows' sh (trustmybot/tmb#221): the windows-hook workflow.
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
const WINDOWS = process.platform === "win32";

/**
 * Git for Windows' own sh, the one git runs hooks with, and the folder of the tools beside it;
 * elsewhere the system's sh.
 */
function gitShell(): { sh: string; tools: string } {
  if (!WINDOWS) return { sh: "sh", tools: "/usr/bin:/bin" };
  // git --exec-path is <git>/mingw64/libexec/git-core; sh is <git>/usr/bin/sh.exe.
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const usrBin = path.resolve(execPath, "..", "..", "..", "usr", "bin");
  return { sh: path.join(usrBin, "sh.exe"), tools: usrBin };
}
const { sh: SH, tools: TOOLS } = gitShell();
// A PATH with sh, git and the usual tools, and no tmb on it.
const GIT_DIR = WINDOWS ? path.dirname(spawnSync("where", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0]!) : "";
const BASE_PATH = WINDOWS ? [TOOLS, GIT_DIR].join(path.delimiter) : TOOLS;

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
  const result = spawnSync(SH, ["-e", hook, "origin", "git@example.com:o/r.git"], {
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

  test("a real git push runs it: refused while tmb says no, and the other tool reads the refs once tmb says yes", () => {
    const { repo, bin, temp } = setUp("pushed");
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${BASE_PATH}`, TMPDIR: temp } });
      return { status: result.status, stderr: result.stderr };
    };
    const origin = path.join(root, "pushed-origin.git");
    spawnSync("git", ["init", "-q", "--bare", origin]);
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    expect(git("add", "README.md").status).toBe(0);
    expect(git("commit", "-q", "-m", "first").status).toBe(0);
    expect(git("remote", "add", "origin", origin).status).toBe(0);
    // git runs the hook itself, with its own sh: on Windows, Git for Windows' sh.
    mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(repo, ".git", "hooks", "pre-push"), readFileSync(path.join(repo, "hook"), "utf8"), { mode: 0o755 });

    fakeTmb(bin, 1);
    const refused = git("push", "-q", "origin", "HEAD:refs/heads/main");
    expect(refused.status).not.toBe(0);
    expect(readFileSync(path.join(bin, "tmb-saw"), "utf8")).toContain("refs/heads/main");
    expect(readdirSync(temp)).toEqual([]);

    fakeTmb(bin, 0);
    expect(git("push", "-q", "origin", "HEAD:refs/heads/main").status).toBe(0);
    expect(readFileSync(path.join(repo, "other-tool-saw"), "utf8")).toContain("refs/heads/main");
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
