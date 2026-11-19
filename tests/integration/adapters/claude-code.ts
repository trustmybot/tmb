// Claude Code for the shared adapter tests: hooks in .claude/settings.local.json, the tool
// server in .mcp.json, JSON on stdin and hookSpecificOutput on stdout.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adapter } from "../../../src/adapters/claude-code/index.ts";
import { isTmbHookCommand } from "../../../src/adapters/claude-code/settings.ts";
import { fakeClaudeFolder } from "../fake-host.ts";
import type { ContractEvent, HostHarness } from "./harness.ts";

const SETTINGS = path.join(".claude", "settings.local.json");

type Settings = { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** The tmb command setup wired for the Claude Code hook event. */
function wiredCommand(project: string, hookEvent: string): string {
  const settings = readJson<Settings>(path.join(project, SETTINGS));
  const commands = (settings.hooks?.[hookEvent] ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command));
  const command = commands.find((candidate) => isTmbHookCommand(candidate));
  if (typeof command !== "string") throw new Error(`setup wired no tmb hook for ${hookEvent}`);
  return command;
}

/** Claude Code names the agent type inside a subagent and nothing in the main agent's session. */
function agentType(role: string): Record<string, string> {
  return role === "planner" ? {} : { agent_type: role };
}

function input(project: string, hookEvent: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ session_id: "contract", hook_event_name: hookEvent, cwd: project, ...fields });
}

export const claudeCodeHarness: HostHarness = {
  adapter,
  namesSubagentOnToolCall: true,

  fakeHost: fakeClaudeFolder,

  seedHumanFiles(project) {
    mkdirSync(path.join(project, ".claude", "agents"), { recursive: true });
    writeFileSync(
      path.join(project, SETTINGS),
      JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2) + "\n",
    );
    writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "my-server" } } }, null, 2) + "\n");
    writeFileSync(path.join(project, ".claude", "agents", "mine.md"), "---\nname: mine\ndescription: The Human's own agent\n---\n\nHelp me.\n");
  },

  hookCall(project, event: ContractEvent) {
    const env = { CLAUDE_PROJECT_DIR: project };
    switch (event.type) {
      case "session-start":
        return { command: wiredCommand(project, "SessionStart"), input: input(project, "SessionStart", { source: "startup" }), env };
      case "session-end":
        return { command: wiredCommand(project, "SessionEnd"), input: input(project, "SessionEnd", { reason: "exit" }), env };
      case "before-file-write":
        return {
          command: wiredCommand(project, "PreToolUse"),
          input: input(project, "PreToolUse", { ...agentType(event.role), tool_name: "Write", tool_input: { file_path: event.file, content: "x" } }),
          env,
        };
      case "before-command":
        return {
          command: wiredCommand(project, "PreToolUse"),
          input: input(project, "PreToolUse", { ...agentType(event.role), tool_name: "Bash", tool_input: { command: event.command } }),
          env,
        };
      case "before-agent-start":
        return {
          command: wiredCommand(project, "PreToolUse"),
          input: input(project, "PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: event.role, prompt: event.prompt } }),
          env,
        };
      case "after-agent-stop":
        return { command: wiredCommand(project, "SubagentStop"), input: input(project, "SubagentStop", { agent_type: event.role }), env };
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
    const entry = readJson<{ mcpServers: Record<string, { command: string; args: string[] }> }>(path.join(project, ".mcp.json")).mcpServers.tmb!;
    return { command: entry.command, args: entry.args };
  },
};
