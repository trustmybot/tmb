// Every command tmb prints for its reader to run names the running program (trustmybot/tmb#268):
// a program installed as tmb-dev tells its reader to run `tmb-dev init`, never `tmb init`. This
// builds tmb as tmb-dev and runs it as a person would, through help, usage errors, a folder with
// no project, init, onboard and a push the gate refuses, and fails on any printed `tmb <command>`.
import tailwind from "bun-plugin-tailwind";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../../lib/paths.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const REPO = REPO_ROOT;
const WINDOWS = process.platform === "win32";
const NAME = "tmb-dev";
const COMMANDS = ["init", "onboard", "config", "remove", "purge", "migrate", "issue", "note", "feature", "task", "search", "history", "graph", "index", "tools", "dashboard", "update", "feedback", "doctor", "help"];
// A printed command of plain tmb: `tmb` (not part of a longer name or a path) then a command or a flag.
const PLAIN = new RegExp(`(?<![\\w./-])tmb (?:(?:${[...COMMANDS, "mcp", "hook", "pre-push"].join("|")})\\b|--)`);

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-program-name-")));
const bin = path.join(root, "bin");
const home = path.join(root, "home");
const program = path.join(bin, WINDOWS ? `${NAME}.exe` : NAME);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  TMB_STATE_DIR: path.join(root, "state"),
  TMB_NO_UPDATE: "1",
  TMB_NO_FEEDBACK: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/** Every run's output, by the command that printed it, for the check at the end. */
const printed: { run: string; text: string }[] = [];

function run(cwd: string, args: string[], pathEnv?: string): string {
  const result = spawnSync(program, args, { cwd, input: "", encoding: "utf8", timeout: 30_000, env: { ...env, PATH: pathEnv ?? process.env.PATH } });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  printed.push({ run: `${NAME} ${args.join(" ")}`, text });
  return text;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  printed.push({ run: `git ${args.join(" ")}`, text });
  return text;
}

beforeAll(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  // Tailwind finds the dashboard's classes from the folder it runs in, so the build runs from the repo, as scripts/build.ts does.
  const cwd = process.cwd();
  process.chdir(REPO);
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({ entrypoints: [path.join(REPO, "src", "cli", "index.ts")], compile: { outfile: program }, plugins: [tailwind], throw: false });
  } finally {
    process.chdir(cwd);
  }
  if (!built.success) throw new Error(`build failed: ${built.logs.join("\n")}`);
}, 120_000);

describe(`a tmb installed as ${NAME}`, () => {
  test("help and usage text name it", () => {
    const here = path.join(root, "help");
    mkdirSync(here);
    run(here, ["--help"]);
    run(here, ["help"]);
    for (const command of COMMANDS) {
      run(here, ["help", command]);
      run(here, [command, "--help"]);
    }
    for (const command of ["issue", "note", "feature", "task", "graph", "config"]) run(here, [command]);
    run(here, ["inti"]);
    run(here, ["task", "nosuch"]);
    expect(run(here, ["help", "init"])).toContain(`${NAME} init`);
  });

  test("a folder with no project, and init with no host, name it", () => {
    const here = path.join(root, "bare");
    mkdirSync(here);
    git(here, "init", "-q");
    for (const args of [["task", "list"], ["issue", "list"], ["feature", "list"], ["history"], ["search", "x"], ["graph", "map"], ["onboard"], ["migrate"], ["doctor"]]) run(here, args);
    // No host on PATH but git's.
    const pathOnlyGit = path.join(root, "git-only");
    mkdirSync(pathOnlyGit);
    expect(run(here, ["init"], `${pathOnlyGit}${path.delimiter}${path.dirname(spawnSync(WINDOWS ? "where" : "which", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0]!)}`)).toContain(`${NAME} init`);
  });

  test.skipIf(WINDOWS)("init, onboard, doctor and a push the gate refuses name it", () => {
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    spawnSync("git", ["init", "-q", "--bare", origin]);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "start");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    // A Claude Code on PATH that answers its version, so init finds a host.
    writeFileSync(path.join(bin, "claude"), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', { mode: 0o755 });
    const withHost = `${bin}${path.delimiter}${process.env.PATH}`;
    expect(run(repo, ["init"], withHost)).toContain(`${NAME} onboard`);
    run(repo, ["onboard", "--base", "main", "--check", "true", "--yes"], withHost);
    run(repo, ["doctor"], withHost);
    run(repo, ["task", "start", "--help"], withHost);
    writeFileSync(path.join(repo, "f"), "x");
    git(repo, "add", "f");
    git(repo, "commit", "-q", "-m", "f");
    const refused = git(repo, "push", "origin", "main");
    expect(refused).toContain("refused the push");
    expect(refused).toContain(`${NAME} feature waive`);
  });

  test("nothing it printed tells its reader to run plain tmb", () => {
    const found = printed.flatMap(({ run, text }) => text.split(/\r?\n/).filter((line) => PLAIN.test(line)).map((line) => `${run}: ${line.trim()}`));
    expect(found).toEqual([]);
  });
});
