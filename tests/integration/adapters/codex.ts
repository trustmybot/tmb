// Codex for the shared adapter tests: hooks in .codex/hooks.json, the tool server in
// .codex/config.toml, JSON on stdin and hookSpecificOutput on stdout. Codex sets no project
// variable; it runs a hook in the session's folder.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adapter } from "../../../src/adapters/codex/index.ts";
import { isTmbHookCommand } from "../../../src/adapters/codex/hooks-json.ts";
import type { ContractEvent, HostHarness } from "./harness.ts";

const HOOKS = path.join(".codex", "hooks.json");
const CONFIG = path.join(".codex", "config.toml");

type Hooks = { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> };

/** The tmb command setup wired for the Codex hook event. */
function wiredCommand(project: string, hookEvent: string): string {
  const config = JSON.parse(readFileSync(path.join(project, HOOKS), "utf8")) as Hooks;
  const commands = (config.hooks?.[hookEvent] ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command));
  const command = commands.find((candidate) => isTmbHookCommand(candidate));
  if (typeof command !== "string") throw new Error(`setup wired no tmb hook for ${hookEvent}`);
  return command;
}

function input(project: string, hookEvent: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ session_id: "contract", transcript_path: null, cwd: project, hook_event_name: hookEvent, model: "gpt-5", ...fields });
}

function preToolUse(project: string, toolName: string, toolInput: Record<string, unknown>) {
  return { command: wiredCommand(project, "PreToolUse"), input: input(project, "PreToolUse", { turn_id: "t1", tool_use_id: "c1", tool_name: toolName, tool_input: toolInput }) };
}

export const codexHarness: HostHarness = {
  adapter,

  fakeHost(dir) {
    const folder = path.join(dir, "fake-codex");
    mkdirSync(folder, { recursive: true });
    const program = path.join(folder, "codex");
    writeFileSync(program, `#!/bin/sh\n[ "$1" = "--version" ] || exit 9\necho 'codex-cli 0.170.0'\n`);
    chmodSync(program, 0o755);
    return folder;
  },

  seedHumanFiles(project) {
    mkdirSync(path.join(project, ".codex", "agents"), { recursive: true });
    writeFileSync(path.join(project, CONFIG), `model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "my-server"\n`);
    writeFileSync(path.join(project, HOOKS), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2) + "\n");
    writeFileSync(path.join(project, ".codex", "agents", "mine.toml"), `name = "mine"\ndescription = "The Human's own agent"\ndeveloper_instructions = "Help me."\n`);
  },

  hookCall(project, event: ContractEvent) {
    switch (event.type) {
      case "session-start":
        return { command: wiredCommand(project, "SessionStart"), input: input(project, "SessionStart", { source: "startup" }) };
      case "session-end":
        return { command: wiredCommand(project, "SessionEnd"), input: input(project, "SessionEnd", { reason: "other" }) };
      case "before-file-write":
        // Codex names no agent on a tool call (namesAgentOnToolCall is false): a subagent's call looks like the main agent's.
        return preToolUse(project, "apply_patch", { command: `*** Begin Patch\n*** Add File: ${event.file}\n+x\n*** End Patch\n` });
      case "before-shell-command":
        return preToolUse(project, "Bash", { command: event.command });
      case "before-agent-start":
        return preToolUse(project, "spawn_agent", { agent_type: event.role, message: event.prompt });
      case "after-agent-stop":
        return {
          command: wiredCommand(project, "SubagentStop"),
          input: input(project, "SubagentStop", { turn_id: "t1", agent_id: "a1", agent_type: event.role, stop_hook_active: false }),
        };
      case "agent-start-failed":
        // tmb wires no Codex hook for a failed spawn: a Codex start makes no worktree to fail on.
        return null;
      case "worker-in-folder":
        // A Codex worker has no worktree of its host's making, so tmb has no folder to adopt.
        return null;
    }
  },

  readAnswer(_event, stdout) {
    if (stdout.trim() === "") return { deny: null, context: null };
    const output = JSON.parse(stdout).hookSpecificOutput ?? {};
    return {
      deny: output.permissionDecision === "deny" ? String(output.permissionDecisionReason) : null,
      context: typeof output.additionalContext === "string" ? output.additionalContext : null,
    };
  },

  toolServer(project) {
    const config = Bun.TOML.parse(readFileSync(path.join(project, CONFIG), "utf8")) as { mcp_servers: Record<string, { command: string; args: string[] }> };
    const entry = config.mcp_servers.tmb!;
    return { command: entry.command, args: entry.args };
  },
};
