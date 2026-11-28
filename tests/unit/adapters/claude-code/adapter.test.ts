import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adapter, settingsFile, toolServer } from "../../../../src/adapters/claude-code/index.ts";
import { serverEntry } from "../../../../src/adapters/claude-code/mcp-json.ts";
import { setUpRecord } from "../../../../src/adapters/common/record.ts";
import { hookCommand, isTmbHookCommand } from "../../../../src/adapters/claude-code/settings.ts";
import { OPEN_WORK_HEADING, openProjectStore, plannerRole, projectDbPath, reviewerRole, subagentRolesOf, UNATTENDED_INSTRUCTION } from "../../../../src/engine/index.ts";
import { namingProgram } from "../../../../src/engine/program.ts";
import { HOOK_TEXT_CAP, SESSION_TEXT_BUDGET } from "../../../../src/adapters/claude-code/host.ts";
import { CLI_ENTRY } from "../../../lib/paths.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const EXE = path.join(tmpdir(), "tmb bin", "tmb");
const BINARY = [EXE];
const ATTENDED = { unattended: false };
const BUN = path.join(tmpdir(), "bun bin", "bun");
const SOURCE = [BUN, path.join(tmpdir(), "my code", "tmb", "src", "cli", "index.ts")];

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

const GUARDED_MATCHER = "Agent|Task|mcp__tmb__task_brief|mcp__tmb__task_close";
const tmbHooks = (tmbCommand: readonly string[]) => ({
  SessionStart: [
    { hooks: [{ type: "command", command: hookCommand(tmbCommand, "session-start-role") }] },
    { hooks: [{ type: "command", command: hookCommand(tmbCommand, "session-start") }] },
  ],
  PreToolUse: [{ matcher: GUARDED_MATCHER, hooks: [{ type: "command", command: hookCommand(tmbCommand, "pre-tool-use") }] }],
  PostToolUseFailure: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: hookCommand(tmbCommand, "post-tool-use-failure") }] }],
  SubagentStop: [{ hooks: [{ type: "command", command: hookCommand(tmbCommand, "subagent-stop") }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(tmbCommand, "user-prompt-submit") }] }],
  SessionEnd: [{ hooks: [{ type: "command", command: hookCommand(tmbCommand, "session-end") }] }],
});
const tmbSettings = { hooks: tmbHooks(BINARY), enabledMcpjsonServers: ["tmb"] };
const ALL_HOOKS = ["SessionStart", "PreToolUse", "PostToolUseFailure", "SubagentStop", "UserPromptSubmit", "SessionEnd"];

describe("settings: setup", () => {
  test("on a fresh project creates the settings file with tmb's hooks and the enabled server", () => {
    const result = settingsFile.install(project, BINARY);
    expect(result).toMatchObject({ hooksAdded: ALL_HOOKS, serverEnabled: true });
    expect(readJson(settingsFile.path(project))).toEqual(tmbSettings);
    expect(hookCommand(BINARY, "session-start")).toBe(`"${EXE}" hook session-start`);
    expect(hookCommand(BINARY, "pre-tool-use")).toBe(`"${EXE}" hook pre-tool-use`);
    expect(hookCommand(BINARY, "subagent-stop")).toBe(`"${EXE}" hook subagent-stop`);
  });

  test("the PreToolUse matcher covers the subagent starts, the shell, and the tools a worker names its task with, and no file write", () => {
    settingsFile.install(project, BINARY);
    const [group] = (readJson(settingsFile.path(project)) as { hooks: { PreToolUse: { matcher: string }[] } }).hooks.PreToolUse;
    expect(group!.matcher.split("|").sort()).toEqual(["Agent", "Task", "mcp__tmb__task_brief", "mcp__tmb__task_close"]);
  });

  test("a project an older tmb wired with the file-write matcher loses it on the next init, and doctor and init agree on the gap", () => {
    const old = tmbHooks(BINARY);
    old.PreToolUse[0]!.matcher = `Write|Edit|MultiEdit|NotebookEdit|${GUARDED_MATCHER}`;
    mkdirSync(path.dirname(settingsFile.path(project)), { recursive: true });
    writeFileSync(settingsFile.path(project), JSON.stringify({ hooks: old, enabledMcpjsonServers: ["tmb"] }));

    expect(settingsFile.gaps(project, BINARY)).toEqual([".claude/settings.local.json lacks tmb's current PreToolUse hook"]);
    expect(settingsFile.install(project, BINARY).hooksAdded).toEqual(["PreToolUse"]);
    expect(readJson(settingsFile.path(project))).toEqual(tmbSettings);
    expect(settingsFile.gaps(project, BINARY)).toEqual([]);
  });

  test("merges into an existing file, keeping other keys, hooks and enabled servers", () => {
    const prior = {
      permissions: { allow: ["Bash(ls)"] },
      enabledMcpjsonServers: ["other"],
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "done.sh" }] }],
      },
    };
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsFile.path(project), JSON.stringify(prior));

    settingsFile.install(project, BINARY);

    const ours = tmbHooks(BINARY);
    expect(readJson(settingsFile.path(project))).toEqual({
      permissions: prior.permissions,
      enabledMcpjsonServers: ["other", "tmb"],
      hooks: {
        SessionStart: [...prior.hooks.SessionStart, ...ours.SessionStart],
        PreToolUse: [...prior.hooks.PreToolUse, ...ours.PreToolUse],
        PostToolUseFailure: ours.PostToolUseFailure,
        SubagentStop: [...prior.hooks.SubagentStop, ...ours.SubagentStop],
        UserPromptSubmit: ours.UserPromptSubmit,
        Stop: prior.hooks.Stop,
        SessionEnd: ours.SessionEnd,
      },
    });
  });

  test("is idempotent", () => {
    settingsFile.install(project, BINARY);
    const first = readFileSync(settingsFile.path(project), "utf8");
    const second = settingsFile.install(project, BINARY);
    expect(second).toMatchObject({ hooksAdded: [], serverEnabled: false });
    expect(readFileSync(settingsFile.path(project), "utf8")).toBe(first);
  });

  test("replaces a tmb hook that points at another executable", () => {
    settingsFile.install(project, [path.join(project, "old", "tmb")]);
    settingsFile.install(project, BINARY);
    expect(readJson(settingsFile.path(project))).toEqual(tmbSettings);
  });

  test("replaces a source-run hook with a binary one", () => {
    settingsFile.install(project, SOURCE);
    settingsFile.install(project, BINARY);
    expect(readJson(settingsFile.path(project))).toEqual(tmbSettings);
  });

  test("replaces only the stale kind, and a PreToolUse hook whose matcher is out of date", () => {
    settingsFile.install(project, BINARY);
    const settings = readJson(settingsFile.path(project)) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    settings.hooks.SubagentStop![0]!.hooks[0]!.command = hookCommand([path.join(project, "old", "tmb")], "subagent-stop");
    settings.hooks.PreToolUse![0]!.matcher = "Write|Bash";
    writeFileSync(settingsFile.path(project), JSON.stringify(settings));

    expect(settingsFile.install(project, BINARY).hooksAdded).toEqual(["PreToolUse", "SubagentStop"]);
    expect(readJson(settingsFile.path(project))).toEqual(tmbSettings);
  });

  test("quotes a Windows executable path", () => {
    const winExe = "C:\\Users\\Jo Doe\\AppData\\Local\\tmb\\bin\\tmb.exe";
    settingsFile.install(project, [winExe]);
    expect(readJson(settingsFile.path(project))).toMatchObject({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `"${winExe}" hook session-start-role` }] }, { hooks: [{ type: "command", command: `"${winExe}" hook session-start` }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: `"${winExe}" hook pre-tool-use` }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: `"${winExe}" hook subagent-stop` }] }],
      },
    });
    expect(settingsFile.remove(project).hooksRemoved).toEqual(ALL_HOOKS);
  });

  test("refuses to overwrite a settings file that is not valid JSON", () => {
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsFile.path(project), "{ not json");
    expect(() => settingsFile.install(project, BINARY)).toThrow();
    expect(readFileSync(settingsFile.path(project), "utf8")).toBe("{ not json");
  });
});

describe("hook commands", () => {
  test("quotes the source run's Bun and entry file", () => {
    expect(hookCommand(SOURCE, "session-start")).toBe(`"${SOURCE[0]}" "${SOURCE[1]}" hook session-start`);
  });

  test("recognises each of tmb's hooks from a binary and from source, quoted or not", () => {
    for (const name of ["session-start", "pre-tool-use", "post-tool-use-failure", "subagent-stop", "user-prompt-submit", "session-end"] as const) {
      expect(isTmbHookCommand(hookCommand(BINARY, name))).toBe(true);
      expect(isTmbHookCommand(hookCommand(SOURCE, name), name)).toBe(true);
      expect(isTmbHookCommand(`"/opt/bun/bin/bun" /srv/code/tmb/src/cli.ts hook ${name}`)).toBe(true);
      expect(isTmbHookCommand(`"C:\\bun\\bun.exe" "C:\\code\\tmb\\src\\cli.ts" hook ${name}`)).toBe(true);
    }
    expect(isTmbHookCommand(hookCommand(BINARY, "pre-tool-use"), "session-start")).toBe(false);
  });

  test("leaves other commands alone", () => {
    expect(isTmbHookCommand(`"/bin/other" hook session-start`)).toBe(false);
    expect(isTmbHookCommand(`"/opt/bun/bin/bun" /srv/code/app/src/main.ts hook pre-tool-use`)).toBe(false);
    expect(isTmbHookCommand(`"${EXE}" hook session-stop`)).toBe(false);
  });

  test("remove finds the hooks a source-run setup wrote", () => {
    settingsFile.install(project, SOURCE);
    expect(settingsFile.remove(project)).toMatchObject({ hooksRemoved: ALL_HOOKS, serverDisabled: true, fileDeleted: true });
  });
});

describe(".mcp.json", () => {
  test("a fresh project gets a file with the tmb server, which remove deletes again", () => {
    const result = toolServer.register(project, BINARY);
    expect(result).toMatchObject({ changed: true, created: true });
    expect(readJson(toolServer.path(project))).toEqual({ mcpServers: { tmb: { command: EXE, args: ["mcp", "--host", "claude-code"] } } });

    expect(toolServer.unregister(project)).toMatchObject({ removed: true, fileDeleted: true });
    expect(existsSync(toolServer.path(project))).toBe(false);
  });

  test("a source run registers Bun with the entry file before the arguments", () => {
    expect(serverEntry(SOURCE)).toEqual({ command: BUN, args: [SOURCE[1], "mcp", "--host", "claude-code"] });
  });

  test("merges into an existing file and never drops other servers; remove keeps the file", () => {
    const prior = { mcpServers: { other: { command: "other-server", args: ["--x"] } } };
    writeFileSync(toolServer.path(project), JSON.stringify(prior));

    expect(toolServer.register(project, BINARY)).toMatchObject({ changed: true, created: false });
    expect(readJson(toolServer.path(project))).toEqual({ mcpServers: { ...prior.mcpServers, tmb: serverEntry(BINARY) } });
    expect(toolServer.register(project, BINARY).changed).toBe(false);

    expect(toolServer.unregister(project)).toMatchObject({ removed: true, fileDeleted: false });
    expect(readJson(toolServer.path(project))).toEqual(prior);
  });

  test("keeps a file the Human made even when tmb's entry was its only server", () => {
    writeFileSync(toolServer.path(project), JSON.stringify({ mcpServers: {} }));
    toolServer.register(project, BINARY);
    expect(toolServer.unregister(project)).toMatchObject({ removed: true, fileDeleted: false });
    expect(readJson(toolServer.path(project))).toEqual({ mcpServers: {} });
  });

  test("ignores the file in git only when tmb created it", () => {
    gitInit(project);
    expect(toolServer.register(project, BINARY).gitignoreChanged).toBe(true);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe(".mcp.json\n");
    expect(toolServer.register(project, BINARY).gitignoreChanged).toBe(false);

    const other = mkdtempSync(path.join(project, "other-"));
    gitInit(other);
    writeFileSync(toolServer.path(other), "{}");
    expect(toolServer.register(other, BINARY).gitignoreChanged).toBe(false);
    expect(existsSync(path.join(other, ".gitignore"))).toBe(false);
  });

  test("refuses a file that is not a JSON object", () => {
    writeFileSync(toolServer.path(project), "[1]");
    expect(() => toolServer.register(project, BINARY)).toThrow();
    expect(readFileSync(toolServer.path(project), "utf8")).toBe("[1]");
  });
});

describe(".gitignore", () => {
  test("appends the settings file in a git work tree that does not ignore it", () => {
    gitInit(project);
    writeFileSync(path.join(project, ".gitignore"), "node_modules/");
    expect(settingsFile.install(project, BINARY).gitignoreChanged).toBe(true);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("node_modules/\n.claude/settings.local.json\n");

    expect(settingsFile.install(project, BINARY).gitignoreChanged).toBe(false);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("node_modules/\n.claude/settings.local.json\n");
  });

  test("leaves .gitignore alone when the file is already ignored", () => {
    gitInit(project);
    writeFileSync(path.join(project, ".gitignore"), "*.local.json\n");
    expect(settingsFile.install(project, BINARY).gitignoreChanged).toBe(false);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("*.local.json\n");
  });

  test("init ignores the whole .tmb/ folder when the project already ignores *.db (#130)", () => {
    gitInit(project);
    writeFileSync(path.join(project, ".gitignore"), "*.db\n");
    expect(setUpRecord(project)).toContain("Added .tmb/ to .gitignore.");
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("*.db\n.tmb/\n");
    writeFileSync(path.join(project, ".tmb", "claude-code-created.json"), "{}");
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: project, encoding: "utf8" });
    expect(status.stdout).not.toContain(".tmb/");

    expect(setUpRecord(project).some((line) => line.includes(".gitignore"))).toBe(false);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("*.db\n.tmb/\n");
  });

  test("creates nothing outside a git work tree", () => {
    expect(settingsFile.install(project, BINARY).gitignoreChanged).toBe(false);
    expect(existsSync(path.join(project, ".gitignore"))).toBe(false);
  });
});

describe("settings: remove", () => {
  test("restores the prior content of an existing file", () => {
    const prior = {
      model: "x",
      enabledMcpjsonServers: ["other"],
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
      },
    };
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsFile.path(project), JSON.stringify(prior));

    settingsFile.install(project, BINARY);
    expect(settingsFile.remove(project)).toMatchObject({ hooksRemoved: ALL_HOOKS, serverDisabled: true, fileDeleted: false });
    expect(readJson(settingsFile.path(project))).toEqual(prior);
  });

  test("keeps the Human's hooks that share a group with tmb's", () => {
    settingsFile.install(project, BINARY);
    const settings = readJson(settingsFile.path(project)) as { hooks: Record<string, { hooks: unknown[] }[]> };
    settings.hooks.PreToolUse![0]!.hooks.push({ type: "command", command: "guard.sh" });
    writeFileSync(settingsFile.path(project), JSON.stringify(settings));

    settingsFile.remove(project);
    expect(readJson(settingsFile.path(project))).toEqual({
      hooks: { PreToolUse: [{ matcher: GUARDED_MATCHER, hooks: [{ type: "command", command: "guard.sh" }] }] },
    });
  });

  test("drops the containers it emptied and keeps other keys", () => {
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsFile.path(project), JSON.stringify({ permissions: { allow: [] } }));
    settingsFile.install(project, BINARY);
    settingsFile.remove(project);
    expect(readJson(settingsFile.path(project))).toEqual({ permissions: { allow: [] } });
  });

  test("deletes the file it created on a fresh project", () => {
    settingsFile.install(project, BINARY);
    expect(settingsFile.remove(project).fileDeleted).toBe(true);
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
  });

  test("changes nothing when no tmb hook or server is present", () => {
    mkdirSync(path.join(project, ".claude"));
    const text = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: '"/bin/other" hook session-start' }] }] } });
    writeFileSync(settingsFile.path(project), text);
    expect(settingsFile.remove(project)).toMatchObject({ hooksRemoved: [], serverDisabled: false });
    expect(readFileSync(settingsFile.path(project), "utf8")).toBe(text);
  });
});

describe("adapter setup and remove", () => {
  test("setup creates the record, registers and enables the server and adds the hook, idempotently", () => {
    gitInit(project);
    const first = adapter.setup(project, BINARY);
    expect(first.join("\n")).toContain("Created the record at");
    expect(existsSync(projectDbPath(project))).toBe(true);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe(".tmb/\n.mcp.json\n.claude/settings.local.json\n");
    const files = [toolServer.path(project), settingsFile.path(project), path.join(project, ".gitignore")];
    const before = files.map((file) => readFileSync(file, "utf8"));

    const second = adapter.setup(project, BINARY);
    expect(second.every((line) => /already|kept/.test(line))).toBe(true);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  });

  test("setup refuses a record it cannot read and changes nothing else", () => {
    mkdirSync(path.dirname(projectDbPath(project)), { recursive: true });
    writeFileSync(projectDbPath(project), "not a database at all, just some text that is long enough");
    expect(() => adapter.setup(project, BINARY)).toThrow(/cannot set up the record/);
    expect(existsSync(toolServer.path(project))).toBe(false);
    expect(existsSync(settingsFile.path(project))).toBe(false);
  });

  test("a role the project creates gets its agent file; setup keeps it; once deleted, its file goes", () => {
    adapter.setup(project, BINARY);
    const agentFile = path.join(project, ".claude", "agents", "designer.md");
    const opened = openProjectStore(project, { create: false });
    if (!opened.ok) throw opened.error;
    const id = opened.store.createRole({ kind: "agent", role: "planner", host: "claude-code" }, { name: "designer", purpose: "Draws the screens", prompt: "You are the designer." });
    adapter.writeRoles(project, subagentRolesOf(opened.store));
    const written = readFileSync(agentFile, "utf8");
    expect(written).toContain("You are the designer.");
    expect(written).toContain('Pass `role: "designer"` on every call');
    adapter.setup(project, BINARY);
    expect(existsSync(agentFile)).toBe(true);
    opened.store.deleteRole({ kind: "agent", role: "planner", host: "claude-code" }, id);
    adapter.writeRoles(project, subagentRolesOf(opened.store));
    opened.store.close();
    expect(existsSync(agentFile)).toBe(false);
    expect(existsSync(path.join(project, ".claude", "agents", "worker.md"))).toBe(true);
  });

  test("remove undoes setup and keeps the record, saying so", () => {
    adapter.setup(project, SOURCE);
    const lines = adapter.remove(project);
    expect(existsSync(toolServer.path(project))).toBe(false);
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
    expect(existsSync(projectDbPath(project))).toBe(true);
    expect(lines.filter((line) => line.includes("Kept the record"))).toHaveLength(1);
  });
});

describe("hook session-start", () => {
  const roleOnly = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: plannerRole } };

  test("answers with the planner role alone when the project has no record", () => {
    const output = JSON.parse(adapter.answerHook("session-start", JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: project }), ATTENDED));
    expect(output).toEqual(roleOnly);
    expect(output.hookSpecificOutput.additionalContext).toStartWith("# You are bro, the planner");
  });

  test("takes the project from CLAUDE_PROJECT_DIR, then cwd in the input, looking up from a subfolder", () => {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.createIssue({ kind: "human" }, { title: "Resume me" });
    opened.store.close();
    const sub = path.join(project, "src", "deep");
    mkdirSync(sub, { recursive: true });

    const fromCwd = JSON.parse(adapter.answerHook("session-start", JSON.stringify({ cwd: sub }), ATTENDED));
    expect(fromCwd.hookSpecificOutput.additionalContext).toContain(OPEN_WORK_HEADING);
    expect(fromCwd.hookSpecificOutput.additionalContext).toContain("Resume me");

    process.env.CLAUDE_PROJECT_DIR = sub;
    const fromEnv = JSON.parse(adapter.answerHook("session-start", JSON.stringify({ cwd: tmpdir() }), ATTENDED));
    expect(fromEnv.hookSpecificOutput.additionalContext).toContain("Resume me");
  });

  const textOf = (event: string, run = ATTENDED) => {
    const answer = adapter.answerHook(event, JSON.stringify({ hook_event_name: "SessionStart", cwd: project }), run);
    return answer === "" ? "" : (JSON.parse(answer).hookSpecificOutput.additionalContext as string);
  };

  test("with both hooks wired, the role and the project's state are two texts", () => {
    settingsFile.install(project, BINARY);
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.createIssue({ kind: "human" }, { title: "Resume me" });
    opened.store.close();

    expect(textOf("session-start-role")).toBe(plannerRole);
    const state = textOf("session-start");
    expect(state).toContain("Resume me");
    expect(state).not.toContain("# You are bro");
    expect(textOf("session-start", { unattended: true })).toStartWith(UNATTENDED_INSTRUCTION);
  });

  test("settings an older tmb wired, with no role hook, get the role in the state's text, and doctor and init agree on the gap", () => {
    const old = tmbHooks(BINARY);
    old.SessionStart = old.SessionStart.filter((group) => !group.hooks[0]!.command.endsWith("session-start-role"));
    mkdirSync(path.dirname(settingsFile.path(project)), { recursive: true });
    writeFileSync(settingsFile.path(project), JSON.stringify({ hooks: old, enabledMcpjsonServers: ["tmb"] }));

    expect(textOf("session-start")).toStartWith("# You are bro, the planner");
    expect(settingsFile.gaps(project, BINARY)).toEqual([".claude/settings.local.json lacks tmb's current SessionStart hook"]);
    expect(settingsFile.install(project, BINARY).hooksAdded).toEqual(["SessionStart"]);
    expect(settingsFile.gaps(project, BINARY)).toEqual([]);
    expect(textOf("session-start")).not.toContain("# You are bro");
  });

  test("tmb cuts the state to its budget, below Claude Code's cap, listing the newest and naming the tool for the rest", () => {
    expect(SESSION_TEXT_BUDGET).toBeLessThan(HOOK_TEXT_CAP);
    settingsFile.install(project, BINARY);
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    for (let i = 1; i <= 30; i++) opened.store.createIssue({ kind: "human" }, { title: `Issue ${i} ${"long words ".repeat(50)}` });
    opened.store.close();

    for (const run of [ATTENDED, { unattended: true }]) {
      const state = textOf("session-start", run);
      expect(state.length).toBeLessThanOrEqual(SESSION_TEXT_BUDGET);
      expect(state).toContain("Issue 30 ");
      expect(state).not.toContain("Issue 1 ");
      expect(state).toMatch(/…and \d+ older open issues; issue_list shows them all\./);
    }
  });

  test("the reviewer's role fits its session-start text's budget", () => {
    expect(namingProgram(reviewerRole).length).toBeLessThanOrEqual(SESSION_TEXT_BUDGET);
  });

  test("the planner's role fits its session-start text's budget", () => {
    expect(namingProgram(plannerRole).length).toBeLessThanOrEqual(SESSION_TEXT_BUDGET);
  });

  test("rejects an unknown event", () => {
    expect(() => adapter.answerHook("nope", "", ATTENDED)).toThrow();
  });
});

describe("cli hook", () => {
  const cli = CLI_ENTRY;

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
