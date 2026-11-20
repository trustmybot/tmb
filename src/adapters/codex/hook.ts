// Codex's hooks, translated into tmb events and answered. Codex's hook input and output match
// Claude Code's in shape; its tools differ. Inside a subagent Codex names no agent on a tool
// call, so a tool call takes the role of the main agent unless the input names an agent type.
import path from "node:path";
import { type Decision, decide, handleEvent, MAIN_AGENT, projectRootOf, type TmbEvent, type TmbEventType, UNNAMED_AGENT } from "../../engine/index.ts";
import { isObject, type JsonObject } from "../common/json-file.ts";
import type { HookRun } from "../host-adapter.ts";
import type { HookName } from "./hooks-json.ts";
import { HOST_ID } from "./paths.ts";

const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec_command"]);
const PATCH_TOOLS = new Set(["apply_patch", "Edit", "Write"]);
const SPAWN_TOOLS = new Set(["spawn_agent", "Agent"]);

function stringField(object: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** Codex gives no project dir; tmb looks up from the session's folder to the one holding its record. */
function cwdOf(input: JsonObject): string {
  return stringField(input, "cwd") ?? process.cwd();
}

function roleOf(input: JsonObject): string {
  return stringField(input, "agent_type") ?? MAIN_AGENT;
}

function eventOf(input: JsonObject, type: TmbEventType, action: string, role: string = roleOf(input)): TmbEvent {
  return { type, projectDir: projectRootOf(cwdOf(input)), host: HOST_ID, role, action };
}

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/** Every file an apply_patch call writes, adds, deletes or moves to, as given; or a file_path field. */
export function patchFilesOf(toolInput: JsonObject): string[] {
  const direct = stringField(toolInput, "file_path", "path");
  if (direct) return [direct];
  const texts = [toolInput.command, toolInput.input, toolInput.patch].flatMap((value) =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [],
  );
  const files = texts.flatMap((text) => [...text.matchAll(PATCH_FILE)].map((match) => match[1]!.trim()));
  return [...new Set(files)];
}

/** A shell call's command text: Codex gives it as a string, or as argv such as ["bash", "-lc", "<command>"]. */
export function shellTextOf(toolInput: JsonObject): string {
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const words = command.filter((part): part is string => typeof part === "string");
  return words.map((word) => (/[\s'"]/.test(word) ? `'${word.replace(/'/g, "'\\''")}'` : word)).join(" ");
}

function spawnOf(toolInput: JsonObject): { role: string; prompt: string } {
  const role = stringField(toolInput, "agent_type", "subagent_type", "agent", "name") ?? UNNAMED_AGENT;
  const items = toolInput.items;
  const prompt = stringField(toolInput, "message", "prompt", "task") ?? (items === undefined ? "" : JSON.stringify(items));
  return { role, prompt };
}

function deny(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

function sessionStart(input: JsonObject, run: HookRun): string {
  const projectDir = projectRootOf(cwdOf(input));
  const refreshed = run.refresh?.(projectDir) ?? null;
  const answer = handleEvent({ type: "session-start", projectDir, unattended: run.unattended, host: HOST_ID, feedback: run.feedback, refreshed, doctor: run.doctor });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: answer.context } });
}

/** A deny becomes Codex's deny; an allow says nothing, so Codex's own approvals still apply. */
function preToolUse(input: JsonObject): string {
  const toolName = stringField(input, "tool_name") ?? "";
  // apply_patch is a freeform tool, so its input may come as the patch text itself.
  const toolInput = isObject(input.tool_input) ? input.tool_input : typeof input.tool_input === "string" ? { command: input.tool_input } : {};
  // A patch names files from the session's folder; the engine reads a relative path from the project.
  const writes = (files: string[]) => files.map((file) => decide(eventOf(input, "before-file-write", path.resolve(cwdOf(input), file))));
  let decisions: Decision[];
  if (SHELL_TOOLS.has(toolName)) {
    // tmb reads a shell command for a step only the Human may take (trustmybot/tmb#179); Codex
    // also runs apply_patch through the shell, and each file the patch names is a write.
    const { file_path: _file, path: _path, ...shellInput } = toolInput;
    decisions = [decide(eventOf(input, "before-shell-command", shellTextOf(shellInput))), ...writes(patchFilesOf(shellInput))];
  } else if (PATCH_TOOLS.has(toolName)) {
    const files = patchFilesOf(toolInput);
    decisions = files.length > 0 ? writes(files) : [decide(eventOf(input, "before-file-write", ""))];
  } else if (SPAWN_TOOLS.has(toolName)) {
    const spawn = spawnOf(toolInput);
    decisions = [decide(eventOf(input, "before-agent-start", spawn.prompt, spawn.role))];
  } else {
    return "";
  }
  const denied = decisions.find((decision) => decision.decision === "deny");
  return denied ? deny(denied.reason ?? "tmb refused the tool call") : "";
}

/** Codex takes no answer tmb needs to give to a subagent's stop; the engine records it. */
function subagentStop(input: JsonObject): string {
  const agentType = stringField(input, "agent_type");
  // A stop that names no agent cannot be matched to a run; read as the main agent's, it would end the host's own.
  if (agentType === undefined) return "";
  decide(eventOf(input, "after-agent-stop", agentType));
  return "";
}

function sessionEnd(input: JsonObject): string {
  handleEvent({ type: "session-end", projectDir: projectRootOf(cwdOf(input)), host: HOST_ID });
  return "";
}

const ANSWERS: Record<HookName, (input: JsonObject, run: HookRun) => string> = {
  "session-start": sessionStart,
  "pre-tool-use": preToolUse,
  "subagent-stop": subagentStop,
  "session-end": sessionEnd,
};

/** Codex's hook input in, Codex's hook output out; empty when there is nothing to say. Throws on bad input. */
export function answerHook(event: string, stdinText: string, run: HookRun): string {
  const answer = Object.hasOwn(ANSWERS, event) ? ANSWERS[event as HookName] : undefined;
  if (!answer) throw new Error(`unknown hook event '${event}'`);
  const input: unknown = stdinText.trim() === "" ? {} : JSON.parse(stdinText);
  return answer(isObject(input) ? input : {}, run);
}
