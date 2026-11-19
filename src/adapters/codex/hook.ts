// Codex's hooks, translated into tmb events and answered. Codex's hook input and output match
// Claude Code's in shape; its tools differ. Inside a subagent Codex names no agent on a tool
// call, so a tool call takes the role of the main agent unless the input names an agent type.
import path from "node:path";
import { type Decision, decide, handleEvent, MAIN_AGENT, projectRootOf, type TmbEvent, type TmbEventType } from "../../engine/index.ts";
import { isObject, type JsonObject } from "../common/json-file.ts";
import type { HookRun } from "../host-adapter.ts";
import type { HookName } from "./hooks-json.ts";
import { HOST_ID } from "./paths.ts";

/** The agent Codex starts when the spawn names no agent type. */
const DEFAULT_SUBAGENT = "default";

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

/** The command a shell call runs: a string, or an argv whose `sh -c` script is the command. */
export function shellCommandOf(toolInput: JsonObject): string {
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) return "";
  const argv = command as string[];
  const script = argv.findIndex((part) => /^-[a-z]*c$/.test(part));
  if (script > 0 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]!) && argv[script + 1] !== undefined) return argv[script + 1]!;
  return argv.join(" ");
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

function spawnOf(toolInput: JsonObject): { role: string; prompt: string } {
  const role = stringField(toolInput, "agent_type", "subagent_type", "agent", "name") ?? DEFAULT_SUBAGENT;
  const items = toolInput.items;
  const prompt = stringField(toolInput, "message", "prompt", "task") ?? (items === undefined ? "" : JSON.stringify(items));
  return { role, prompt };
}

function deny(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

function sessionStart(input: JsonObject, run: HookRun): string {
  const answer = handleEvent({ type: "session-start", projectDir: projectRootOf(cwdOf(input)), unattended: run.unattended, host: HOST_ID });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: answer.context } });
}

/** A deny becomes Codex's deny; an allow says nothing, so Codex's own approvals still apply. */
function preToolUse(input: JsonObject): string {
  const toolName = stringField(input, "tool_name") ?? "";
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  let decisions: Decision[];
  if (SHELL_TOOLS.has(toolName)) {
    decisions = [decide(eventOf(input, "before-command", shellCommandOf(toolInput)))];
  } else if (PATCH_TOOLS.has(toolName)) {
    // A patch names files from the session's folder; the engine reads a relative path from the project.
    const files = patchFilesOf(toolInput).map((file) => path.resolve(cwdOf(input), file));
    decisions = (files.length > 0 ? files : [""]).map((file) => decide(eventOf(input, "before-file-write", file)));
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
  decide(eventOf(input, "after-agent-stop", stringField(input, "agent_type") ?? ""));
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
