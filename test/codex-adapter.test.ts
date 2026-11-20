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
import { openProjectStore, SUBAGENT_ROLES, type SubagentRole, UNNAMED_AGENT, writeSetting } from "../src/engine/index.ts";
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

  test("a file whose line endings turned CRLF after init still gives up its block, and init runs again", () => {
    mkdirSync(path.dirname(configTomlPath(project)), { recursive: true });
    writeFileSync(configTomlPath(project), 'model = "gpt-5"\n');
    registerServer(project, TMB);
    writeFileSync(configTomlPath(project), readFileSync(configTomlPath(project), "utf8").replace(/\n/g, "\r\n"));
    expect(unregisterServer(project).removed).toBe(true);
    expect(readFileSync(configTomlPath(project), "utf8")).toBe('model = "gpt-5"\r\n');
    expect(registerServer(project, TMB).changed).toBe(true);
    expect(readFileSync(configTomlPath(project), "utf8")).not.toMatch(/[^\r]\n/);
    expect(unregisterServer(project).removed).toBe(true);
    expect(readFileSync(configTomlPath(project), "utf8")).toBe('model = "gpt-5"\r\n');
  });

  test("finds the block an earlier build marked as written by tmb setup, and replaces or removes it", () => {
    mkdirSync(path.dirname(configTomlPath(project)), { recursive: true });
    writeFileSync(configTomlPath(project), 'model = "gpt-5"\n');
    registerServer(project, TMB);
    const earlier = readFileSync(configTomlPath(project), "utf8").replace("written by tmb init and deleted by tmb remove; tmb init replaces", "written by tmb setup and deleted by tmb remove; tmb setup replaces");
    expect(earlier).toContain("tmb setup");
    writeFileSync(configTomlPath(project), earlier);
    expect(registerServer(project, TMB).changed).toBe(true);
    expect(readFileSync(configTomlPath(project), "utf8")).not.toContain("tmb setup");
    writeFileSync(configTomlPath(project), earlier);
    expect(unregisterServer(project).removed).toBe(true);
    expect(readFileSync(configTomlPath(project), "utf8")).toBe('model = "gpt-5"\n');
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

  test("remove gives back the Human's own file byte for byte, its layout and empty entries included", () => {
    const humans = [
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "done.sh" }] }] } }, null, 4),
      '{"hooks": {}, "x": 1}',
      '{"hooks":{"SessionStart":[]}}\n',
      "",
    ];
    for (const human of humans) {
      mkdirSync(path.join(project, ".codex"), { recursive: true });
      writeFileSync(hooksJsonPath(project), human);
      installHooks(project, TMB);
      installHooks(project, TMB);
      expect(removeHooks(project).fileDeleted).toBe(false);
      expect(readFileSync(hooksJsonPath(project), "utf8")).toBe(human);
    }
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

  test("apply_patch run through the shell, or sent as bare text, is guarded as a write of each file", () => {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    writeSetting(opened.store, { kind: "human" }, "host_roles", { codex: "reviewer" });
    opened.store.close();
    const patch = "*** Begin Patch\n*** Add File: notes.md\n+x\n*** End Patch\n";
    for (const call of [
      { tool_name: "Bash", tool_input: { command: ["apply_patch", patch] } },
      { tool_name: "Bash", tool_input: { command: ["bash", "-lc", `apply_patch <<'EOF'\n${patch}EOF`] } },
      { tool_name: "apply_patch", tool_input: patch },
    ]) {
      const answer = answerHook("pre-tool-use", JSON.stringify({ cwd: project, ...call }), ATTENDED);
      expect(JSON.parse(answer).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  test("a subagent's stop that names no agent ends no run", () => {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    writeSetting(opened.store, { kind: "human" }, "host_roles", { codex: "reviewer" });
    opened.store.close();
    answerHook("session-start", JSON.stringify({ cwd: project }), ATTENDED);
    expect(answerHook("subagent-stop", JSON.stringify({ cwd: project, agent_id: "a1" }), ATTENDED)).toBe("");
    const reopened = openProjectStore(project, { create: false });
    if (!reopened.ok) throw reopened.error;
    try {
      expect(reopened.store.openRuns("reviewer")).toHaveLength(1);
    } finally {
      reopened.store.close();
    }
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

  test("a spawn whose agent tmb cannot read goes through, and its decision says so as a finding", () => {
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.close();
    expect(answerHook("pre-tool-use", JSON.stringify({ cwd: project, tool_name: "spawn_agent", tool_input: { unknown_field: "x" } }), ATTENDED)).toBe("");
    const reopened = openProjectStore(project, { create: false });
    if (!reopened.ok) throw reopened.error;
    try {
      const [decision] = reopened.store.listGuardDecisions();
      expect(JSON.parse(decision!.event)).toMatchObject({ type: "before-agent-start", role: UNNAMED_AGENT });
      expect(decision!.reason).toContain("finding: the host did not say which agent is starting");
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
