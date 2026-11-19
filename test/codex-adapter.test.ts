// The Codex adapter's own pieces: its config block, its hooks file, its agent files, the trust
// steps it reports, and how its tool calls become tmb events.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { roleFileText as claudeRoleFileText } from "../src/adapters/claude-code/role-files.ts";
import { registerServer, unregisterServer } from "../src/adapters/codex/config-toml.ts";
import { answerHook, patchFilesOf, shellCommandOf } from "../src/adapters/codex/hook.ts";
import { hookCommand, installHooks, isTmbHookCommand, removeHooks } from "../src/adapters/codex/hooks-json.ts";
import { configTomlPath, hooksJsonPath } from "../src/adapters/codex/paths.ts";
import { roleFileText, writeRoleFiles } from "../src/adapters/codex/role-files.ts";
import { isProjectTrusted, pendingSteps } from "../src/adapters/codex/trust.ts";
import { openProjectStore, SUBAGENT_ROLES, type SubagentRole, writeSetting } from "../src/engine/index.ts";
import type { GuardDecision } from "../src/engine/store/index.ts";

const TMB = ["/opt/tmb/bin/tmb"];
const ATTENDED = { unattended: false };

let project: string;
const savedCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-codex-"));
  process.env.CODEX_HOME = path.join(project, "codex-home");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

describe(".codex/config.toml", () => {
  test("adds the tool server in a marked block, and remove gives back the Human's file byte for byte", () => {
    for (const human of ['model = "gpt-5"\n', 'model = "gpt-5"', '[mcp_servers.mine]\ncommand = "x"\n\n']) {
      mkdirSync(path.dirname(configTomlPath(project)), { recursive: true });
      writeFileSync(configTomlPath(project), human);
      expect(registerServer(project, TMB).changed).toBe(true);
      const config = Bun.TOML.parse(readFileSync(configTomlPath(project), "utf8")) as { mcp_servers: Record<string, unknown> };
      expect(config.mcp_servers.tmb).toEqual({ command: TMB[0], args: ["mcp", "--host", "codex"] });
      expect(registerServer(project, TMB).changed).toBe(false);
      expect(unregisterServer(project)).toMatchObject({ removed: true, fileDeleted: false });
      expect(readFileSync(configTomlPath(project), "utf8")).toBe(human);
    }
  });

  test("a file tmb created is deleted on remove", () => {
    expect(registerServer(project, TMB)).toMatchObject({ created: true, changed: true });
    expect(unregisterServer(project)).toMatchObject({ removed: true, fileDeleted: true });
    expect(existsSync(path.join(project, ".codex"))).toBe(false);
  });

  test("refuses a tmb server it did not write, and a file that is not TOML", () => {
    mkdirSync(path.join(project, ".codex"));
    writeFileSync(configTomlPath(project), '[mcp_servers.tmb]\ncommand = "other"\n');
    expect(() => registerServer(project, TMB)).toThrow(/tmb did not write/);
    writeFileSync(configTomlPath(project), "this is = = not toml");
    expect(() => registerServer(project, TMB)).toThrow(/not valid TOML/);
  });
});

describe(".codex/hooks.json", () => {
  test("adds one group per event, keeps the Human's hooks, and is idempotent", () => {
    mkdirSync(path.join(project, ".codex"));
    const human = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] } };
    writeFileSync(hooksJsonPath(project), JSON.stringify(human, null, 2) + "\n");
    expect(installHooks(project, TMB).hooksAdded).toEqual(["SessionStart", "PreToolUse", "SubagentStop", "SessionEnd"]);
    const config = JSON.parse(readFileSync(hooksJsonPath(project), "utf8"));
    expect(config.hooks.PreToolUse).toEqual([...human.hooks.PreToolUse, { hooks: [{ type: "command", command: hookCommand(TMB, "pre-tool-use") }] }]);
    expect(installHooks(project, TMB).hooksAdded).toEqual([]);
    expect(removeHooks(project).hooksRemoved).toEqual(["PreToolUse", "SessionStart", "SubagentStop", "SessionEnd"]);
    expect(JSON.parse(readFileSync(hooksJsonPath(project), "utf8"))).toEqual(human);
  });

  test("replaces a tmb hook that points at another executable", () => {
    installHooks(project, ["/old/tmb"]);
    expect(installHooks(project, TMB).hooksAdded).toHaveLength(4);
    const commands = JSON.stringify(JSON.parse(readFileSync(hooksJsonPath(project), "utf8")));
    expect(commands).not.toContain("/old/tmb");
  });

  test("recognises its own hook commands, from a binary and from source, and no other", () => {
    expect(isTmbHookCommand(hookCommand(TMB, "session-end"))).toBe(true);
    expect(isTmbHookCommand(hookCommand(["/usr/bin/bun", "/src/tmb/src/cli.ts"], "pre-tool-use"), "pre-tool-use")).toBe(true);
    expect(isTmbHookCommand(`"/opt/tmb/bin/tmb" hook pre-tool-use`)).toBe(false);
    expect(isTmbHookCommand("guard.sh")).toBe(false);
  });
});

describe("agent files", () => {
  test("a role that runs no commands loses the shell, and the file is valid TOML", () => {
    const reviewer = SUBAGENT_ROLES.find((role) => role.name === "reviewer")!;
    const parsed = Bun.TOML.parse(roleFileText(reviewer)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ name: "reviewer", description: reviewer.description, developer_instructions: reviewer.prompt.trimEnd() });
    const worker = SUBAGENT_ROLES.find((role) => role.name === "worker")!;
    expect(Bun.TOML.parse(roleFileText(worker))).not.toHaveProperty("features");
  });

  test("a model the Human names, a local one included, reaches each host's role file", () => {
    const local: SubagentRole = { ...SUBAGENT_ROLES[0]!, model: "qwen3-coder:30b", effort: "high" };
    expect(Bun.TOML.parse(roleFileText(local))).toMatchObject({ model: "qwen3-coder:30b", model_reasoning_effort: "high" });
    expect(claudeRoleFileText(local)).toContain('model: "qwen3-coder:30b"');
  });

  test("never touches an agent file it did not write", () => {
    mkdirSync(path.join(project, ".codex", "agents"), { recursive: true });
    writeFileSync(path.join(project, ".codex", "agents", "worker.toml"), 'name = "worker"\n');
    expect(writeRoleFiles(project, SUBAGENT_ROLES).notOurs).toEqual(["worker"]);
  });
});

describe("trust", () => {
  test("asks the Human to trust the project until Codex's config says it is, and always to review tmb's hooks", () => {
    expect(isProjectTrusted(project)).toBe(false);
    expect(pendingSteps(project)).toHaveLength(2);
    mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    writeFileSync(path.join(process.env.CODEX_HOME!, "config.toml"), `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
    expect(isProjectTrusted(project)).toBe(true);
    expect(pendingSteps(project)).toEqual([expect.stringContaining("/hooks")]);
  });
});

describe("tool calls", () => {
  test("a shell call's command is its string, or the script of an argv that runs sh -c", () => {
    expect(shellCommandOf({ command: "git status" })).toBe("git status");
    expect(shellCommandOf({ command: ["bash", "-lc", "git push --no-verify"] })).toBe("git push --no-verify");
    expect(shellCommandOf({ command: ["git", "status"] })).toBe("git status");
    expect(shellCommandOf({})).toBe("");
  });

  test("a patch names every file it adds, updates, deletes or moves to", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Move to: src/b.ts\n*** Delete File: old.ts\n*** Add File: new.ts\n+x\n*** End Patch\n";
    expect(patchFilesOf({ command: patch })).toEqual(["src/a.ts", "src/b.ts", "old.ts", "new.ts"]);
    expect(patchFilesOf({ command: ["apply_patch", patch] })).toEqual(["src/a.ts", "src/b.ts", "old.ts", "new.ts"]);
    expect(patchFilesOf({ file_path: "x.ts" })).toEqual(["x.ts"]);
  });

  test("each file of a patch is guarded from the session's folder, in the host's role", () => {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.close();
    const input = {
      hook_event_name: "PreToolUse",
      cwd: project,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: notes.md\n+x\n*** Update File: src/a.ts\n@@\n+x\n*** End Patch\n" },
    };
    const decisions = (): GuardDecision[] => {
      const reopened = openProjectStore(project, { create: false });
      if (!reopened.ok) throw reopened.error;
      try {
        return reopened.store.listGuardDecisions();
      } finally {
        reopened.store.close();
      }
    };

    expect(answerHook("pre-tool-use", JSON.stringify(input), ATTENDED)).toBe("");
    expect(decisions().map((decision) => JSON.parse(decision.event).action)).toEqual([path.join(project, "notes.md"), path.join(project, "src/a.ts")]);
    expect(decisions().map((decision) => decision.createdBy)).toEqual([
      { kind: "agent", role: "planner", host: "codex" },
      { kind: "agent", role: "planner", host: "codex" },
    ]);

    const asReviewer = openProjectStore(project, { create: false });
    if (!asReviewer.ok) throw asReviewer.error;
    writeSetting(asReviewer.store, { kind: "human" }, "host_roles", { codex: "reviewer" });
    asReviewer.store.close();
    expect(JSON.parse(answerHook("pre-tool-use", JSON.stringify(input), ATTENDED)).hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("reviewer"),
    });
  });

  test("a spawn is a start of the agent type it names, and a subagent's stop is recorded", () => {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.close();
    expect(answerHook("pre-tool-use", JSON.stringify({ cwd: project, tool_name: "spawn_agent", tool_input: { agent_type: "reviewer", message: "Review." } }), ATTENDED)).toBe("");
    expect(answerHook("subagent-stop", JSON.stringify({ cwd: project, agent_id: "a1", agent_type: "reviewer" }), ATTENDED)).toBe("");
    const reopened = openProjectStore(project, { create: false });
    if (!reopened.ok) throw reopened.error;
    try {
      expect(reopened.store.listGuardDecisions().map((decision) => JSON.parse(decision.event))).toEqual([
        { type: "before-agent-start", role: "reviewer", action: "Review." },
        { type: "after-agent-stop", role: "reviewer", action: "reviewer" },
      ]);
    } finally {
      reopened.store.close();
    }
  });

  test("a tool tmb does not guard is answered with nothing, and bad input throws", () => {
    expect(answerHook("pre-tool-use", JSON.stringify({ cwd: project, tool_name: "mcp__tmb__issue_list", tool_input: {} }), ATTENDED)).toBe("");
    expect(() => answerHook("pre-tool-use", "{ not json", ATTENDED)).toThrow();
    expect(() => answerHook("no-such-hook", "{}", ATTENDED)).toThrow(/unknown hook event/);
  });
});
