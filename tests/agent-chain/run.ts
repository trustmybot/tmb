// Agent chain (Level 1): in a fresh git project set up with tmb, one Claude Code session is told
// a goal and bro records it, and a new session must find it in the record at its start.
//   bun tests/agent-chain/run.ts
// TMB_BIN          the tmb to set up with (default: tmb on PATH)
// TMB_AGENT_MODEL  the model claude runs (default: haiku)
// Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN). Exits 0 PASS, 1 FAIL, 2 when it cannot run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODEL, Tmb, askClaude, fail, git, preflight, readPrompt, show, tempDir } from "../lib/driver.ts";

// prompts/record.txt and prompts/resume.txt are Human-authored, in a user's words: never edit
// them to make this test pass. The checks look for the goal they name, not for a title.
const recordPrompt = readPrompt(path.join(import.meta.dir, "prompts/record.txt"));
const resumePrompt = readPrompt(path.join(import.meta.dir, "prompts/resume.txt"));
const goal = "dark mode";
const tmbBin = preflight("agent chain");

const project = tempDir("tmb-agent-chain");
const logs = tempDir("tmb-agent-chain-logs", true);
const tmb = new Tmb(tmbBin, project);

try {
  git(project, "init", "-q");
} catch {
  fail(`git init failed in ${project}`);
}
tmb.shown(["init"], `tmb init failed in ${project}`);
tmb.shown(["onboard", "--yes", "--review-mode", "agile"], `tmb onboard failed in ${project}`);

// Each session is a new claude with tmb's tools allowed.
const recordLog = path.join(logs, "record.log");
console.log(`Session 1, asking claude (${MODEL}): ${recordPrompt}`);
const recordStatus = askClaude(project, recordPrompt, recordLog, { allowedTools: "mcp__tmb__*" });
show("session 1 answer", recordLog);

const resumeLog = path.join(logs, "resume.log");
console.log(`Session 2, asking claude (${MODEL}): ${resumePrompt}`);
const resumeStatus = askClaude(project, resumePrompt, resumeLog, { allowedTools: "mcp__tmb__*" });
show("session 2 answer", resumeLog);

if (recordStatus !== 0) fail(`session 1: claude exited ${recordStatus}`);
// The list clips each body, so each open issue is read whole, and only its own title or body
// may match, never its notes.
const issues = tmb.json<{ id: string }[]>(["issue", "list", "--state", "open"]);
const needle = goal.toLowerCase();
const found = issues.data.find(({ id }) => {
  const { issue } = tmb.json<{ issue: { title: string; body: string } }>(["issue", "show", id]).data;
  return issue.title.toLowerCase().includes(needle) || issue.body.toLowerCase().includes(needle);
});
if (!found) fail(`session 1 recorded no open issue whose title or body names '${goal}'; the record holds: ${issues.text}`);
if (resumeStatus !== 0) fail(`session 2: claude exited ${resumeStatus}`);
if (!readFileSync(resumeLog, "utf8").toLowerCase().includes(needle)) fail(`session 2's answer never mentions '${goal}'`);
console.log(`PASS session 1 recorded the '${goal}' goal and session 2 found it`);
