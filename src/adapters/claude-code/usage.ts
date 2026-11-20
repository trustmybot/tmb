// A Claude Code subagent's cost: the tokens in the transcript its stop hook names, per model
// (trustmybot/tmb#133). Claude Code writes the transcript as JSON lines, and one message can span
// several lines that each repeat its usage, so each message is counted once, by its id. The
// format is Claude Code's own and may change: anything unreadable gives no cost, never an error.
import { readFileSync } from "node:fs";
import type { ModelUsage } from "../../engine/store/index.ts";

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The tokens per model in a transcript's text, or null when it holds no usage tmb can read. */
export function usageOfTranscript(text: string): ModelUsage[] | null {
  // The last line of a message carries its final usage, so a later line replaces an earlier one.
  const messages = new Map<string, { model: string; usage: Usage }>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || !isObject(entry.message)) continue;
    const { id, model, usage } = entry.message;
    if (typeof id !== "string" || typeof model !== "string" || !isObject(usage)) continue;
    messages.set(id, {
      model,
      usage: {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
      },
    });
  }
  if (messages.size === 0) return null;
  const perModel = new Map<string, ModelUsage>();
  for (const { model, usage } of messages.values()) {
    const sum = perModel.get(model) ?? { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    sum.inputTokens += usage.input;
    sum.outputTokens += usage.output;
    sum.cacheReadTokens += usage.cacheRead;
    sum.cacheWriteTokens += usage.cacheWrite;
    perModel.set(model, sum);
  }
  return [...perModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/** The tokens per model in the transcript at `file`, or null when it cannot be read. */
export function usageOfTranscriptFile(file: string | undefined): ModelUsage[] | null {
  if (file === undefined) return null;
  try {
    return usageOfTranscript(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
