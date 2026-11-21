import { decide, handleEvent, MAIN_AGENT, projectRootOf, type TmbEvent, type TmbEventType } from "../../engine/index.ts";
import type { HookRun } from "../host-adapter.ts";
import { isObject, type JsonObject } from "../common/json-file.ts";
import { HOST_ID } from "./mcp-json.ts";
import { usageOfTranscriptFile } from "./usage.ts";
import { type HookName, TASK_NAMING_TOOLS } from "./settings.ts";

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
  Agent: { type: "before-agent-start", actionField: "prompt", roleField: "subagent_type" },
  Task: { type: "before-agent-start", actionField: "prompt", roleField: "subagent_type" },
  Bash: { type: "before-shell-command", actionField: "command" },
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

/** Inside a subagent Claude Code names its agent type; the main agent takes the host's role in the record. */
function roleOf(input: JsonObject): string {
  return stringField(input, "agent_type") ?? MAIN_AGENT;
}

function eventOf(input: JsonObject, type: TmbEventType, action: string, role: string = roleOf(input)): TmbEvent {
  return { type, projectDir: projectDirOf(input), host: HOST_ID, role, action };
}

function sessionStart(input: JsonObject, run: HookRun): string {
  const projectDir = projectDirOf(input);
  const refreshed = run.refresh?.(projectDir) ?? null;
  const answer = handleEvent({ type: "session-start", projectDir, unattended: run.unattended, host: HOST_ID, feedback: run.feedback, refreshed, doctor: run.doctor });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: answer.context } });
}

/**
 * A worker naming its task with one of tmb's tools: inside a worker Claude Code gives the folder
 * it works in as the input's cwd, which is the worktree Claude Code made for it. The engine adopts
 * that worktree as the task's; the call itself always goes on.
 */
function workerInFolder(input: JsonObject, toolInput: JsonObject): string {
  const folder = stringField(input, "cwd");
  const task = stringField(toolInput, "id");
  if (roleOf(input) !== "worker" || folder === undefined || task === undefined) return "";
  decide({ ...eventOf(input, "worker-in-folder", folder), task: task.toUpperCase() });
  return "";
}

/** A deny becomes Claude Code's deny; an allow says nothing, so Claude Code's own permission prompts still apply. */
function preToolUse(input: JsonObject): string {
  const toolName = stringField(input, "tool_name");
  if (toolName !== undefined && (TASK_NAMING_TOOLS as readonly string[]).includes(toolName)) {
    return workerInFolder(input, isObject(input.tool_input) ? input.tool_input : {});
  }
  const tool = toolName === undefined ? undefined : TOOL_EVENTS[toolName];
  if (!tool) return "";
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const role = tool.roleField === undefined ? roleOf(input) : (stringField(toolInput, tool.roleField) ?? DEFAULT_SUBAGENT);
  const event = eventOf(input, tool.type, stringField(toolInput, tool.actionField) ?? "", role);
  // Claude Code cuts a worker's own worktree from the folder the session is in (trustmybot/tmb#285).
  const folder = stringField(input, "cwd");
  if (tool.type === "before-agent-start" && folder !== undefined) event.startFolder = folder;
  const answer = decide(event);
  if (answer.decision === "allow") return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer.reason },
  });
}

/**
 * An Agent call that failed after the gate allowed it, such as a worktree Claude Code could not
 * make (trustmybot/tmb#285): no subagent ran, so no stop will come, and the engine ends the run
 * the start opened. Claude Code takes no answer.
 */
function postToolUseFailure(input: JsonObject): string {
  const toolName = stringField(input, "tool_name");
  const tool = toolName === undefined ? undefined : TOOL_EVENTS[toolName];
  if (tool?.type !== "before-agent-start" || tool.roleField === undefined) return "";
  // A call the user stopped may have started its subagent, whose stop then ends the run.
  if (input.is_interrupt === true) return "";
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const role = stringField(toolInput, tool.roleField) ?? DEFAULT_SUBAGENT;
  decide(eventOf(input, "agent-start-failed", stringField(toolInput, tool.actionField) ?? "", role));
  return "";
}

/** Claude Code takes no answer to a subagent's stop; the engine records it. */
function subagentStop(input: JsonObject): string {
  const agentType = stringField(input, "agent_type");
  // A stop that names no agent cannot be matched to a run; read as the main agent's, it would end the host's own.
  if (agentType === undefined) return "";
  // The subagent's own transcript holds its usage; the input's transcript_path is the main session's.
  decide({ ...eventOf(input, "after-agent-stop", agentType), cost: usageOfTranscriptFile(stringField(input, "agent_transcript_path")) });
  return "";
}

/** Claude Code takes no answer to a session's end; a reviewer host's run without a verdict ends with it. */
function sessionEnd(input: JsonObject): string {
  handleEvent({ type: "session-end", projectDir: projectDirOf(input), host: HOST_ID });
  return "";
}

const ANSWERS: Record<HookName, (input: JsonObject, run: HookRun) => string> = {
  "session-start": sessionStart,
  "pre-tool-use": preToolUse,
  "post-tool-use-failure": postToolUseFailure,
  "subagent-stop": subagentStop,
  "session-end": sessionEnd,
};

/**
 * Turns Claude Code's hook input into the engine's event and the engine's answer into
 * Claude Code's hook output; `run` is what the command line read about the run. Returns the
 * stdout text, empty when there is nothing to say, or throws on bad input.
 */
export function answerHook(event: string, stdinText: string, run: HookRun): string {
  const answer = Object.hasOwn(ANSWERS, event) ? ANSWERS[event as HookName] : undefined;
  if (!answer) throw new Error(`unknown hook event '${event}'`);
  const input: unknown = stdinText.trim() === "" ? {} : JSON.parse(stdinText);
  return answer(isObject(input) ? input : {}, run);
}
