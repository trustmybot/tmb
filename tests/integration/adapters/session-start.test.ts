// Drives the tmb CLI as a separate process, the way Claude Code and the Human do.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UNATTENDED_INSTRUCTION } from "../../../src/engine/index.ts";
import { pathWithFakeClaude } from "../../lib/fake-host.ts";
import { asHuman } from "../../lib/as-human.ts";
import { REPO_ROOT } from "../../lib/paths.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ROOT = REPO_ROOT;
const CLI = path.join(ROOT, "src", "cli", "index.ts");
const PLANNER_ROLE = readFileSync(path.join(ROOT, "roles", "planner.md"), "utf8");

let scratch: string;
// The folder the session-start hook runs in: an empty temp folder, never the checkout. A hook run in
// the checkout walks up to any record above it, such as a workspace's, and would open and migrate it.
let away: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-integration-")));
  away = path.join(scratch, "away");
  mkdirSync(away);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The environment each command runs in: the machine's global git ignore rules, and any unattended mode it runs in, stay out of the project under test. */
function testEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    PATH: pathWithFakeClaude(scratch),
  };
  delete env.TMB_UNATTENDED;
  return env;
}

function run(command: string, args: string[], cwd: string, input?: string, extraEnv: Record<string, string> = {}) {
  const env = testEnv();
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
    const event = JSON.stringify({ session_id: "integration", hook_event_name: "SessionStart", source: "startup", cwd: away });
    const result = run(process.execPath, [CLI, "hook", "session-start"], away, event);
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

  test("starts with the unattended instruction only when TMB_UNATTENDED is 1", () => {
    const event = JSON.stringify({ session_id: "integration", hook_event_name: "SessionStart", source: "startup", cwd: away });
    const contextWith = (extraEnv: Record<string, string>) => {
      const result = run(process.execPath, [CLI, "hook", "session-start"], away, event, extraEnv);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      return (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    };

    const attended = contextWith({});
    expect(attended).not.toContain(UNATTENDED_INSTRUCTION);
    expect(contextWith({ TMB_UNATTENDED: "1" })).toBe(`${UNATTENDED_INSTRUCTION}\n\n${attended}`);
    expect(contextWith({ TMB_UNATTENDED: "0" })).toBe(attended);
    expect(contextWith({ TMB_UNATTENDED: "" })).toBe(attended);
    for (const value of ["true", "yes", " 1", "1 "]) expect(contextWith({ TMB_UNATTENDED: value })).toBe(attended);
  });
});

describe("tmb init and remove", () => {
  test("add then take away the hook in a git project, keeping other settings", () => {
    const project = mkdtempSync(path.join(scratch, "project-"));
    expect(run("git", ["init", "-q"], project).status).toBe(0);
    const settingsFile = path.join(project, ".claude", "settings.local.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    const otherHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] };
    const original = { permissions: { allow: ["Bash(ls:*)"] }, hooks: { PreToolUse: [otherHook] } };
    writeFileSync(settingsFile, JSON.stringify(original, null, 2) + "\n");
    const readSettings = () => JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, any>;

    // From source, init wires Bun running src/cli/index.ts, and remove must recognise that hook.
    const init = run(process.execPath, [CLI, "init"], project);
    expect(init.status).toBe(0);
    const afterInit = readSettings();
    expect(afterInit.permissions).toEqual(original.permissions);
    const hookCommand = (name: string) => `"${process.execPath}" "${CLI}" hook ${name}`;
    expect(afterInit.hooks.PreToolUse).toEqual([
      otherHook,
      { matcher: "Agent|Task|Bash|mcp__tmb__task_brief|mcp__tmb__task_close", hooks: [{ type: "command", command: hookCommand("pre-tool-use") }] },
    ]);
    expect(afterInit.hooks.SessionStart).toEqual([hookCommand("session-start-role"), hookCommand("session-start")].map((command) => ({ hooks: [{ type: "command", command }] })));
    expect(afterInit.hooks.PostToolUseFailure).toEqual([{ matcher: "Agent|Task", hooks: [{ type: "command", command: hookCommand("post-tool-use-failure") }] }]);
    expect(afterInit.hooks.SubagentStop).toEqual([{ hooks: [{ type: "command", command: hookCommand("subagent-stop") }] }]);
    expect(afterInit.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: hookCommand("session-end") }] }]);

    const remove = asHuman(process.execPath, [CLI, "remove", path.basename(project)], { cwd: project, env: testEnv() });
    expect(remove.status).toBe(0);
    expect(existsSync(settingsFile)).toBe(true);
    expect(readSettings()).toEqual(original);
  });
});
