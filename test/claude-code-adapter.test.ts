import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerHook } from "../src/adapters/claude-code/hook.ts";
import { adapter } from "../src/adapters/claude-code/index.ts";
import { mcpJsonPath, registerServer, serverEntry, unregisterServer } from "../src/adapters/claude-code/mcp-json.ts";
import { hookCommand, install, isTmbHookCommand, remove, settingsPath } from "../src/adapters/claude-code/settings.ts";
import { OPEN_WORK_HEADING, openProjectStore, plannerRole, projectDbPath } from "../src/engine/index.ts";

const EXE = path.join(tmpdir(), "tmb bin", "tmb");
const BINARY = [EXE];
const BUN = path.join(tmpdir(), "bun bin", "bun");
const SOURCE = [BUN, path.join(tmpdir(), "my code", "tmb", "src", "cli.ts")];

let project: string;
const savedEnv = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
};

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-test-"));
  // Keep the machine's global git ignore rules out of the .gitignore tests.
  process.env.XDG_CONFIG_HOME = path.join(project, ".no-xdg");
  process.env.GIT_CONFIG_GLOBAL = path.join(project, ".no-gitconfig");
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function gitInit(dir: string): void {
  const result = spawnSync("git", ["init", "-q"], { cwd: dir, timeout: 10_000 });
  expect(result.status).toBe(0);
}

const tmbEntry = { hooks: [{ type: "command", command: hookCommand(BINARY) }] };
const tmbSettings = { hooks: { SessionStart: [tmbEntry] }, enabledMcpjsonServers: ["tmb"] };

describe("settings: setup", () => {
  test("on a fresh project creates the settings file with one SessionStart hook and the enabled server", () => {
    const result = install(project, BINARY);
    expect(result).toMatchObject({ hookAdded: true, serverEnabled: true });
    expect(readJson(settingsPath(project))).toEqual(tmbSettings);
    expect(hookCommand(BINARY)).toBe(`"${EXE}" hook session-start`);
  });

  test("merges into an existing file, keeping other keys, hooks and enabled servers", () => {
    const prior = {
      permissions: { allow: ["Bash(ls)"] },
      enabledMcpjsonServers: ["other"],
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      },
    };
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsPath(project), JSON.stringify(prior));

    install(project, BINARY);

    expect(readJson(settingsPath(project))).toEqual({
      permissions: prior.permissions,
      enabledMcpjsonServers: ["other", "tmb"],
      hooks: { SessionStart: [...prior.hooks.SessionStart, tmbEntry], PreToolUse: prior.hooks.PreToolUse },
    });
  });

  test("is idempotent", () => {
    install(project, BINARY);
    const first = readFileSync(settingsPath(project), "utf8");
    const second = install(project, BINARY);
    expect(second).toMatchObject({ hookAdded: false, serverEnabled: false });
    expect(readFileSync(settingsPath(project), "utf8")).toBe(first);
  });

  test("replaces a tmb hook that points at another executable", () => {
    install(project, [path.join(project, "old", "tmb")]);
    install(project, BINARY);
    expect(readJson(settingsPath(project))).toEqual(tmbSettings);
  });

  test("replaces a source-run hook with a binary one", () => {
    install(project, SOURCE);
    install(project, BINARY);
    expect(readJson(settingsPath(project))).toEqual(tmbSettings);
  });

  test("quotes a Windows executable path", () => {
    const winExe = "C:\\Users\\Jo Doe\\AppData\\Local\\tmb\\bin\\tmb.exe";
    install(project, [winExe]);
    expect(readJson(settingsPath(project))).toMatchObject({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `"${winExe}" hook session-start` }] }] },
    });
    expect(remove(project).hookRemoved).toBe(true);
  });

  test("refuses to overwrite a settings file that is not valid JSON", () => {
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsPath(project), "{ not json");
    expect(() => install(project, BINARY)).toThrow();
    expect(readFileSync(settingsPath(project), "utf8")).toBe("{ not json");
  });
});

describe("hook commands", () => {
  test("quotes the source run's Bun and entry file", () => {
    expect(hookCommand(SOURCE)).toBe(`"${SOURCE[0]}" "${SOURCE[1]}" hook session-start`);
  });

  test("recognises tmb's hook from a binary and from source, quoted or not", () => {
    expect(isTmbHookCommand(hookCommand(BINARY))).toBe(true);
    expect(isTmbHookCommand(hookCommand(SOURCE))).toBe(true);
    expect(isTmbHookCommand(`"/opt/bun/bin/bun" /srv/code/tmb/src/cli.ts hook session-start`)).toBe(true);
    expect(isTmbHookCommand(`"C:\\bun\\bun.exe" "C:\\code\\tmb\\src\\cli.ts" hook session-start`)).toBe(true);
  });

  test("leaves other commands alone", () => {
    expect(isTmbHookCommand(`"/bin/other" hook session-start`)).toBe(false);
    expect(isTmbHookCommand(`"/opt/bun/bin/bun" /srv/code/app/src/main.ts hook session-start`)).toBe(false);
    expect(isTmbHookCommand(`"${EXE}" hook session-end`)).toBe(false);
  });

  test("remove finds the hook a source-run setup wrote", () => {
    install(project, SOURCE);
    expect(remove(project)).toMatchObject({ hookRemoved: true, serverDisabled: true, fileDeleted: true });
  });
});

describe(".mcp.json", () => {
  test("a fresh project gets a file with the tmb server, which remove deletes again", () => {
    const result = registerServer(project, BINARY);
    expect(result).toMatchObject({ changed: true, created: true });
    expect(readJson(mcpJsonPath(project))).toEqual({ mcpServers: { tmb: { command: EXE, args: ["mcp", "--host", "claude-code"] } } });

    expect(unregisterServer(project)).toMatchObject({ removed: true, fileDeleted: true });
    expect(existsSync(mcpJsonPath(project))).toBe(false);
  });

  test("a source run registers Bun with the entry file before the arguments", () => {
    expect(serverEntry(SOURCE)).toEqual({ command: BUN, args: [SOURCE[1], "mcp", "--host", "claude-code"] });
  });

  test("merges into an existing file and never drops other servers; remove keeps the file", () => {
    const prior = { mcpServers: { other: { command: "other-server", args: ["--x"] } } };
    writeFileSync(mcpJsonPath(project), JSON.stringify(prior));

    expect(registerServer(project, BINARY)).toMatchObject({ changed: true, created: false });
    expect(readJson(mcpJsonPath(project))).toEqual({ mcpServers: { ...prior.mcpServers, tmb: serverEntry(BINARY) } });
    expect(registerServer(project, BINARY).changed).toBe(false);

    expect(unregisterServer(project)).toMatchObject({ removed: true, fileDeleted: false });
    expect(readJson(mcpJsonPath(project))).toEqual(prior);
  });

  test("keeps a file the Human made even when tmb's entry was its only server", () => {
    writeFileSync(mcpJsonPath(project), JSON.stringify({ mcpServers: {} }));
    registerServer(project, BINARY);
    expect(unregisterServer(project)).toMatchObject({ removed: true, fileDeleted: false });
    expect(readJson(mcpJsonPath(project))).toEqual({ mcpServers: {} });
  });

  test("ignores the file in git only when tmb created it", () => {
    gitInit(project);
    expect(registerServer(project, BINARY).gitignoreChanged).toBe(true);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe(".mcp.json\n");
    expect(registerServer(project, BINARY).gitignoreChanged).toBe(false);

    const other = mkdtempSync(path.join(project, "other-"));
    gitInit(other);
    writeFileSync(mcpJsonPath(other), "{}");
    expect(registerServer(other, BINARY).gitignoreChanged).toBe(false);
    expect(existsSync(path.join(other, ".gitignore"))).toBe(false);
  });

  test("refuses a file that is not a JSON object", () => {
    writeFileSync(mcpJsonPath(project), "[1]");
    expect(() => registerServer(project, BINARY)).toThrow();
    expect(readFileSync(mcpJsonPath(project), "utf8")).toBe("[1]");
  });
});

describe(".gitignore", () => {
  test("appends the settings file in a git work tree that does not ignore it", () => {
    gitInit(project);
    writeFileSync(path.join(project, ".gitignore"), "node_modules/");
    expect(install(project, BINARY).gitignoreChanged).toBe(true);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("node_modules/\n.claude/settings.local.json\n");

    expect(install(project, BINARY).gitignoreChanged).toBe(false);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("node_modules/\n.claude/settings.local.json\n");
  });

  test("leaves .gitignore alone when the file is already ignored", () => {
    gitInit(project);
    writeFileSync(path.join(project, ".gitignore"), "*.local.json\n");
    expect(install(project, BINARY).gitignoreChanged).toBe(false);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("*.local.json\n");
  });

  test("creates nothing outside a git work tree", () => {
    expect(install(project, BINARY).gitignoreChanged).toBe(false);
    expect(existsSync(path.join(project, ".gitignore"))).toBe(false);
  });
});

describe("settings: remove", () => {
  test("restores the prior content of an existing file", () => {
    const prior = {
      model: "x",
      enabledMcpjsonServers: ["other"],
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }] },
    };
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsPath(project), JSON.stringify(prior));

    install(project, BINARY);
    expect(remove(project)).toMatchObject({ hookRemoved: true, serverDisabled: true, fileDeleted: false });
    expect(readJson(settingsPath(project))).toEqual(prior);
  });

  test("drops the containers it emptied and keeps other keys", () => {
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsPath(project), JSON.stringify({ permissions: { allow: [] } }));
    install(project, BINARY);
    remove(project);
    expect(readJson(settingsPath(project))).toEqual({ permissions: { allow: [] } });
  });

  test("deletes the file it created on a fresh project", () => {
    install(project, BINARY);
    expect(remove(project).fileDeleted).toBe(true);
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
  });

  test("changes nothing when no tmb hook or server is present", () => {
    mkdirSync(path.join(project, ".claude"));
    const text = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: '"/bin/other" hook session-start' }] }] } });
    writeFileSync(settingsPath(project), text);
    expect(remove(project)).toMatchObject({ hookRemoved: false, serverDisabled: false });
    expect(readFileSync(settingsPath(project), "utf8")).toBe(text);
  });
});

describe("adapter setup and remove", () => {
  test("setup creates the record, registers and enables the server and adds the hook, idempotently", () => {
    gitInit(project);
    const first = adapter.setup(project, BINARY);
    expect(first.join("\n")).toContain("Created the record at");
    expect(existsSync(projectDbPath(project))).toBe(true);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe(".tmb/\n.mcp.json\n.claude/settings.local.json\n");
    const files = [mcpJsonPath(project), settingsPath(project), path.join(project, ".gitignore")];
    const before = files.map((file) => readFileSync(file, "utf8"));

    const second = adapter.setup(project, BINARY);
    expect(second.every((line) => /already|kept/.test(line))).toBe(true);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  });

  test("setup refuses a record it cannot read and changes nothing else", () => {
    mkdirSync(path.dirname(projectDbPath(project)), { recursive: true });
    writeFileSync(projectDbPath(project), "not a database at all, just some text that is long enough");
    expect(() => adapter.setup(project, BINARY)).toThrow(/cannot set up the record/);
    expect(existsSync(mcpJsonPath(project))).toBe(false);
    expect(existsSync(settingsPath(project))).toBe(false);
  });

  test("remove undoes setup and keeps the record, saying so", () => {
    adapter.setup(project, SOURCE);
    const lines = adapter.remove(project);
    expect(existsSync(mcpJsonPath(project))).toBe(false);
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
    expect(existsSync(projectDbPath(project))).toBe(true);
    expect(lines.filter((line) => line.includes("Kept the record"))).toHaveLength(1);
  });
});

describe("hook session-start", () => {
  const roleOnly = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: plannerRole } };

  test("answers with the planner role alone when the project has no record", () => {
    const output = JSON.parse(answerHook("session-start", JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: project })));
    expect(output).toEqual(roleOnly);
    expect(output.hookSpecificOutput.additionalContext).toStartWith("# You are bro, the planner");
  });

  test("takes the project from cwd in the input, then CLAUDE_PROJECT_DIR", () => {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.createIssue({ kind: "human" }, { title: "Resume me" });
    opened.store.close();

    const fromCwd = JSON.parse(answerHook("session-start", JSON.stringify({ cwd: project })));
    expect(fromCwd.hookSpecificOutput.additionalContext).toContain(OPEN_WORK_HEADING);
    expect(fromCwd.hookSpecificOutput.additionalContext).toContain("Resume me");

    process.env.CLAUDE_PROJECT_DIR = project;
    const fromEnv = JSON.parse(answerHook("session-start", "{}"));
    expect(fromEnv.hookSpecificOutput.additionalContext).toContain("Resume me");
  });

  test("rejects an unknown event", () => {
    expect(() => answerHook("nope", "")).toThrow();
  });
});

describe("cli hook", () => {
  const cli = path.join(import.meta.dir, "..", "src", "cli.ts");

  function runHook(args: string[], input: string) {
    return spawnSync(process.execPath, [cli, "hook", ...args], { input, encoding: "utf8", timeout: 30_000 });
  }

  test("prints the hook output and exits 0", () => {
    const result = runHook(["session-start"], JSON.stringify({ cwd: project }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(plannerRole);
  });

  test("exits 0 with a stderr note on bad input", () => {
    const result = runHook(["session-start"], "{ not json");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("tmb hook:");
  });
});
