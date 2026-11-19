import { decide, handleEvent, type TmbEvent, type TmbEventType } from "../../engine/index.ts";
import { isObject, type JsonObject } from "./json-file.ts";
import { HOST_ID } from "./mcp-json.ts";
import type { HookName } from "./settings.ts";

const MAIN_AGENT_ROLE = "planner";

/** Each guarded tool: the tmb event its call raises, and the tool input field that names the action. */
const TOOL_EVENTS: Record<string, { type: TmbEventType; actionField: string }> = {
  Write: { type: "before-file-write", actionField: "file_path" },
  Edit: { type: "before-file-write", actionField: "file_path" },
  MultiEdit: { type: "before-file-write", actionField: "file_path" },
  NotebookEdit: { type: "before-file-write", actionField: "notebook_path" },
  Bash: { type: "before-command", actionField: "command" },
  Agent: { type: "before-agent-start", actionField: "subagent_type" },
  Task: { type: "before-agent-start", actionField: "subagent_type" },
};

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The project the session runs in: the hook input's cwd, else Claude Code's project dir, else this process's cwd. */
function projectDirOf(input: JsonObject): string {
  const cwd = stringField(input, "cwd");
  if (cwd) return cwd;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  return projectDir && projectDir.trim() !== "" ? projectDir : process.cwd();
}

/** Inside a subagent Claude Code names its agent type; the main agent is the planner. */
function roleOf(input: JsonObject): string {
  return stringField(input, "agent_type") ?? MAIN_AGENT_ROLE;
}

function eventOf(input: JsonObject, type: TmbEventType, action: string): TmbEvent {
  return { type, projectDir: projectDirOf(input), host: HOST_ID, role: roleOf(input), action };
}

function sessionStart(input: JsonObject): string {
  const answer = handleEvent({ type: "session-start", projectDir: projectDirOf(input) });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: answer.context } });
}

/** A deny becomes Claude Code's deny; an allow says nothing, so Claude Code's own permission prompts still apply. */
function preToolUse(input: JsonObject): string {
  const toolName = stringField(input, "tool_name");
  const tool = toolName === undefined ? undefined : TOOL_EVENTS[toolName];
  if (!tool) return "";
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const answer = decide(eventOf(input, tool.type, stringField(toolInput, tool.actionField) ?? ""));
  if (answer.decision === "allow") return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer.reason },
  });
}

/** Claude Code takes no answer to a subagent's stop; the engine records it. */
function subagentStop(input: JsonObject): string {
  decide(eventOf(input, "after-agent-stop", stringField(input, "agent_type") ?? ""));
  return "";
}

const ANSWERS: Record<HookName, (input: JsonObject) => string> = {
  "session-start": sessionStart,
  "pre-tool-use": preToolUse,
  "subagent-stop": subagentStop,
};

/**
 * Turns Claude Code's hook input into the engine's event and the engine's answer into
 * Claude Code's hook output. Returns the stdout text, empty when there is nothing to say,
 * or throws on bad input.
 */
export function answerHook(event: string, stdinText: string): string {
  const answer = Object.hasOwn(ANSWERS, event) ? ANSWERS[event as HookName] : undefined;
  if (!answer) throw new Error(`unknown hook event '${event}'`);
  const input: unknown = stdinText.trim() === "" ? {} : JSON.parse(stdinText);
  return answer(isObject(input) ? input : {});
}
