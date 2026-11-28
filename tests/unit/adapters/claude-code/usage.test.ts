// A Claude Code subagent's cost from its transcript (trustmybot/tmb#133): each message counted
// once by its id, the last line of a message winning, summed per model.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { usageOfTranscript, usageOfTranscriptFile } from "../../../../src/adapters/claude-code/usage.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const line = (id: string, model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) =>
  JSON.stringify({
    type: "assistant",
    message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } },
  });

describe("usageOfTranscript", () => {
  test("counts a message that spans several lines once, by its last line, and splits by model", () => {
    const text = [
      JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
      line("m1", "claude-opus-5-5", 10, 1, 100, 5),
      line("m1", "claude-opus-5-5", 10, 20, 100, 5),
      line("m2", "claude-opus-5-5", 3, 4),
      line("m3", "claude-haiku-5-5", 7, 8),
      "not json",
      "",
    ].join("\n");
    expect(usageOfTranscript(text)).toEqual([
      { model: "claude-haiku-5-5", inputTokens: 7, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: "claude-opus-5-5", inputTokens: 13, outputTokens: 24, cacheReadTokens: 100, cacheWriteTokens: 5 },
    ]);
  });

  test("gives no cost for a transcript with no usage, or a file that cannot be read", () => {
    expect(usageOfTranscript(JSON.stringify({ type: "user", message: { content: "hi" } }))).toBeNull();
    expect(usageOfTranscript("")).toBeNull();
    expect(usageOfTranscriptFile(undefined)).toBeNull();
    expect(usageOfTranscriptFile("/no/such/transcript.jsonl")).toBeNull();
  });

  test("reads the file the stop hook names", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tmb-usage-"));
    try {
      const file = path.join(dir, "agent.jsonl");
      writeFileSync(file, `${line("m1", "claude-sonnet-5-5", 1, 2)}\n`);
      expect(usageOfTranscriptFile(file)).toEqual([{ model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
