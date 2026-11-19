// `tmb init`, `tmb onboard` and `tmb remove` as separate processes, the way the Human runs them:
// init prepares a fresh project without a question, onboard changes the settings as often as
// asked, and remove takes back what init added.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathWithFakeClaude } from "./fake-host.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli.ts");
const NO_INPUT_LIMIT_MS = 20_000;

let scratch: string;
let env: Record<string, string>;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-init-onboard-")));
  // Keep the machine's git configuration out of the project under test.
  env = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: pathWithFakeClaude(scratch),
  };
  delete env.CLAUDE_PROJECT_DIR;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tmb(args: string[], cwd: string): string {
  const result = run(args, cwd);
  if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

/** A fresh git project on branch trunk with one commit, a bun package with a test script, and a file of the Human's. */
function newProject(): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  const git = (...args: string[]) =>
    expect(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project, env, timeout: 10_000 }).status).toBe(0);
  git("init", "-q", "-b", "trunk");
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }));
  writeFileSync(path.join(project, "bun.lock"), "");
  writeFileSync(path.join(project, "index.ts"), "export const one = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return project;
}

function config(project: string): Record<string, unknown> {
  return JSON.parse(tmb(["config", "--json"], project)) as Record<string, unknown>;
}

/** Every file under `dir` but git's objects and logs, with its content; folders end in /. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const relative = path.relative(base, file);
    if (["objects", "logs", "index", "ORIG_HEAD"].includes(name) && relative.startsWith(".git")) continue;
    if (statSync(file).isDirectory()) {
      files[`${relative}/`] = "";
      Object.assign(files, snapshot(file, base));
    } else {
      files[relative] = readFileSync(file, "utf8");
    }
  }
  return files;
}

describe("tmb init", () => {
  test("prepares a fresh project with no question asked, names the defaults it took and points to onboard", async () => {
    const project = newProject();
    // stdin stays open and empty: an init that waited for an answer would never exit.
    const child = Bun.spawn([process.execPath, CLI, "init"], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), NO_INPUT_LIMIT_MS);
    const status = await child.exited;
    clearTimeout(timer);
    const stdout = await new Response(child.stdout).text();
    expect(status).toBe(0);
    expect(stdout).not.toContain("question");
    expect(stdout).toContain("Indexed the code graph of trunk");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      'Took the defaults for the planner role for Claude Code, the base branch trunk, the review mode agile and the checks "bun run test", found in the project. Run tmb onboard to change them, at any time.',
    );
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "planner" }, base_branch: "trunk", review_mode: "agile", checks: ["bun run test"] });
    for (const file of [".tmb/trajectory.db", ".mcp.json", ".claude/settings.local.json", ".claude/agents/worker.md", ".git/hooks/pre-push"]) {
      expect(existsSync(path.join(project, file))).toBe(true);
    }
  });

  test("takes no --yes, as it never asks", () => {
    const result = run(["init", "--yes"], newProject());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--yes");
  });
});

describe("tmb onboard", () => {
  test("refuses a project init has not prepared, and writes nothing", () => {
    const project = newProject();
    const before = snapshot(project);
    const result = run(["onboard", "--base", "main"], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tmb is not set up in this project; run tmb init first");
    expect(snapshot(project)).toEqual(before);
  });

  test("changes a setting, and can be run again to change another", () => {
    const project = newProject();
    tmb(["init"], project);
    expect(tmb(["onboard", "--base", "release"], project)).toContain("Recorded 1 change in the record's audit trail.");
    expect(config(project).base_branch).toBe("release");
    expect(tmb(["onboard", "--review-mode", "truest", "--role", "reviewer"], project)).toContain("Recorded 2 changes in the record's audit trail.");
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "reviewer" }, base_branch: "release", review_mode: "truest", checks: ["bun run test"] });
    expect(tmb(["onboard"], project)).toContain("No setting changed, so nothing was recorded.");
  });
});

describe("tmb remove", () => {
  test("undoes what init added, keeping the record and the .gitignore lines", () => {
    const project = newProject();
    const before = snapshot(project);
    tmb(["init"], project);
    expect(snapshot(project)).not.toEqual(before);
    tmb(["remove"], project);
    const after = snapshot(project);
    // The record is the Human's data, and remove never edits .gitignore.
    for (const kept of Object.keys(after).filter((file) => file === ".gitignore" || file.startsWith(".tmb"))) delete after[kept];
    expect(after).toEqual(before);
  });
});

describe("tmb setup", () => {
  test("is init followed by onboard", () => {
    const project = newProject();
    const stdout = tmb(["setup", "--base", "release", "--yes"], project);
    expect(stdout).toContain("--yes was given, so each question takes its default");
    expect(stdout).not.toContain("Run tmb onboard to change");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe("tmb is set up for Claude Code. Open it in this project to start as the planner.");
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "planner" }, base_branch: "release", review_mode: "agile", checks: ["bun run test"] });
  });
});
