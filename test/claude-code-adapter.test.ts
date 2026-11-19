import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerHook } from "../src/adapters/claude-code/hook.ts";
import { hookCommand, install, remove, settingsPath } from "../src/adapters/claude-code/settings.ts";
import { plannerRole } from "../src/engine/index.ts";

const EXE = path.join(tmpdir(), "tmb bin", "tmb");

let project: string;
const savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-test-"));
  // Keep the machine's global git ignore rules out of the .gitignore tests.
  process.env.XDG_CONFIG_HOME = path.join(project, ".no-xdg");
  process.env.GIT_CONFIG_GLOBAL = path.join(project, ".no-gitconfig");
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

const tmbEntry = { hooks: [{ type: "command", command: hookCommand(EXE) }] };

describe("setup", () => {
  test("on a fresh project creates the settings file with one SessionStart hook", () => {
    const result = install(project, EXE);
    expect(result.settingsChanged).toBe(true);
    expect(readJson(settingsPath(project))).toEqual({ hooks: { SessionStart: [tmbEntry] } });
    expect(hookCommand(EXE)).toBe(`"${EXE}" hook session-start`);
  });

  test("merges into an existing file, keeping other keys and hooks", () => {
    const prior = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      },
    };
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsPath(project), JSON.stringify(prior));

    install(project, EXE);

    expect(readJson(settingsPath(project))).toEqual({
      permissions: prior.permissions,
      hooks: { SessionStart: [...prior.hooks.SessionStart, tmbEntry], PreToolUse: prior.hooks.PreToolUse },
    });
  });

  test("is idempotent", () => {
    install(project, EXE);
    const first = readFileSync(settingsPath(project), "utf8");
    const second = install(project, EXE);
    expect(second.settingsChanged).toBe(false);
    expect(readFileSync(settingsPath(project), "utf8")).toBe(first);
  });

  test("replaces a tmb hook that points at another executable", () => {
    install(project, path.join(project, "old", "tmb"));
    install(project, EXE);
    expect(readJson(settingsPath(project))).toEqual({ hooks: { SessionStart: [tmbEntry] } });
  });

  test("quotes a Windows executable path", () => {
    const winExe = "C:\\Users\\Jo Doe\\AppData\\Local\\tmb\\bin\\tmb.exe";
    install(project, winExe);
    expect(readJson(settingsPath(project))).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `"${winExe}" hook session-start` }] }] },
    });
    expect(remove(project).settingsChanged).toBe(true);
  });

  test("refuses to overwrite a settings file that is not valid JSON", () => {
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsPath(project), "{ not json");
    expect(() => install(project, EXE)).toThrow();
    expect(readFileSync(settingsPath(project), "utf8")).toBe("{ not json");
  });
});

describe(".gitignore", () => {
  test("appends the settings file in a git work tree that does not ignore it", () => {
    gitInit(project);
    writeFileSync(path.join(project, ".gitignore"), "node_modules/");
    expect(install(project, EXE).gitignoreChanged).toBe(true);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("node_modules/\n.claude/settings.local.json\n");

    expect(install(project, EXE).gitignoreChanged).toBe(false);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("node_modules/\n.claude/settings.local.json\n");
  });

  test("leaves .gitignore alone when the file is already ignored", () => {
    gitInit(project);
    writeFileSync(path.join(project, ".gitignore"), "*.local.json\n");
    expect(install(project, EXE).gitignoreChanged).toBe(false);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toBe("*.local.json\n");
  });

  test("creates nothing outside a git work tree", () => {
    expect(install(project, EXE).gitignoreChanged).toBe(false);
    expect(existsSync(path.join(project, ".gitignore"))).toBe(false);
  });
});

describe("remove", () => {
  test("restores the prior content of an existing file", () => {
    const prior = {
      model: "x",
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }] },
    };
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsPath(project), JSON.stringify(prior));

    install(project, EXE);
    expect(remove(project).settingsChanged).toBe(true);
    expect(readJson(settingsPath(project))).toEqual(prior);
  });

  test("drops the containers it emptied and keeps other keys", () => {
    mkdirSync(path.join(project, ".claude"));
    writeFileSync(settingsPath(project), JSON.stringify({ permissions: { allow: [] } }));
    install(project, EXE);
    remove(project);
    expect(readJson(settingsPath(project))).toEqual({ permissions: { allow: [] } });
  });

  test("deletes the file it created on a fresh project", () => {
    install(project, EXE);
    expect(remove(project).fileDeleted).toBe(true);
    expect(existsSync(path.join(project, ".claude"))).toBe(false);
  });

  test("changes nothing when no tmb hook is present", () => {
    mkdirSync(path.join(project, ".claude"));
    const text = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: '"/bin/other" hook session-start' }] }] } });
    writeFileSync(settingsPath(project), text);
    expect(remove(project).settingsChanged).toBe(false);
    expect(readFileSync(settingsPath(project), "utf8")).toBe(text);
  });
});

describe("hook session-start", () => {
  const expected = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: plannerRole } };

  test("answers with the planner role as additionalContext", () => {
    const output = JSON.parse(answerHook("session-start", JSON.stringify({ hook_event_name: "SessionStart", source: "startup" })));
    expect(output).toEqual(expected);
    expect(output.hookSpecificOutput.additionalContext).toStartWith("# You are bro, the planner");
  });

  test("tolerates empty stdin", () => {
    expect(JSON.parse(answerHook("session-start", ""))).toEqual(expected);
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
    const result = runHook(["session-start"], "{}");
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
