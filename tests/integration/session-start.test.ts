// Drives the tmb CLI as a separate process, the way Claude Code and the Human do.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UNATTENDED_INSTRUCTION } from "../../src/engine/index.ts";
import { pathWithFakeClaude } from "./fake-host.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "src", "cli.ts");
const PLANNER_ROLE = readFileSync(path.join(ROOT, "roles", "planner.md"), "utf8");

let scratch: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-integration-")));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(command: string, args: string[], cwd: string, input?: string, extraEnv: Record<string, string> = {}) {
  // Keep the machine's global git ignore rules, and any unattended mode it runs in, out of the project under test.
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    PATH: pathWithFakeClaude(scratch),
  };
  delete env.TMB_UNATTENDED;
  const result = spawnSync(command, args, { cwd, input, encoding: "utf8", timeout: 30_000, env: { ...env, ...extraEnv } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The body of a `## heading` section in roles/planner.md, up to the next heading. */
function plannerSection(heading: string): string {
  const start = PLANNER_ROLE.indexOf(`## ${heading}\n`);
  if (start === -1) throw new Error(`roles/planner.md has no '## ${heading}' section`);
  const body = PLANNER_ROLE.slice(start + heading.length + 4);
  const end = body.search(/^#{1,6} /m);
  return (end === -1 ? body : body.slice(0, end)).trim();
}

describe("tmb hook session-start", () => {
  test("answers a SessionStart event with the planner role", () => {
    const event = JSON.stringify({ session_id: "integration", hook_event_name: "SessionStart", source: "startup", cwd: ROOT });
    const result = run(process.execPath, [CLI, "hook", "session-start"], ROOT, event);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const context = output.hookSpecificOutput.additionalContext;
    expect(context).toMatch(/^# You are bro\b/m);
    const groundTruthRule = plannerSection("Docs are ground truth");
    expect(groundTruthRule.length).toBeGreaterThan(0);
    expect(context).toContain(groundTruthRule);
  });

  test("ends with the unattended instruction only when TMB_UNATTENDED is 1", () => {
    const event = JSON.stringify({ session_id: "integration", hook_event_name: "SessionStart", source: "startup", cwd: ROOT });
    const contextWith = (extraEnv: Record<string, string>) => {
      const result = run(process.execPath, [CLI, "hook", "session-start"], ROOT, event, extraEnv);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      return (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    };

    const attended = contextWith({});
    expect(attended).not.toContain(UNATTENDED_INSTRUCTION);
    expect(contextWith({ TMB_UNATTENDED: "1" })).toBe(`${attended.trimEnd()}\n\n${UNATTENDED_INSTRUCTION}\n`);
    expect(contextWith({ TMB_UNATTENDED: "0" })).toBe(attended);
    expect(contextWith({ TMB_UNATTENDED: "" })).toBe(attended);
    for (const value of ["true", "yes", " 1", "1 "]) expect(contextWith({ TMB_UNATTENDED: value })).toBe(attended);
  });
});

describe("tmb setup and remove", () => {
  test("add then take away the hook in a git project, keeping other settings", () => {
    const project = mkdtempSync(path.join(scratch, "project-"));
    expect(run("git", ["init", "-q"], project).status).toBe(0);
    const settingsFile = path.join(project, ".claude", "settings.local.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    const otherHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] };
    const original = { permissions: { allow: ["Bash(ls:*)"] }, hooks: { PreToolUse: [otherHook] } };
    writeFileSync(settingsFile, JSON.stringify(original, null, 2) + "\n");
    const readSettings = () => JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, any>;

    // From source, setup wires Bun running src/cli.ts, and remove must recognise that hook.
    const setup = run(process.execPath, [CLI, "setup"], project);
    expect(setup.status).toBe(0);
    const afterSetup = readSettings();
    expect(afterSetup.permissions).toEqual(original.permissions);
    const hookCommand = (name: string) => `"${process.execPath}" "${CLI}" hook ${name}`;
    expect(afterSetup.hooks.PreToolUse).toEqual([
      otherHook,
      { matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash|Agent|Task", hooks: [{ type: "command", command: hookCommand("pre-tool-use") }] },
    ]);
    expect(afterSetup.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: hookCommand("session-start") }] }]);
    expect(afterSetup.hooks.SubagentStop).toEqual([{ hooks: [{ type: "command", command: hookCommand("subagent-stop") }] }]);

    const remove = run(process.execPath, [CLI, "remove"], project);
    expect(remove.status).toBe(0);
    expect(existsSync(settingsFile)).toBe(true);
    expect(readSettings()).toEqual(original);
  });
});
