// `tmb setup` and `tmb config` as separate processes, the way the Human runs them: the
// host is found on PATH, the answers land in the record, and no run waits for input.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openProjectStore } from "../../src/engine/index.ts";
import { pathWithFakeClaude } from "./fake-host.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli.ts");
const NO_INPUT_LIMIT_MS = 20_000;

let scratch: string;
let env: Record<string, string>;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-setup-")));
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

function run(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tmb(args: string[], cwd: string): string {
  const result = run(args, cwd);
  if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

/** A fresh git project on branch trunk, with a bun package that has lint and test scripts. */
function newBunProject(): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  expect(spawnSync("git", ["init", "-q", "-b", "trunk"], { cwd: project, env, timeout: 10_000 }).status).toBe(0);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "bun test", lint: "x", build: "x" } }));
  writeFileSync(path.join(project, "bun.lock"), "");
  return project;
}

function config(project: string): Record<string, unknown> {
  return JSON.parse(tmb(["config", "--json"], project)) as Record<string, unknown>;
}

function auditCount(project: string): number {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return opened.store.listAudit().length;
  } finally {
    opened.store.close();
  }
}

describe("tmb setup", () => {
  test("--yes in a fresh git project stores the host, base branch, agile and the detected checks, and tmb config shows them", () => {
    const project = newBunProject();
    const stdout = tmb(["setup", "--yes"], project);
    expect(stdout).toContain("Found Claude Code, the one supported host installed; setting tmb up for it.");
    expect(stdout).toContain("Recorded 5 changes in the record's audit trail.");
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "planner" }, base_branch: "trunk", review_mode: "agile", checks: ["bun run lint", "bun run test"] });
    expect(tmb(["config"], project)).toBe('host: claude-code\nhost roles: claude-code planner\nbase branch: trunk\nreview mode: agile\nchecks: "bun run lint", "bun run test"\n');
  });

  test("with no terminal and no flags, never waits for input: takes the defaults and prints them", async () => {
    const project = newBunProject();
    // stdin stays open and empty: a setup that waited for an answer would never exit.
    const child = Bun.spawn([process.execPath, CLI, "setup"], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), NO_INPUT_LIMIT_MS);
    const status = await child.exited;
    clearTimeout(timer);
    const stdout = await new Response(child.stdout).text();
    expect(status).toBe(0);
    expect(stdout).toContain("There is no terminal to ask on, so each question takes its default");
    expect(stdout).toContain("  base branch: trunk\n");
    expect(stdout).toContain("  review mode: agile\n");
    expect(stdout).toContain('  checks: "bun run lint", "bun run test"\n');
    expect(config(project).base_branch).toBe("trunk");
  });

  test("flags override the defaults, and a re-run with the same answers changes no file and records nothing", () => {
    const project = newBunProject();
    const flags = ["setup", "--host", "claude-code", "--base", "release", "--review-mode", "agile", "--check", "make lint", "--check", "make test"];
    tmb(flags, project);
    expect(config(project)).toEqual({ host: "claude-code", host_roles: { "claude-code": "planner" }, base_branch: "release", review_mode: "agile", checks: ["make lint", "make test"] });
    const recorded = auditCount(project);

    const files = [".mcp.json", ".claude/settings.local.json", ".gitignore"].map((file) => path.join(project, file));
    const before = files.map((file) => readFileSync(file, "utf8"));
    expect(tmb(flags, project)).toContain("No setting changed, so nothing was recorded.");
    // The stored answers are the defaults now, so a plain re-run gives the same answers too.
    tmb(["setup"], project);
    expect(auditCount(project)).toBe(recorded);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  });

  test("refuses a review mode that does not exist, and writes nothing", () => {
    const project = newBunProject();
    const result = run(["setup", "--review-mode", "strict"], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review mode must be agile or truest, got "strict"');
    expect(readdirSync(project).sort()).toEqual([".git", "bun.lock", "package.json"]);
  });

  test("with no host installed, exits non-zero naming the supported hosts and writes nothing", () => {
    const project = newBunProject();
    const emptyPath = path.join(scratch, "empty-path");
    mkdirSync(emptyPath, { recursive: true });
    const result = run(["setup", "--yes"], project, { PATH: emptyPath });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no supported host is installed; tmb supports Claude Code (claude-code) and Codex (codex).");
    expect(readdirSync(project).sort()).toEqual([".git", "bun.lock", "package.json"]);
  });
});

describe("tmb config", () => {
  test("in a project with no record, says setup has not run and exits 1", () => {
    const project = newBunProject();
    const result = run(["config"], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("setup has not run");
  });
});
