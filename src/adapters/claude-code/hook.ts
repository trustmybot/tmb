import { decide, handleEvent, projectRootOf, type TmbEvent, type TmbEventType, UNATTENDED_VARIABLE } from "../../engine/index.ts";
import { isObject, type JsonObject } from "./json-file.ts";
import { HOST_ID } from "./mcp-json.ts";
import type { HookName } from "./settings.ts";

const MAIN_AGENT_ROLE = "planner";

/** The subagent Claude Code starts when the call names no subagent_type. */
const DEFAULT_SUBAGENT = "general-purpose";

/**
 * Each guarded tool: the tmb event its call raises, the tool input field that names the
 * action and, for a subagent start, the field that names the role of the agent starting.
 */
const TOOL_EVENTS: Record<string, { type: TmbEventType; actionField: string; roleField?: string }> = {
  Write: { type: "before-file-write", actionField: "file_path" },
  Edit: { type: "before-file-write", actionField: "file_path" },
  MultiEdit: { type: "before-file-write", actionField: "file_path" },
  NotebookEdit: { type: "before-file-write", actionField: "notebook_path" },
  Bash: { type: "before-command", actionField: "command" },
  Agent: { type: "before-agent-start", actionField: "prompt", roleField: "subagent_type" },
  Task: { type: "before-agent-start", actionField: "prompt", roleField: "subagent_type" },
};

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The project the session runs in. Claude Code's project dir comes first because the input's
 * cwd follows the session into subfolders; from there tmb looks up to the folder holding its record.
 */
function projectDirOf(input: JsonObject): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const start = projectDir && projectDir.trim() !== "" ? projectDir : (stringField(input, "cwd") ?? process.cwd());
  return projectRootOf(start);
}

/** Inside a subagent Claude Code names its agent type; the main agent is the planner. */
function roleOf(input: JsonObject): string {
  return stringField(input, "agent_type") ?? MAIN_AGENT_ROLE;
}

function eventOf(input: JsonObject, type: TmbEventType, action: string, role: string = roleOf(input)): TmbEvent {
  return { type, projectDir: projectDirOf(input), host: HOST_ID, role, action };
}

function sessionStart(input: JsonObject): string {
  const answer = handleEvent({ type: "session-start", projectDir: projectDirOf(input), unattended: process.env[UNATTENDED_VARIABLE] });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: answer.context } });
}

/** A deny becomes Claude Code's deny; an allow says nothing, so Claude Code's own permission prompts still apply. */
function preToolUse(input: JsonObject): string {
  const toolName = stringField(input, "tool_name");
  const tool = toolName === undefined ? undefined : TOOL_EVENTS[toolName];
  if (!tool) return "";
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const role = tool.roleField === undefined ? roleOf(input) : (stringField(toolInput, tool.roleField) ?? DEFAULT_SUBAGENT);
  const answer = decide(eventOf(input, tool.type, stringField(toolInput, tool.actionField) ?? "", role));
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
