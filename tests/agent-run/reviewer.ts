// Reviewer agent run (Level 6): in a fresh copy of the small bun project, the Human lands a
// correct fix for add on the feature branch feat/fix-add through a task, then a real Claude Code
// session is asked to have the branch reviewed. Passes when the record holds a pass at the
// branch's tip from the reviewer, which tmb takes only from a reviewer run the host started.
//   bun tests/agent-run/reviewer.ts
// TMB_BIN          the tmb to set up with (default: tmb on PATH)
// TMB_AGENT_MODEL  the model claude runs (default: haiku)
// TMB_AGENT_LOG    where the answer is saved (default: a new file under the temp folder)
// Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODE_TOOLS, MODEL, Tmb, agentLog, askClaude, bareOrigin, fail, fixtureProject, git, preflight, readPrompt, show, tempDir } from "../lib/driver.ts";

// prompts/reviewer.txt is Human-authored: never edit it to make this test pass.
const prompt = readPrompt(path.join(import.meta.dir, "prompts/reviewer.txt"));
const fixture = path.join(import.meta.dir, "fixtures/math");
const base = "main";
const feature = "feat/fix-add";
const check = "bun test";
const tmbBin = preflight("reviewer run", ["git", "bun"]);

const project = tempDir("tmb-reviewer-run");
const work = tempDir("tmb-reviewer-run-work");
const log = agentLog("tmb-reviewer-run");
const tmb = new Tmb(tmbBin, project);

fixtureProject(fixture, project, { base, name: "tmb reviewer run", email: "reviewer-run@example.com", message: "Add the math project" });
// A bare origin that already holds the base branch, so the feature branch's backup push and the review have somewhere to go.
bareOrigin(project, path.join(work, "origin.git"), base);
tmb.shown(["init"], `tmb init failed in ${project}`);
tmb.human(["onboard", "--yes", "--base", base, "--review-mode", "agile", "--check", check], `tmb onboard failed in ${project}`);

// The Human lands the fix as a task on the feature branch, so there is a finished branch to review.
const issue = tmb.json<{ id: string }>(["issue", "create", "add returns the wrong sum"]).data.id;
tmb.text(["feature", "start", feature]);
const started = tmb.json<{ id?: string; worktree?: string }>(["task", "start", issue, "--kind", "code", "--intent", "Make add return the sum", "--file", "src/math.ts", "--criterion", "add(2, 3) is 5"]);
const { id: task, worktree } = started.data;
if (!task || !worktree || !existsSync(worktree)) fail(`tmb task start gave no task or worktree: ${started.text}`);
const source = path.join(worktree, "src/math.ts");
writeFileSync(source, readFileSync(source, "utf8").replace("a - b", "a + b"));
try {
  git(worktree, "commit", "-q", "-am", "Make add return the sum");
} catch (error) {
  fail(`could not commit the fix in ${worktree}: ${error instanceof Error ? error.message : String(error)}`);
}
tmb.text(["task", "close", task]);

console.log(`Asking claude (${MODEL}): ${prompt}`);
const status = askClaude(project, prompt, log, { allowedTools: CODE_TOOLS });
show("answer", log);
if (status !== 0) fail(`claude exited ${status}`);

tmb.shown(["feature", "brief", feature], `tmb feature brief ${feature} failed`);
const brief = tmb.json<{ tip: string; coveredBy: "review" | "waiver" | null }>(["feature", "brief", feature]).data;
if (brief.coveredBy !== "review") fail(`the record holds no reviewer's pass at the tip of ${feature}; the brief is above`);
console.log(`PASS the reviewer passed ${feature} at its tip ${brief.tip}`);
