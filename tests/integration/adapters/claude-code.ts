// Claude Code for the shared adapter tests: hooks in .claude/settings.local.json, the tool
// server in .mcp.json, JSON on stdin and hookSpecificOutput on stdout.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adapter } from "../../../src/adapters/claude-code/index.ts";
import { isTmbHookCommand } from "../../../src/adapters/claude-code/settings.ts";
import { fakeClaudeFolder } from "../../lib/fake-host.ts";
import type { ContractEvent, HostHarness } from "./harness.ts";

const SETTINGS = path.join(".claude", "settings.local.json");

type Settings = { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** The tmb commands setup wired for the Claude Code hook event, in order. */
function wiredCommands(project: string, hookEvent: string): string[] {
  const settings = readJson<Settings>(path.join(project, SETTINGS));
  const commands = (settings.hooks?.[hookEvent] ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command));
  const wired = commands.filter((candidate): candidate is string => typeof candidate === "string" && isTmbHookCommand(candidate));
  if (wired.length === 0) throw new Error(`setup wired no tmb hook for ${hookEvent}`);
  return wired;
}

/** One shell command that runs each tmb hook wired for the event on the same input, as Claude Code runs them all; each prints its answer on a line of its own. */
function wiredCommand(project: string, hookEvent: string): string {
  const commands = wiredCommands(project, hookEvent);
  if (commands.length === 1) return commands[0]!;
  return `input=$(cat); ${commands.map((command) => `printf '%s' "$input" | ${command}`).join("; ")}`;
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
      case "before-shell-command":
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
      case "agent-start-failed":
        return {
          command: wiredCommand(project, "PostToolUseFailure"),
          input: input(project, "PostToolUseFailure", {
            tool_name: "Agent",
            tool_input: { subagent_type: event.role, prompt: event.prompt },
            error: "Cannot create agent worktree: not in a git repository",
            is_interrupt: false,
          }),
          env,
        };
      case "after-agent-stop":
        return { command: wiredCommand(project, "SubagentStop"), input: input(project, "SubagentStop", { agent_type: event.role }), env };
      case "worker-in-folder":
        // Inside a worker, Claude Code gives the worker's own folder as cwd and keeps CLAUDE_PROJECT_DIR at the main folder.
        return {
          command: wiredCommand(project, "PreToolUse"),
          input: input(project, "PreToolUse", { ...agentType("worker"), cwd: event.folder, tool_name: "mcp__tmb__task_brief", tool_input: { id: event.task, role: "worker" } }),
          env,
        };
    }
  },

  readAnswer(_event, stdout) {
    // Several hooks on one event answer a line each; Claude Code gives the model every text.
    const outputs = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line).hookSpecificOutput ?? {}) as { permissionDecision?: unknown; permissionDecisionReason?: unknown; additionalContext?: unknown });
    const denied = outputs.find((output) => output.permissionDecision === "deny");
    const contexts = outputs.map((output) => output.additionalContext).filter((context): context is string => typeof context === "string");
    return { deny: denied === undefined ? null : String(denied.permissionDecisionReason), context: contexts.length === 0 ? null : contexts.join("\n\n") };
  },

  toolServer(project) {
    const entry = readJson<{ mcpServers: Record<string, { command: string; args: string[] }> }>(path.join(project, ".mcp.json")).mcpServers.tmb!;
    return { command: entry.command, args: entry.args };
  },
};
