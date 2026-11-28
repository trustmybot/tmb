// Claude Code's hooks in, the engine's events out; the engine's answers back as Claude Code's hook output.
import { decide, handleEvent, MAIN_AGENT, type ModelUsage, projectRootOf, type TmbEvent, type TmbEventType } from "../../engine/index.ts";
import type { HookRun } from "../host-adapter.ts";
import { isObject, type JsonObject } from "../common/json-file.ts";
import { DEFAULT_SUBAGENT, HOST_ID, SESSION_TEXT_BUDGET } from "./host.ts";
import { type HookName, type SettingsFile, TASK_NAMING_TOOLS } from "./settings.ts";

/**
 * Each guarded tool: the tmb event its call raises, the tool input field that names the
 * action and, for a subagent start, the field that names the role of the agent starting.
 */
const TOOL_EVENTS: Readonly<Record<string, { readonly type: TmbEventType; readonly actionField: string; readonly roleField?: string }>> = {
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

/** Inside a subagent Claude Code names its agent type; the main agent takes the host's role in the record. */
function roleOf(input: JsonObject): string {
  return stringField(input, "agent_type") ?? MAIN_AGENT;
}

function eventOf(input: JsonObject, type: TmbEventType, action: string, role: string = roleOf(input)): TmbEvent {
  return { type, projectDir: projectDirOf(input), host: HOST_ID, role, action };
}

/** Claude Code's answer adding one text to the session at `hookEventName`; empty when there is no text. */
function addedText(context: string, hookEventName = "SessionStart"): string {
  return context === "" ? "" : JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } });
}

/** Reads the tokens a subagent's transcript holds, or null when it cannot. */
export type UsageReader = (transcriptFile: string | undefined) => ModelUsage[] | null;

/** Translates each Claude Code hook tmb wires; one instance per adapter. */
export class HookTranslator {
  private readonly answers: Readonly<Record<HookName, (input: JsonObject, run: HookRun) => string>> = {
    "session-start-role": (input) => this.sessionStartRole(input),
    "session-start": (input, run) => this.sessionStart(input, run),
    "pre-tool-use": (input) => this.preToolUse(input),
    "post-tool-use-failure": (input) => this.postToolUseFailure(input),
    "subagent-stop": (input) => this.subagentStop(input),
    "user-prompt-submit": (input) => this.userPromptSubmit(input),
    "session-end": (input) => this.sessionEnd(input),
  };

  constructor(
    private readonly settings: SettingsFile,
    private readonly readUsage: UsageReader,
  ) {}

  /**
   * The project's state, fitted to its budget. Settings an older tmb wired have no role hook yet:
   * the role then comes in this text too, until the refresh below wires it for the next session.
   */
  private sessionStart(input: JsonObject, run: HookRun): string {
    const projectDir = projectDirOf(input);
    const withRole = !this.settings.wiresHook(projectDir, "session-start-role");
    const refreshed = run.refresh?.(projectDir) ?? null;
    const texts = { withRole, budget: SESSION_TEXT_BUDGET };
    const answer = handleEvent({ type: "session-start", projectDir, unattended: run.unattended, host: HOST_ID, feedback: run.feedback, refreshed, doctor: run.doctor, texts });
    return addedText(answer.context);
  }

  /** The role, its own text. Claude Code runs it beside the state's hook, so it only reads. */
  private sessionStartRole(input: JsonObject): string {
    return addedText(handleEvent({ type: "session-role", projectDir: projectDirOf(input), host: HOST_ID }).context);
  }

  /**
   * A worker naming its task with one of tmb's tools: inside a worker Claude Code gives the folder
   * it works in as the input's cwd, which is the worktree Claude Code made for it. The engine adopts
   * that worktree as the task's; the call itself always goes on.
   */
  private workerInFolder(input: JsonObject, toolInput: JsonObject): string {
    const folder = stringField(input, "cwd");
    const task = stringField(toolInput, "id");
    if (roleOf(input) !== "worker" || folder === undefined || task === undefined) return "";
    decide({ ...eventOf(input, "worker-in-folder", folder), task: task.toUpperCase() });
    return "";
  }

  /** A deny becomes Claude Code's deny; an allow says nothing, so Claude Code's own permission prompts still apply. */
  private preToolUse(input: JsonObject): string {
    const toolName = stringField(input, "tool_name");
    if (toolName !== undefined && (TASK_NAMING_TOOLS as readonly string[]).includes(toolName)) {
      return this.workerInFolder(input, isObject(input.tool_input) ? input.tool_input : {});
    }
    const tool = toolName === undefined ? undefined : TOOL_EVENTS[toolName];
    if (!tool) return "";
    const toolInput = isObject(input.tool_input) ? input.tool_input : {};
    const role = tool.roleField === undefined ? roleOf(input) : (stringField(toolInput, tool.roleField) ?? DEFAULT_SUBAGENT);
    const event = eventOf(input, tool.type, stringField(toolInput, tool.actionField) ?? "", role);
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
  private postToolUseFailure(input: JsonObject): string {
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
  private subagentStop(input: JsonObject): string {
    const agentType = stringField(input, "agent_type");
    // A stop that names no agent cannot be matched to a run; read as the main agent's, it would end the host's own.
    if (agentType === undefined) return "";
    // The subagent's own transcript holds its usage; the input's transcript_path is the main session's.
    decide({ ...eventOf(input, "after-agent-stop", agentType), cost: this.readUsage(stringField(input, "agent_transcript_path")) });
    return "";
  }

  /**
   * Before the main agent's turn: what changed outside its chat since it was last told, added after
   * the Human's prompt, so the cached text before it stays the same. Nothing when nothing is new.
   */
  private userPromptSubmit(input: JsonObject): string {
    if (stringField(input, "agent_type") !== undefined) return "";
    return addedText(handleEvent({ type: "planner-turn", projectDir: projectDirOf(input), host: HOST_ID }).context, "UserPromptSubmit");
  }

  /** Claude Code takes no answer to a session's end; a reviewer host's run without a verdict ends with it. */
  private sessionEnd(input: JsonObject): string {
    handleEvent({ type: "session-end", projectDir: projectDirOf(input), host: HOST_ID });
    return "";
  }

  /** The project a hook's input names; null when the input is no JSON. */
  projectOf(stdinText: string): string | null {
    try {
      const input: unknown = stdinText.trim() === "" ? {} : JSON.parse(stdinText);
      return projectDirOf(isObject(input) ? input : {});
    } catch {
      return null;
    }
  }

  /**
   * Turns Claude Code's hook input into the engine's event and the engine's answer into
   * Claude Code's hook output; `run` is what the command line read about the run. Returns the
   * stdout text, empty when there is nothing to say, or throws on bad input.
   */
  answer(event: string, stdinText: string, run: HookRun): string {
    const answer = Object.hasOwn(this.answers, event) ? this.answers[event as HookName] : undefined;
    if (!answer) throw new Error(`unknown hook event '${event}'`);
    const input: unknown = stdinText.trim() === "" ? {} : JSON.parse(stdinText);
    return answer(isObject(input) ? input : {}, run);
  }
}
