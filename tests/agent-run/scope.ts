// Scope agent run (Level 5): in a fresh copy of a small shop whose loyalty discount is 10
// percent, a real Claude Code session is asked to make it 15. Passes when bro looked the code
// up in tmb's code graph before it started the task, and the task it started names the file
// that holds the discount among its files.
//   bun tests/agent-run/scope.ts
// TMB_BIN          the tmb to set up with (default: tmb on PATH)
// TMB_AGENT_MODEL  the model claude runs (default: haiku)
// TMB_AGENT_LOG    where the session's stream is saved (default: a new file under the temp folder)
// Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { CODE_TOOLS, MODEL, Tmb, agentLog, askClaude, fail, fixtureProject, preflight, readPrompt, tempDir } from "../lib/driver.ts";

// prompts/scope.txt is Human-authored: never edit it to make this test pass.
const prompt = readPrompt(path.join(import.meta.dir, "prompts/scope.txt"));
const fixture = path.join(import.meta.dir, "fixtures/shop");
const target = "src/pricing/discount.ts";
const base = "main";
const check = "bun test";
const tmbBin = preflight("scope run", ["git", "bun"]);

const project = tempDir("tmb-scope-run");
const log = agentLog("tmb-scope-run");
const tmb = new Tmb(tmbBin, project);

fixtureProject(fixture, project, { base, name: "tmb scope run", email: "scope-run@example.com", message: "Add the shop" });
tmb.shown(["init"], `tmb init failed in ${project}`);
tmb.human(["onboard", "--yes", "--base", base, "--review-mode", "agile", "--check", check], `tmb onboard failed in ${project}`);

console.log(`Asking claude (${MODEL}): ${prompt}`);
// The stream records every tool call in order, which is what this run checks. The same tools
// as the worker run: every call still goes through tmb's hooks.
const status = askClaude(project, prompt, log, { allowedTools: CODE_TOOLS, args: ["--output-format", "stream-json", "--verbose"] });
console.log(`--- session stream saved to ${log} ---`);

/** The tool calls in the order they were made, the subagents' among them. */
function toolCalls(stream: string): string[] {
  const calls: string[] = [];
  for (const line of stream.split("\n")) {
    let event: { type?: string; message?: { content?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content as { type?: string; name?: string }[]) {
      if (block.type === "tool_use" && block.name) calls.push(block.name);
    }
  }
  return calls;
}
const calls = toolCalls(readFileSync(log, "utf8"));
console.log("Tool calls, in order:");
for (const call of calls) console.log(`  ${call}`);
if (status !== 0) fail(`claude exited ${status}`);

// 1-based call numbers, as the log reads.
const firstGraph = calls.findIndex((call) => call.startsWith("mcp__tmb__graph_")) + 1;
const firstStart = calls.indexOf("mcp__tmb__task_start") + 1;
if (firstStart === 0) fail("bro never called task_start, so no task was scoped");
if (firstGraph === 0 || firstGraph > firstStart) fail(`bro started the task (call ${firstStart}) without a code graph lookup before it`);
const reads = calls.slice(0, firstStart).filter((call) => ["Read", "Grep", "Glob"].includes(call)).length;
console.log(`Before task_start: the first code graph lookup was call ${firstGraph}, and bro made ${reads} file reads or searches.`);

const tasks = tmb.json<{ id: string }[]>(["task", "list", "--state", "all"]);
const taskId = tasks.data[0]?.id;
if (!taskId) fail(`the record holds no task: ${tasks.text}`);
const brief = tmb.json<{ spec: { files: string[] } }>(["task", "brief", taskId]);
const files = brief.data.spec.files;
console.log(`Task ${taskId} files: ${files.join(" ")}`);
const covered = files.find((file) => target === file || target.startsWith(`${file.replace(/\/$/, "")}/`));
if (!covered) fail(`task ${taskId} does not hold ${target}, where the loyalty discount lives; its files are: ${files.join(" ")}`);
console.log(`PASS bro looked the code up in the code graph before it started task ${taskId}, whose files hold ${target} (as ${covered})`);
