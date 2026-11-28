// trustmybot/tmb#128: after an update, a session start brings a project's host files to the
// running tmb by itself, as a fresh `tmb init` of that version would write them.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerHook } from "../../src/adapters/claude-code/hook.ts";
import { adapter as claudeCode } from "../../src/adapters/claude-code/index.ts";
import { roleFilePath, roleFileText } from "../../src/adapters/claude-code/role-files.ts";
import { hookCommand, install, settingsPath } from "../../src/adapters/claude-code/settings.ts";
import { installHooks } from "../../src/adapters/codex/hooks-json.ts";
import { hooksJsonPath } from "../../src/adapters/codex/paths.ts";
import { HOST_ADAPTERS } from "../../src/adapters/index.ts";
import { handleEvent, HOST_FILES_HEADING, installPushGate, openProjectStore, recordProgramMove, SUBAGENT_ROLES, tiedProgram, tieProgram, writeSetting } from "../../src/engine/index.ts";
import type { Actor, Store } from "../../src/engine/store/index.ts";
import { refreshProject } from "../../src/cli/commands/refresh.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "claude-code" };
const COMMAND = [path.join(tmpdir(), "tmb bin", "tmb")];
const A = "1.0.0";
const B = "1.1.0";

let root: string;
const savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tmb-refresh-"));
  process.env.XDG_CONFIG_HOME = path.join(root, ".no-xdg");
  process.env.GIT_CONFIG_GLOBAL = path.join(root, ".no-gitconfig");
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function newProject(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  expect(spawnSync("git", ["init", "-q"], { cwd: dir, timeout: 10_000 }).status).toBe(0);
  // The Human's own entries, which a refresh must leave as they are.
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath(dir),
    JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2),
  );
  writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "my-server" } } }, null, 2));
  writeFileSync(path.join(dir, ".claude", "agents-readme.txt"), "mine\n");
  return dir;
}

function withStore<T>(dir: string, use: (store: Store) => T): T {
  const opened = openProjectStore(dir, { create: false });
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    return use(opened.store);
  } finally {
    opened.store.close();
  }
}

/** What `tmb init` of `program` at `version` leaves: the host's wiring, git's push hook, the tie and the host setting. */
function wire(dir: string, version: string, program = "tmb"): void {
  claudeCode.setup(dir, COMMAND);
  installPushGate(dir, COMMAND);
  withStore(dir, (store) => {
    tieProgram(store, HUMAN, { program, version, command: COMMAND });
    writeSetting(store, HUMAN, "host", "claude-code");
    writeSetting(store, HUMAN, "host_roles", { "claude-code": "planner" });
  });
}

/** Makes the project's files look as an earlier version wrote them: a changed role, a role since dropped, a hook since moved. */
function ageFiles(dir: string): void {
  const worker = SUBAGENT_ROLES[0]!;
  writeFileSync(roleFilePath(dir, worker.name), roleFileText({ ...worker, prompt: "An older prompt." }));
  writeFileSync(roleFilePath(dir, "dropped-role"), roleFileText({ ...worker, name: "dropped-role" }));
  const settings = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
  settings.hooks.Stop = [{ hooks: [{ type: "command", command: hookCommand(COMMAND, "session-end") }] }];
  writeFileSync(settingsPath(dir), JSON.stringify(settings, null, 2));
}

/** The files init writes, by path relative to the project. */
function wiredFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const agents = path.join(dir, ".claude", "agents");
  for (const name of readdirSync(agents).sort()) files[`.claude/agents/${name}`] = readFileSync(path.join(agents, name), "utf8");
  for (const file of [".claude/settings.local.json", ".mcp.json", ".gitignore", ".git/hooks/pre-push"]) files[file] = readFileSync(path.join(dir, file), "utf8");
  return files;
}

const refresh = (dir: string, version = B, program = "tmb") => refreshProject({ projectDir: dir, program: { name: program, version }, tmbCommand: COMMAND, adapters: HOST_ADAPTERS });
/** The refreshes the record holds: each a change of the program tie whose event names the refresh. */
const refreshes = (dir: string) =>
  withStore(dir, (store) => store.listSettingChanges("program").flatMap((change) => (store.history(change.id)[0]!.data.refresh ? [store.history(change.id)[0]!.data.refresh as Record<string, any>] : [])));

describe("refreshing a project's host files after an update", () => {
  test("a project wired by A, opened by B, ends with the files a fresh init by B writes, and one refresh in the record", () => {
    const old = newProject("old");
    wire(old, A);
    ageFiles(old);
    const fresh = newProject("fresh");
    wire(fresh, B);

    const line = refresh(old);
    expect(line).toContain(`tmb refreshed this project's host files from tmb ${A} to ${B}`);
    expect(line).toContain("takes effect from the next session");
    expect(wiredFiles(old)).toEqual(wiredFiles(fresh));
    expect(existsSync(roleFilePath(old, "dropped-role"))).toBe(false);

    const entries = refreshes(old);
    expect(entries).toHaveLength(1);
    const detail = entries[0]!;
    expect(detail).toMatchObject({ program: "tmb", from: A, to: B, hosts: ["claude-code"] });
    expect(detail.changed.join("\n")).toContain("dropped-role");
    expect(withStore(old, tiedProgram)).toEqual({ program: "tmb", version: B, command: COMMAND });
  });

  test("a move to another build keeps the tie in force, so the session start after it still rewires the hosts", () => {
    const old = newProject("old");
    wire(old, A);
    ageFiles(old);
    const fresh = newProject("fresh");
    wire(fresh, B);

    withStore(old, (store) => recordProgramMove(store, HUMAN, { program: "tmb", from: A, to: B }));
    const moved = withStore(old, (store) => store.listSettingChanges("program").at(-1)!);
    expect(moved.oldValue).toBe(moved.newValue);
    expect(withStore(old, tiedProgram)).toEqual({ program: "tmb", version: A, command: COMMAND });
    expect(withStore(old, (store) => store.history(moved.id)[0]!.data)).toMatchObject({ moved: { program: "tmb", from: A, to: B } });

    expect(refresh(old)).toContain(`tmb refreshed this project's host files from tmb ${A} to ${B}`);
    expect(wiredFiles(old)).toEqual(wiredFiles(fresh));
    expect(withStore(old, tiedProgram)).toEqual({ program: "tmb", version: B, command: COMMAND });
  });

  test("a second session start with B changes nothing and records nothing", () => {
    const dir = newProject("p");
    wire(dir, A);
    refresh(dir);
    const before = wiredFiles(dir);
    const audits = withStore(dir, (store) => store.listSettingChanges().length);

    expect(refresh(dir)).toBeNull();
    expect(wiredFiles(dir)).toEqual(before);
    expect(withStore(dir, (store) => store.listSettingChanges().length)).toBe(audits);
  });

  test("the Human's own entries in the host's settings stay as they were", () => {
    const dir = newProject("p");
    wire(dir, A);
    ageFiles(dir);
    refresh(dir);
    const settings = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] });
    expect(settings.hooks.Stop).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers.mine).toEqual({ command: "my-server" });
  });

  test("with a task open nothing is refreshed; after it closes, the next session start refreshes", () => {
    const dir = newProject("p");
    wire(dir, A);
    ageFiles(dir);
    const taskId = withStore(dir, (store) => {
      const issueId = store.createIssue(HUMAN, { title: "work" });
      return store.appendTask(PLANNER, { issueId, title: "a task", state: "open" });
    });
    const before = wiredFiles(dir);

    expect(refresh(dir)).toContain("at the first session start with no task open");
    expect(wiredFiles(dir)).toEqual(before);
    expect(refreshes(dir)).toHaveLength(0);

    withStore(dir, (store) => store.updateTask(PLANNER, taskId, { state: "closed" }));
    expect(refresh(dir)).toContain("tmb refreshed");
    expect(refreshes(dir)).toHaveLength(1);
  });

  test("a dropped task holds nothing back: it counts as ended for the refresh", () => {
    const dir = newProject("p");
    wire(dir, A);
    ageFiles(dir);
    withStore(dir, (store) => {
      const issueId = store.createIssue(HUMAN, { title: "work" });
      const taskId = store.appendTask(PLANNER, { issueId, title: "a task", state: "open" });
      store.updateTask(PLANNER, taskId, { state: "dropped", dropReason: "the approach is wrong" });
    });
    expect(refresh(dir)).toContain("tmb refreshed");
    expect(refreshes(dir)).toHaveLength(1);
  });

  test("a project wired by another program is left alone", () => {
    const dir = newProject("p");
    wire(dir, A, "tmb-dev");
    ageFiles(dir);
    const before = wiredFiles(dir);
    expect(refresh(dir)).toBeNull();
    expect(wiredFiles(dir)).toEqual(before);
    expect(withStore(dir, tiedProgram)?.program).toBe("tmb-dev");
  });

  test("an older program refreshes a project a newer one wired", () => {
    const dir = newProject("p");
    wire(dir, B);
    expect(refresh(dir, A)).toContain(`from tmb ${B} to ${A}`);
    expect(withStore(dir, tiedProgram)?.version).toBe(A);
  });

  test("a project with no record, or no tie, is not touched", () => {
    const bare = newProject("bare");
    expect(refresh(bare)).toBeNull();
    expect(existsSync(path.join(bare, ".tmb"))).toBe(false);
  });

  test("a failed refresh never throws: it says what failed and names tmb init, and records nothing", () => {
    const dir = newProject("p");
    wire(dir, A);
    writeFileSync(settingsPath(dir), "{ not json");
    const line = refresh(dir);
    expect(line).toContain(`tmb could not refresh this project's host files from tmb ${A} to ${B}`);
    expect(line).toContain("`tmb init`");
    expect(refreshes(dir)).toHaveLength(0);
    expect(withStore(dir, tiedProgram)?.version).toBe(A);
  });
});

describe("the session start says it in one line", () => {
  test("the planner is told to tell the Human; unattended, to name it in its answer", () => {
    const dir = newProject("p");
    wire(dir, A);
    const line = "tmb refreshed this project's host files from tmb 1.0.0 to 1.1.0: 2 changes, kept in the record.";
    const attended = handleEvent({ type: "session-start", projectDir: dir, unattended: false, refreshed: line }).context;
    expect(attended).toContain(`${HOST_FILES_HEADING}\n\n${line} Tell the Human in one line.`);
    const unattended = handleEvent({ type: "session-start", projectDir: dir, unattended: true, refreshed: line }).context;
    expect(unattended).toContain(`${line} Name it in your answer.`);
    expect(handleEvent({ type: "session-start", projectDir: dir, unattended: false }).context).not.toContain(HOST_FILES_HEADING);
  });

  test("the host's session-start hook runs the refresh for its project and passes the line on", () => {
    const dir = newProject("p");
    wire(dir, A);
    const seen: string[] = [];
    const output = answerHook("session-start", JSON.stringify({ cwd: dir }), {
      unattended: false,
      refresh: (projectDir) => {
        seen.push(projectDir);
        return refresh(projectDir);
      },
    });
    expect(seen).toEqual([dir]);
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(`${HOST_FILES_HEADING}\n\ntmb refreshed this project's host files from tmb ${A} to ${B}`);
  });
});

describe("init takes out what a version no longer wires", () => {
  test("Claude Code: a tmb hook under an event its kind no longer uses goes; the Human's hook there stays", () => {
    const dir = newProject("p");
    const settings = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    settings.hooks.Stop = [{ hooks: [{ type: "command", command: hookCommand(COMMAND, "session-end") }, { type: "command", command: "echo stop" }] }];
    writeFileSync(settingsPath(dir), JSON.stringify(settings));
    expect(install(dir, COMMAND).hooksRemoved).toEqual(["Stop"]);
    expect(JSON.parse(readFileSync(settingsPath(dir), "utf8")).hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo stop" }] }]);
    expect(install(dir, COMMAND).hooksRemoved).toEqual([]);
  });

  test("Codex: a tmb hook under an event no current hook uses goes", () => {
    const dir = newProject("p");
    mkdirSync(path.dirname(hooksJsonPath(dir)), { recursive: true });
    const stray = `${COMMAND.map((part) => `"${part}"`).join(" ")} hook session-end --host codex`;
    writeFileSync(hooksJsonPath(dir), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: stray }] }] } }));
    expect(installHooks(dir, COMMAND).hooksRemoved).toEqual(["Stop"]);
    expect(JSON.parse(readFileSync(hooksJsonPath(dir), "utf8")).hooks.Stop).toBeUndefined();
  });
});
