// Claude Code's PreToolUse and SubagentStop hooks, translated into tmb events and answered.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerHook } from "../src/adapters/claude-code/hook.ts";
import { openProjectStore, projectDbPath } from "../src/engine/index.ts";
import type { GuardDecision } from "../src/engine/store/index.ts";

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-hook-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function createRecord(): void {
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  opened.store.close();
}

function guardDecisions(): GuardDecision[] {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return opened.store.listGuardDecisions();
  } finally {
    opened.store.close();
  }
}

function preToolUse(toolName: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return answerHook(
    "pre-tool-use",
    JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name: toolName, tool_input: toolInput, ...extra }),
  );
}

describe("hook pre-tool-use", () => {
  test("translates each guarded tool into its tmb event and action, allowing with no output", () => {
    createRecord();
    const calls: [string, Record<string, unknown>, string, string][] = [
      ["Write", { file_path: "/p/a.ts", content: "x" }, "before-file-write", "/p/a.ts"],
      ["Edit", { file_path: "/p/b.ts", old_string: "a", new_string: "b" }, "before-file-write", "/p/b.ts"],
      ["MultiEdit", { file_path: "/p/c.ts", edits: [] }, "before-file-write", "/p/c.ts"],
      ["NotebookEdit", { notebook_path: "/p/d.ipynb", new_source: "" }, "before-file-write", "/p/d.ipynb"],
      ["Bash", { command: "git push" }, "before-command", "git push"],
      ["Agent", { subagent_type: "worker", prompt: "go" }, "before-agent-start", "worker"],
      ["Task", { subagent_type: "reviewer", prompt: "go" }, "before-agent-start", "reviewer"],
    ];
    for (const [tool, input] of calls) expect(preToolUse(tool, input)).toBe("");

    const recorded = guardDecisions().map((decision) => JSON.parse(decision.event));
    expect(recorded).toEqual(calls.map(([, , type, action]) => ({ type, role: "planner", action })));
  });

  test("takes the role from agent_type inside a subagent, and records under it and the host", () => {
    createRecord();
    expect(preToolUse("Bash", { command: "bun test" }, { agent_id: "a1", agent_type: "worker" })).toBe("");
    const [recorded] = guardDecisions();
    expect(recorded!.createdBy).toEqual({ kind: "agent", role: "worker", host: "claude-code" });
    expect(JSON.parse(recorded!.event)).toEqual({ type: "before-command", role: "worker", action: "bun test" });
  });

  test("answers nothing and records nothing for a tool it does not guard", () => {
    createRecord();
    expect(preToolUse("Read", { file_path: "/p/a.ts" })).toBe("");
    expect(preToolUse("Writer", { file_path: "/p/a.ts" })).toBe("");
    expect(guardDecisions()).toHaveLength(0);
  });

  test("allows with no output and records nothing when the project has no record", () => {
    expect(preToolUse("Write", { file_path: "/p/a.ts" })).toBe("");
  });

  test("denies in Claude Code's form, with a reason naming the cause, when the record cannot be read", () => {
    mkdirSync(path.dirname(projectDbPath(project)), { recursive: true });
    writeFileSync(projectDbPath(project), "this is not a database, only text long enough to look like a header");
    const output = JSON.parse(preToolUse("Write", { file_path: "/p/a.ts" }));
    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.any(String) },
    });
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("cannot read the project's record");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("trajectory.db");
  });

  test("still throws on input that is not JSON", () => {
    expect(() => answerHook("pre-tool-use", "{ not json")).toThrow();
  });
});

describe("hook subagent-stop", () => {
  test("records an after-agent-stop under the stopped agent's role and answers nothing", () => {
    createRecord();
    const input = { hook_event_name: "SubagentStop", cwd: project, agent_id: "a1", agent_type: "reviewer", stop_hook_active: false };
    expect(answerHook("subagent-stop", JSON.stringify(input))).toBe("");
    const [recorded] = guardDecisions();
    expect(recorded!.createdBy).toEqual({ kind: "agent", role: "reviewer", host: "claude-code" });
    expect(JSON.parse(recorded!.event)).toEqual({ type: "after-agent-stop", role: "reviewer", action: "reviewer" });
  });

  test("answers nothing even when the record cannot be read", () => {
    mkdirSync(path.dirname(projectDbPath(project)), { recursive: true });
    writeFileSync(projectDbPath(project), "this is not a database, only text long enough to look like a header");
    expect(answerHook("subagent-stop", JSON.stringify({ cwd: project }))).toBe("");
  });
});
