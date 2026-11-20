// Agent chain (Level 9): two hosts on one record, a reviewer from another vendor. In a fresh
// copy of a small bun project, a Claude Code session set up as the planner builds a subtract
// function on a feature branch. Codex, set up in the same project as the reviewer, then runs one
// `codex exec` session that reviews that branch. Passes when the record holds a review of the
// feature branch at its tip made by host codex in the reviewer role, and that review's run was
// opened by Codex's own session start and is closed, which shows the hooks ran in `codex exec`.
// Every check reads the record and git, never the agents' answers.
//   bun tests/agent-chain/second-host.ts
// TMB_BIN          the tmb to set up with (default: tmb on PATH)
// TMB_AGENT_MODEL  the model claude runs (default: haiku)
// TMB_CODEX_MODEL  the model codex runs (default: codex's own)
// Needs a logged-in claude and a logged-in codex, git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CODE_TOOLS,
  MODEL,
  Tmb,
  askClaude,
  bunTest,
  cannotRun,
  fail,
  fixtureProject,
  preflight,
  readPrompt,
  revParse,
  runToFile,
  show,
  tempDir,
  withEnv,
} from "../lib/driver.ts";

const LABEL = "second host chain";
// Both prompts are Human-authored, in a user's words: never edit them to make this test pass.
const plannerPrompt = readPrompt(path.join(import.meta.dir, "prompts/feature-1.txt"));
const reviewerPromptFile = path.join(import.meta.dir, "prompts/second-host-reviewer.txt");
if (!existsSync(reviewerPromptFile)) cannotRun(LABEL, `${reviewerPromptFile} is missing; its wording is the Human's to write.`);
const reviewerPrompt = readPrompt(reviewerPromptFile);
const fixture = path.join(import.meta.dir, "../agent-run/fixtures/math");
const base = "main";
const check = "bun test";
const tmbBin = preflight(LABEL, ["git", "bun"]);
if (!Bun.which("codex")) cannotRun(LABEL, "codex (Codex CLI) is not on PATH; install it and log in, then run this again.");

const scratch = tempDir("tmb-second-host");
const logs = tempDir("tmb-second-host-logs", true);
const project = path.join(scratch, "project");
const tmb = new Tmb(tmbBin, project);

fixtureProject(fixture, project, {
  base,
  name: "tmb second host chain",
  email: "second-host-chain@example.com",
  message: "Add the math project",
  // The fixture's add is wrong on purpose for the worker run; this chain starts green.
  before: () => writeFileSync(path.join(project, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n"),
});
if (!bunTest(project, path.join(logs, "base.log"))) fail(`the project's tests fail before any work: ${readFileSync(path.join(logs, "base.log"), "utf8")}`);
tmb.shown(["init", "--host", "claude-code", "--role", "planner"], `tmb init for Claude Code failed in ${project}`);
tmb.shown(["onboard", "--host", "claude-code", "--yes", "--base", base, "--review-mode", "agile", "--check", check], `tmb onboard failed in ${project}`);
tmb.shown(["init", "--host", "codex", "--role", "reviewer"], `tmb init for Codex failed in ${project}`);

const plannerLog = path.join(logs, "planner.log");
console.log(`Planner session, asking claude (${MODEL}): ${plannerPrompt}`);
const plannerStatus = askClaude(project, plannerPrompt, plannerLog, { allowedTools: CODE_TOOLS });
show("planner answer", plannerLog);
if (plannerStatus !== 0) fail(`planner session: claude exited ${plannerStatus}`);

const features = tmb.json<{ name: string }[]>(["feature", "list"]);
if (features.data.length !== 1) fail(`the record holds ${features.data.length} feature branches, not one: ${features.text}`);
const feature = features.data[0]!.name;
const tip = revParse(project, `refs/heads/${feature}`);
if (!tip) fail(`git has no branch ${feature}`);

// No one is there to trust the project or tmb's hooks, so this run trusts them for itself only:
// trust comes from a command-line override, never written to the Human's Codex config, and the
// hooks run without a saved approval. The project is a throwaway temp folder. The tool server's
// calls are approved for the same reason.
const reviewerLog = path.join(logs, "reviewer.log");
const codexArgs = [
  "exec",
  "-c",
  `projects.${JSON.stringify(project)}.trust_level="trusted"`,
  "-c",
  'mcp_servers.tmb.default_tools_approval_mode="approve"',
  "--dangerously-bypass-hook-trust",
  "--sandbox",
  "read-only",
  ...(process.env.TMB_CODEX_MODEL ? ["--model", process.env.TMB_CODEX_MODEL] : []),
  reviewerPrompt,
];
console.log(`Reviewer session, asking codex: ${reviewerPrompt}`);
const reviewerStatus = runToFile("codex", codexArgs, reviewerLog, { cwd: project, env: withEnv({ TMB_UNATTENDED: "1" }) });
show("reviewer answer", reviewerLog);
if (reviewerStatus !== 0) fail(`reviewer session: codex exited ${reviewerStatus}`);

type Actor = { kind: string; role?: string; host?: string };
type Review = { verdict: string; commit: string | null; by: Actor };
const brief = tmb.json<{ tip: string; reviews: Review[] }>(["feature", "brief", feature]);
if (brief.data.tip !== tip) fail(`${feature} moved during the review, from ${tip} to ${brief.data.tip}`);
const byCodex = brief.data.reviews.filter((review) => review.by.kind === "agent" && review.by.host === "codex");
if (byCodex.length === 0) fail(`no review of ${feature} was recorded by Codex: ${brief.text}`);
const atTip = byCodex.filter((review) => review.commit === tip && review.by.role === "reviewer");
if (atTip.length === 0) fail(`Codex's reviews of ${feature} are not the reviewer's at the tip ${tip}: ${JSON.stringify(byCodex)}`);

// The run a reviewer host's verdict needs opens only at that host's session start, so a closed
// Codex reviewer run shows Codex ran tmb's hooks in `codex exec`.
const db = new Database(path.join(project, ".tmb", "trajectory.db"), { readonly: true });
let runs: { outcome: string | null; ended_at: string | null }[];
try {
  runs = db.query("SELECT outcome, ended_at FROM runs WHERE role = 'reviewer' AND json_extract(created_by, '$.host') = 'codex'").all() as typeof runs;
} finally {
  db.close();
}
if (runs.length === 0) fail("Codex opened no reviewer run, so its session start hook did not run in codex exec");
if (!runs.some((run) => run.ended_at !== null && run.outcome?.startsWith("verdict "))) fail(`no Codex reviewer run ended with its verdict: ${JSON.stringify(runs)}`);

console.log(`PASS Claude Code planned ${feature}, and Codex, set up as the reviewer, recorded a ${atTip[0]!.verdict} at its tip ${tip} in a run its own session start opened`);
