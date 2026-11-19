import { handleEvent } from "../../engine/index.ts";
import { isObject } from "./json-file.ts";

const HOOK_EVENT_NAMES: Record<string, string> = { "session-start": "SessionStart" };

/** The project the session runs in: the hook input's cwd, else Claude Code's project dir, else this process's cwd. */
function projectDirOf(input: unknown): string {
  const cwd = isObject(input) ? input.cwd : undefined;
  if (typeof cwd === "string" && cwd.trim() !== "") return cwd;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  return projectDir && projectDir.trim() !== "" ? projectDir : process.cwd();
}

/**
 * Turns Claude Code's hook input into the engine's event and the engine's answer into
 * Claude Code's hook output. Returns the stdout text, or throws on bad input.
 */
export function answerHook(event: string, stdinText: string): string {
  const hookEventName = HOOK_EVENT_NAMES[event];
  if (!hookEventName) throw new Error(`unknown hook event '${event}'`);
  const input: unknown = stdinText.trim() === "" ? {} : JSON.parse(stdinText);

  const answer = handleEvent({ type: "session-start", projectDir: projectDirOf(input) });
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: answer.context } });
}
