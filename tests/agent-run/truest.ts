// Truest agent run (Level 10): one task from request to its pull request. In a fresh copy of the
// small bun project set up in truest mode, a real Claude Code session is asked to fix add and open
// the pull request. Passes when the record holds a closed task with a reviewer's pass at its
// commit and its pull request address, its branch is on origin, and `gh pr create` ran for it.
// A fake gh on PATH stands in for GitHub.
//   bun tests/agent-run/truest.ts
// TMB_BIN          the tmb to set up with (default: tmb on PATH)
// TMB_AGENT_MODEL  the model claude runs (default: haiku)
// TMB_AGENT_LOG    where the answer is saved (default: a new file under the temp folder)
// Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODE_TOOLS, MODEL, Tmb, agentLog, askClaude, bareOrigin, fail, fixtureProject, git, preflight, readPrompt, show, tempDir } from "../lib/driver.ts";

// prompts/truest.txt is Human-authored: never edit it to make this test pass.
const prompt = readPrompt(path.join(import.meta.dir, "prompts/truest.txt"));
const fixture = path.join(import.meta.dir, "fixtures/math");
const base = "main";
const check = "bun test";
const tmbBin = preflight("truest run", ["git", "bun"]);

const project = tempDir("tmb-truest-run");
const work = tempDir("tmb-truest-run-work");
const log = agentLog("tmb-truest-run");
const tmb = new Tmb(tmbBin, project);

fixtureProject(fixture, project, { base, name: "tmb truest run", email: "truest-run@example.com", message: "Add the math project" });
const origin = path.join(work, "origin.git");
bareOrigin(project, origin, base);
tmb.shown(["setup", "--yes", "--base", base, "--review-mode", "truest", "--check", check], `tmb setup failed in ${project}`);

// A fake gh: it logs its arguments and prints a pull request address, as `gh pr create` does.
const ghLog = path.join(work, "gh.log");
const fakeBin = path.join(work, "fake-gh");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\necho "https://github.com/example/math/pull/1"\n`, { mode: 0o755 });
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;

console.log(`Asking claude (${MODEL}): ${prompt}`);
const status = askClaude(project, prompt, log, { allowedTools: CODE_TOOLS });
show("answer", log);
if (status !== 0) fail(`claude exited ${status}`);

type Brief = { id: string; state: string; branch: string; review?: { coveredBy: "review" | "waiver" | null; prUrl: string | null; to: string | null } };
const closed = tmb.json<{ id: string }[]>(["task", "list", "--state", "closed"]).data;
if (closed.length === 0) fail(`the record holds no closed task: ${tmb.text(["task", "list", "--state", "all"])}`);
const briefs = closed.map((task) => tmb.json<Brief>(["task", "brief", task.id]).data);
const done = briefs.find((brief) => brief.review?.coveredBy === "review" && brief.review.prUrl !== null);
if (!done) fail(`no closed task holds a reviewer's pass and a pull request: ${JSON.stringify(briefs, null, 2)}`);
const onOrigin = git(project, "ls-remote", "origin", `refs/heads/${done.branch}`);
if (onOrigin === "") fail(`${done.branch} is not on origin`);
const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
if (!ghCalls.includes(`pr create --base ${base} --head ${done.branch}`)) fail(`gh pr create did not run for ${done.branch}: ${ghCalls || "(no gh call)"}`);
console.log(`PASS task ${done.id} was reviewed and its pull request opened from ${done.branch}: ${done.review!.prUrl}`);
