import { handleEvent, type EngineEvent } from "../../engine/index.ts";

const EVENTS: Record<string, { engineEvent: EngineEvent; hookEventName: string }> = {
  "session-start": { engineEvent: { type: "session-start" }, hookEventName: "SessionStart" },
};

/**
 * Turns Claude Code's hook input into the engine's event and the engine's answer into
 * Claude Code's hook output. Returns the stdout text, or throws on bad input.
 */
export function answerHook(event: string, stdinText: string): string {
  const mapping = EVENTS[event];
  if (!mapping) throw new Error(`unknown hook event '${event}'`);
  // Claude Code sends a JSON object; nothing in it is needed yet, but it must parse.
  if (stdinText.trim() !== "") JSON.parse(stdinText);

  const answer = handleEvent(mapping.engineEvent);
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: mapping.hookEventName, additionalContext: answer.context },
  });
}
