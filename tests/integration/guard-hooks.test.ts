// Runs the PreToolUse hook init wired, as its own process through a shell the way Claude
// Code runs it, in a set-up project: an allow prints nothing and a broken record denies,
// from the project folder or any subfolder of it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openProjectStore } from "../../src/engine/index.ts";
import { pathWithFakeClaude } from "./fake-host.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli", "index.ts");

let scratch: string;
let env: Record<string, string>;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-guard-")));
  // Keep the machine's global git ignore rules out of the project under test.
  env = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    PATH: pathWithFakeClaude(scratch),
  };
  delete env.CLAUDE_PROJECT_DIR;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function setUpProject(): string {
  const project = mkdtempSync(path.join(scratch, "project-"));
  expect(spawnSync("git", ["init", "-q"], { cwd: project, env, timeout: 10_000 }).status).toBe(0);
  for (const command of [["init"], ["onboard", "--yes"]]) {
    const result = spawnSync(process.execPath, [CLI, ...command], { cwd: project, env, encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(0);
  }
  return project;
}

/** The PreToolUse hook command init wrote into the project's settings. */
function preToolUseCommand(project: string): string {
  const settings = JSON.parse(readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"));
  const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
  expect(command).toEndWith(" hook pre-tool-use");
  return command;
}

/** Runs the hook from `cwd`, the folder the session has moved to; Claude Code's project dir is set when given. */
function runPreToolUse(
  project: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  where: { cwd?: string; claudeProjectDir?: string } = {},
) {
  const cwd = where.cwd ?? project;
  const input = JSON.stringify({ session_id: "guard", hook_event_name: "PreToolUse", cwd, tool_name: toolName, tool_input: toolInput });
  const hookEnv = where.claudeProjectDir === undefined ? env : { ...env, CLAUDE_PROJECT_DIR: where.claudeProjectDir };
  const result = spawnSync(preToolUseCommand(project), { shell: true, cwd, env: hookEnv, input, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function breakRecord(project: string): void {
  const dbFile = path.join(project, ".tmb", "trajectory.db");
  for (const suffix of ["-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  writeFileSync(dbFile, "this is not a database, only text long enough to look like a header");
}

function expectDeny(result: ReturnType<typeof runPreToolUse>): void {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout);
  expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  expect(output.hookSpecificOutput.permissionDecisionReason).toContain("cannot read the project's record");
}

describe("tmb hook pre-tool-use", () => {
  test("allows a Write and a Bash call with empty output, and records the write: tmb reads no shell command, not even a push that skips git's hook", () => {
    const project = setUpProject();
    const file = path.join(project, "src", "a.ts");

    for (const [tool, input] of [
      ["Write", { file_path: file, content: "export {};\n" }],
      ["Bash", { command: "git push --no-verify origin main" }],
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
    ]);
  });

  test("denies a Write with the cause when the record cannot be read, and leaves a Bash call alone", () => {
    const project = setUpProject();
    breakRecord(project);

    for (const [tool, input] of [
      ["Write", { file_path: path.join(project, "a.ts"), content: "" }],
    ] as const) {
      expectDeny(runPreToolUse(project, tool, input));
    }
    expect(runPreToolUse(project, "Bash", { command: "git push" })).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  test("finds the record from a subfolder the session moved into", () => {
    const project = setUpProject();
    const sub = path.join(project, "src", "deep");
    mkdirSync(sub, { recursive: true });

    expect(runPreToolUse(project, "Write", { file_path: "a.ts", content: "" }, { cwd: sub })).toEqual({ status: 0, stdout: "", stderr: "" });
    const opened = openProjectStore(project, { create: false });
    if (!opened.ok) throw opened.error;
    const recorded = opened.store.listGuardDecisions();
    opened.store.close();
    expect(recorded.map((decision) => JSON.parse(decision.event))).toEqual([{ type: "before-file-write", role: "planner", action: "a.ts" }]);

    breakRecord(project);
    expectDeny(runPreToolUse(project, "Write", { file_path: "a.ts", content: "" }, { cwd: sub }));
    expectDeny(runPreToolUse(project, "Write", { file_path: "a.ts", content: "" }, { cwd: sub, claudeProjectDir: project }));
  });
});
