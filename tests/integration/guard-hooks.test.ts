// Runs the PreToolUse hook setup wired, as its own process through a shell the way Claude
// Code runs it, in a set-up project: an allow prints nothing and a broken record denies.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openProjectStore } from "../../src/engine/index.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli.ts");

let scratch: string;
let env: Record<string, string>;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-guard-")));
  // Keep the machine's global git ignore rules out of the project under test.
  env = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
  };
  delete env.CLAUDE_PROJECT_DIR;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function setUpProject(): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  expect(spawnSync("git", ["init", "-q"], { cwd: project, env, timeout: 10_000 }).status).toBe(0);
  const setup = spawnSync(process.execPath, [CLI, "setup"], { cwd: project, env, encoding: "utf8", timeout: 30_000 });
  expect(setup.status).toBe(0);
  return project;
}

/** The PreToolUse hook command setup wrote into the project's settings. */
function preToolUseCommand(project: string): string {
  const settings = JSON.parse(readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"));
  const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
  expect(command).toEndWith(" hook pre-tool-use");
  return command;
}

function runPreToolUse(project: string, toolName: string, toolInput: Record<string, unknown>) {
  const input = JSON.stringify({ session_id: "guard", hook_event_name: "PreToolUse", cwd: project, tool_name: toolName, tool_input: toolInput });
  const result = spawnSync(preToolUseCommand(project), { shell: true, cwd: project, env, input, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("tmb hook pre-tool-use", () => {
  test("allows a Write and a Bash call with empty output, and records both", () => {
    const project = setUpProject();
    const file = path.join(project, "src", "a.ts");

    for (const [tool, input] of [
      ["Write", { file_path: file, content: "export {};\n" }],
      ["Bash", { command: "git status" }],
    ] as const) {
      const result = runPreToolUse(project, tool, input);
      expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
    }

    const opened = openProjectStore(project, { create: false });
    if (!opened.ok) throw opened.error;
    const recorded = opened.store.listGuardDecisions();
    opened.store.close();
    expect(recorded.map((decision) => [JSON.parse(decision.event), decision.decision, decision.createdBy])).toEqual([
      [{ type: "before-file-write", role: "planner", action: file }, "allow", { kind: "agent", role: "planner", host: "claude-code" }],
      [{ type: "before-command", role: "planner", action: "git status" }, "allow", { kind: "agent", role: "planner", host: "claude-code" }],
    ]);
  });

  test("denies a Write and a Bash call with the cause when the record cannot be read", () => {
    const project = setUpProject();
    const dbFile = path.join(project, ".tmb", "trajectory.db");
    for (const suffix of ["-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
    writeFileSync(dbFile, "this is not a database, only text long enough to look like a header");

    for (const [tool, input] of [
      ["Write", { file_path: path.join(project, "a.ts"), content: "" }],
      ["Bash", { command: "git push" }],
    ] as const) {
      const result = runPreToolUse(project, tool, input);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("cannot read the project's record");
    }
  });
});
