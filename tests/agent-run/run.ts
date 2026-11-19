// Agent run: sets tmb up in a fresh git project, greets a real Claude Code session with the
// Human's prompt, and passes when the answer comes from bro.
//   bun tests/agent-run/run.ts
// TMB_BIN          the tmb to set up with (default: tmb on PATH)
// TMB_AGENT_MODEL  the model claude runs (default: haiku)
// TMB_AGENT_LOG    where the answer is saved (default: a new file under the temp folder)
// Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN). Exits 0 PASS, 1 FAIL, 2 when it cannot run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODEL, Tmb, agentLog, askClaude, fail, git, preflight, readPrompt, show, tempDir } from "../lib/driver.ts";

// prompts/wake-up.txt is Human-authored: never edit it to make this test pass.
const prompt = readPrompt(path.join(import.meta.dir, "prompts/wake-up.txt"));
const tmbBin = preflight("agent run");

const project = tempDir("tmb-agent-run");
const log = agentLog("tmb-agent-run");
const tmb = new Tmb(tmbBin, project);

try {
  git(project, "init", "-q");
} catch {
  fail(`tmb setup failed in ${project}`);
}
tmb.shown(["setup"], `tmb setup failed in ${project}`);

// With no terminal, setup takes each default: the host, the project's branch and agile.
const settings = tmb.text(["config"]);
for (const line of [/^host: \S/m, /^base branch: \S/m, /^review mode: agile$/m]) {
  if (!line.test(settings)) fail(`tmb config after setup has no line matching '${line.source}'; it showed:\n${settings}`);
}
console.log(`tmb config after setup:\n${settings.trimEnd()}`);

console.log(`Asking claude (${MODEL}): ${prompt}`);
const status = askClaude(project, prompt, log);
show("answer", log);

if (status !== 0) fail(`claude exited ${status}`);
const answer = readFileSync(log, "utf8");
if (!/\bbro\b/i.test(answer)) fail("the answer never names bro");
// Signs of a plain assistant that got no role from the SessionStart hook.
const unconfigured =
  /(do not|don.t) have (a|any) (specific |particular |defined )?(role|persona)|no (specific |particular |defined )?(role|persona)|not sure (who|what) .?bro|who is .?bro|i(.m| am) claude\b/i;
const match = unconfigured.exec(answer);
if (match) fail(`the answer reads as an unconfigured assistant: ${match[0]}`);
console.log("PASS the answer identifies itself as bro");
