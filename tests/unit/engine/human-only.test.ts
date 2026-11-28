// Steps only the Human may take (trustmybot/tmb#179): which commands they are, how the guard finds
// one in an agent's shell command, and that the guard denies it and records the deny.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decide, openProjectStore, projectDbPath, type TmbEvent } from "../../../src/engine/index.ts";
import { humanOnlyInShell, humanOnlyStep } from "../../../src/engine/human-only.ts";
import { answerHook as codexHook, shellTextOf } from "../../../src/adapters/codex/hook.ts";
import { adapter } from "../../../src/adapters/claude-code/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

describe("humanOnlyStep", () => {
  test("both waivers, setting the review mode and tmb remove are the Human's; tmb update and the rest are not", () => {
    expect(humanOnlyStep(["feature", "waive", "feat/a", "--reason", "x"])?.command).toBe("tmb feature waive");
    expect(humanOnlyStep(["task", "waive", "T-1", "--reason", "x"])?.command).toBe("tmb task waive");
    expect(humanOnlyStep(["onboard", "--review-mode", "agile", "--yes"])?.command).toBe("tmb onboard --review-mode");
    expect(humanOnlyStep(["onboard", "--review-mode=truest"])?.command).toBe("tmb onboard --review-mode");
    expect(humanOnlyStep(["remove"])?.command).toBe("tmb remove");
    expect(humanOnlyStep(["remove", "--host", "codex"])?.command).toBe("tmb remove");
    for (const args of [["update"], ["onboard", "--yes"], ["onboard", "--base", "main"], ["task", "close", "T-1"], ["feature", "pr", "feat/a"], ["init"], []]) {
      expect(humanOnlyStep(args)).toBeNull();
    }
  });
});

describe("humanOnlyInShell", () => {
  test("finds a Human-only step however the program is reached", () => {
    for (const command of [
      "tmb task waive T-1 --reason 'looks fine'",
      "tmb-dev feature waive feat/a --reason x",
      "/Users/someone/.local/bin/tmb-0.1.0-dev.3 remove",
      "cd /repo && tmb onboard --review-mode agile --yes",
      "TMB_UNATTENDED=1 tmb onboard --review-mode=truest --yes",
      "env TMB_UNATTENDED=1 tmb onboard --review-mode truest",
      "true; tmb remove --host codex",
      "echo y | tmb task waive T-2 --reason r",
      "bash -lc 'tmb task waive T-3 --reason r'",
      'sh -c "tmb feature waive feat/b --reason r"',
      "eval tmb remove",
      "script -q /dev/null tmb task waive T-4 --reason r",
      "x=$(tmb remove)",
      "C:\\tools\\tmb.exe remove",
    ]) {
      expect({ command, step: humanOnlyInShell(command) !== null }).toEqual({ command, step: true });
    }
  });

  test("leaves text that only names a step alone, and every other tmb command", () => {
    for (const command of [
      "tmb task close T-1",
      "tmb update",
      "tmb onboard --yes --base main",
      'git commit -m "tmb remove now asks for yes"',
      "gh issue create --title 'tmb task waive needs a terminal'",
      "git commit -F - <<'EOF'\ntmb remove asks for yes\ntmb task waive T-1 too\nEOF",
      "grep -rn 'tmb feature waive' docs",
      "ls",
      "",
    ]) {
      expect({ command, step: humanOnlyInShell(command) }).toEqual({ command, step: null });
    }
  });
});

describe("the host's guard on an agent's shell command", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), "tmb-human-only-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  const shell = (action: string, fields: Partial<TmbEvent> = {}): TmbEvent => ({ type: "before-shell-command", projectDir: project, host: "claude-code", role: "planner", action, ...fields });

  function createRecord(): void {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.close();
  }

  function guardDecisions() {
    const opened = openProjectStore(project, { create: false });
    if (!opened.ok) throw opened.error;
    try {
      return opened.store.listGuardDecisions();
    } finally {
      opened.store.close();
    }
  }

  test("denies a Human-only step with the reason, whatever the role, and records the deny", () => {
    createRecord();
    for (const role of ["planner", "worker", "reviewer", "main-agent"]) {
      const answer = decide(shell("tmb task waive T-1 --reason r", { role }));
      expect(answer.decision).toBe("deny");
      expect(answer.reason).toContain("tmb task waive is a step only the Human may take");
      expect(answer.reason).toContain("Ask the Human to run it in their own terminal");
    }
    const recorded = guardDecisions();
    expect(recorded).toHaveLength(4);
    expect(recorded.every((row) => row.decision === "deny" && row.createdBy.kind === "agent")).toBe(true);
  });

  test("allows any other shell command and records nothing; with no record it still denies a Human-only step", () => {
    createRecord();
    expect(decide(shell("bun test"))).toEqual({ decision: "allow" });
    expect(decide(shell("tmb task close T-1"))).toEqual({ decision: "allow" });
    expect(guardDecisions()).toHaveLength(0);
    rmSync(path.dirname(projectDbPath(project)), { recursive: true, force: true });
    expect(decide(shell("tmb remove")).decision).toBe("deny");
    expect(existsSync(path.dirname(projectDbPath(project)))).toBe(false);
  });

  test("Claude Code's Bash call is denied through its hook", () => {
    const input = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name: "Bash", tool_input: { command } });
    const denied = JSON.parse(adapter.answerHook("pre-tool-use", input("tmb feature waive feat/a --reason r"), { unattended: false }));
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("tmb feature waive");
    expect(adapter.answerHook("pre-tool-use", input("git status"), { unattended: false })).toBe("");
  });

  test("Codex's shell call is denied through its hook, given as a string or as argv", () => {
    const input = (toolInput: Record<string, unknown>) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: project, tool_name: "shell", tool_input: toolInput });
    for (const toolInput of [{ command: ["bash", "-lc", "tmb remove"] }, { command: "tmb onboard --review-mode agile --yes" }, { cmd: "tmb task waive T-1 --reason r" }, { command: ["tmb", "remove"] }]) {
      const out = codexHook("pre-tool-use", input(toolInput), { unattended: false });
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
    }
    expect(codexHook("pre-tool-use", input({ command: ["bash", "-lc", "ls"] }), { unattended: false })).toBe("");
  });

  test("shellTextOf keeps an argv word with spaces as one word", () => {
    expect(shellTextOf({ command: ["git", "commit", "-m", "tmb remove asks"] })).toBe("git commit -m 'tmb remove asks'");
    expect(humanOnlyInShell(shellTextOf({ command: ["git", "commit", "-m", "tmb remove asks"] }))).toBeNull();
  });
});
