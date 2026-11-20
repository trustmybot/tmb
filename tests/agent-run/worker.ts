// Worker agent run (Level 3): in a fresh copy of a small bun project whose add returns the wrong
// sum, a real Claude Code session is asked to fix it. Passes when the record holds a task that
// was started and closed, which tmb allows only once its checks pass, and `bun test` passes at
// the commit that task closed at.
//   bun tests/agent-run/worker.ts
// TMB_BIN          the tmb to set up with (default: tmb on PATH)
// TMB_AGENT_MODEL  the model claude runs (default: haiku)
// TMB_AGENT_LOG    where the answer is saved (default: a new file under the temp folder)
// Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { CODE_TOOLS, MODEL, Tmb, agentLog, askClaude, bunTest, checkoutTree, fail, fixtureProject, preflight, readPrompt, show, tempDir } from "../lib/driver.ts";

// prompts/worker.txt is Human-authored: never edit it to make this test pass.
const prompt = readPrompt(path.join(import.meta.dir, "prompts/worker.txt"));
const fixture = path.join(import.meta.dir, "fixtures/math");
const base = "main";
const check = "bun test";
const tmbBin = preflight("worker run", ["git", "bun"]);

const project = tempDir("tmb-worker-run");
const work = tempDir("tmb-worker-run-work");
const log = agentLog("tmb-worker-run");
const tmb = new Tmb(tmbBin, project);

fixtureProject(fixture, project, { base, name: "tmb worker run", email: "worker-run@example.com", message: "Add the math project" });
if (bunTest(project, path.join(work, "base.log"))) {
  fail(`the fixture's tests already pass before any fix, so this run would prove nothing: ${readFileSync(path.join(work, "base.log"), "utf8")}`);
}
tmb.shown(["init"], `tmb init failed in ${project}`);
tmb.shown(["onboard", "--yes", "--base", base, "--check", check], `tmb onboard failed in ${project}`);

console.log(`Asking claude (${MODEL}): ${prompt}`);
const status = askClaude(project, prompt, log, { allowedTools: CODE_TOOLS });
show("answer", log);
if (status !== 0) fail(`claude exited ${status}`);

type Brief = { id: string; state: string; commitSha: string | null };
const tasks = tmb.json<{ id: string }[]>(["task", "list", "--state", "all"]);
if (tasks.data.length === 0) fail("the record holds no task, so no task was started; the answer is above");

let closed: { brief: Brief; text: string } | undefined;
for (const { id } of tasks.data) {
  const brief = tmb.json<Brief>(["task", "brief", id]);
  if (brief.data.state === "closed") {
    closed = { brief: brief.data, text: brief.text };
    break;
  }
}
if (!closed) fail(`a task was started but none closed, so its checks never passed at close; the record holds: ${tasks.text}`);
const { id } = closed.brief;
const commit = closed.brief.commitSha;
if (!commit) fail(`task ${id} is closed but records no commit: ${closed.text}`);
console.log(`Task ${id} closed at commit ${commit}.`);

const atCommit = path.join(work, "at-commit");
try {
  checkoutTree(project, commit, atCommit);
} catch {
  fail(`could not check out commit ${commit} of task ${id}`);
}
if (!bunTest(atCommit, path.join(work, "at-commit.log"))) {
  show(`bun test at ${commit}`, path.join(work, "at-commit.log"));
  fail(`bun test fails at commit ${commit}, the commit task ${id} closed at`);
}
console.log(`PASS task ${id} was started and closed with its checks passing, and bun test passes at its commit ${commit}`);
