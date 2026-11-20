// `tmb init` then `tmb remove` as separate processes: init writes the three registrations
// (the tool server, the role files, the event hooks) and the record; remove takes back only
// what init added and leaves every file the Human wrote as it was.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { roleFilePath } from "../../src/adapters/claude-code/role-files.ts";
import { isTmbHookCommand, TMB_HOOKS } from "../../src/adapters/claude-code/settings.ts";
import { projectDbPath, SUBAGENT_ROLES } from "../../src/engine/index.ts";
import { pathWithFakeClaude } from "./fake-host.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli.ts");
const ROLE_NAMES = SUBAGENT_ROLES.map((role) => role.name);

const SETTINGS = path.join(".claude", "settings.local.json");
const MCP_JSON = ".mcp.json";
const MINE_AGENT = path.join(".claude", "agents", "mine.md");

let scratch: string;
let env: Record<string, string>;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-init-remove-")));
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

function tmb(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function newGitProject(): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  expect(spawnSync("git", ["init", "-q", "-b", "trunk"], { cwd: project, env, timeout: 10_000 }).status).toBe(0);
  return project;
}

/** Runs `tmb init`, which writes the engine's subagent roles among the rest. */
function setUp(project: string): void {
  const out = tmb(["init"], project);
  for (const name of ROLE_NAMES) expect(out).toContain(`Wrote the ${name} role to ${path.relative(project, roleFilePath(project, name))}.`);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Every hook command in a settings object, from every event and group. */
function hookCommands(settings: Record<string, unknown>): unknown[] {
  const hooks = (settings.hooks ?? {}) as Record<string, { hooks?: { command?: unknown }[] }[]>;
  return Object.values(hooks).flatMap((groups) => groups.flatMap((group) => (group.hooks ?? []).map((hook) => hook.command)));
}

/** The tmb hook names wired in the settings, by host event. */
function tmbHooksByEvent(settings: Record<string, unknown>): Record<string, string[]> {
  const hooks = (settings.hooks ?? {}) as Record<string, { hooks?: { command?: unknown }[] }[]>;
  const wired: Record<string, string[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const names = groups.flatMap((group) => (group.hooks ?? []).map((hook) => hook.command)).filter((command) => isTmbHookCommand(command));
    if (names.length > 0) wired[event] = names.map((command) => String(command).split(" hook ").at(-1)!);
  }
  return wired;
}

function noTmbHookLeft(project: string): void {
  const file = path.join(project, SETTINGS);
  if (!existsSync(file)) return;
  expect(hookCommands(readJson(file)).filter((command) => isTmbHookCommand(command))).toEqual([]);
}

describe("tmb init on a fresh project", () => {
  test("writes the tool server registration, the role registration, the three event hooks and the database", () => {
    const project = newGitProject();
    setUp(project);

    const mcp = readJson(path.join(project, MCP_JSON));
    expect((mcp.mcpServers as Record<string, unknown>).tmb).toEqual({ command: process.execPath, args: [CLI, "mcp", "--host", "claude-code"] });

    const settings = readJson(path.join(project, SETTINGS));
    expect(settings.enabledMcpjsonServers).toEqual(["tmb"]);
    expect(tmbHooksByEvent(settings)).toEqual(Object.fromEntries(TMB_HOOKS.map((hook) => [hook.hookEvent, [hook.name]])));

    expect(readdirSync(path.join(project, ".claude", "agents")).sort()).toEqual(["reviewer.md", "worker.md"]);
    for (const role of SUBAGENT_ROLES) expect(readFileSync(roleFilePath(project, role.name), "utf8")).toContain(role.prompt.trim());

    const again = tmb(["init"], project);
    for (const name of ROLE_NAMES) expect(again).toContain(`${path.relative(project, roleFilePath(project, name))} already holds the ${name} role; nothing to change.`);

    expect(projectDbPath(project)).toBe(path.join(project, ".tmb", "trajectory.db"));
    expect(existsSync(projectDbPath(project))).toBe(true);
  });
});

describe("tmb remove", () => {
  test("in a project seeded with the Human's files, restores each of them and keeps the record", () => {
    const project = newGitProject();
    const humanSettings = {
      permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)"] },
      enabledMcpjsonServers: ["mine"],
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hello from the Human" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./scripts/check-bash.sh" }] }],
      },
    };
    const humanMcp = { mcpServers: { mine: { command: "my-server", args: ["--stdio"] } } };
    const humanAgent = "---\nname: mine\ndescription: The Human's own agent\n---\n\nHelp me.\n";
    const humanGitignore = "node_modules/\n# the Human's comment\ndist\n";

    mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(project, SETTINGS), JSON.stringify(humanSettings, null, 2));
    writeFileSync(path.join(project, MCP_JSON), JSON.stringify(humanMcp, null, 2));
    writeFileSync(path.join(project, MINE_AGENT), humanAgent);
    writeFileSync(path.join(project, ".gitignore"), humanGitignore);
    const agentBytes = readFileSync(path.join(project, MINE_AGENT));

    setUp(project);
    // Setup did wire itself in beside the Human's own entries, so remove has something to take back.
    expect(tmbHooksByEvent(readJson(path.join(project, SETTINGS)))).toEqual(Object.fromEntries(TMB_HOOKS.map((hook) => [hook.hookEvent, [hook.name]])));
    expect(Object.keys(readJson(path.join(project, MCP_JSON)).mcpServers as object).sort()).toEqual(["mine", "tmb"]);

    tmb(["remove"], project);

    expect(readJson(path.join(project, SETTINGS))).toEqual(humanSettings);
    expect(readJson(path.join(project, MCP_JSON))).toEqual(humanMcp);
    expect(readFileSync(path.join(project, MINE_AGENT)).equals(agentBytes)).toBe(true);
    expect(readdirSync(path.join(project, ".claude", "agents"))).toEqual(["mine.md"]);
    noTmbHookLeft(project);
    // The record is the Human's data: remove keeps it, and keeps the lines init added to .gitignore.
    expect(existsSync(projectDbPath(project))).toBe(true);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toStartWith(humanGitignore);
  });

  test("after init on a fresh project, deletes the .mcp.json init created and leaves no tmb hook", () => {
    const project = newGitProject();
    setUp(project);
    expect(existsSync(path.join(project, MCP_JSON))).toBe(true);

    tmb(["remove"], project);

    expect(existsSync(path.join(project, MCP_JSON))).toBe(false);
    for (const name of ROLE_NAMES) expect(existsSync(roleFilePath(project, name))).toBe(false);
    noTmbHookLeft(project);
    expect(existsSync(projectDbPath(project))).toBe(true);
  });
});
