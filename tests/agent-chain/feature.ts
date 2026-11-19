// Agent chain (Level 4): a feature branch collects tasks across sessions. In a fresh copy of a
// small bun project whose origin is a local bare repository, one Claude Code session asks for a
// subtract function and a new session asks for multiply too. Passes when the record holds exactly
// one feature branch with at least two closed tasks, that branch's tree exports both functions
// from the math module and passes `bun test`, origin holds the same tip, and no task branch is
// left. Every check reads the record and git, never the agents' answers.
//   bun tests/agent-chain/feature.ts
// TMB_BIN          the tmb to set up with (default: tmb on PATH)
// TMB_AGENT_MODEL  the model claude runs (default: haiku)
// Needs a logged-in claude (or CLAUDE_CODE_OAUTH_TOKEN), git and bun. Exits 0 PASS, 1 FAIL, 2 when it cannot run.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CODE_TOOLS,
  MODEL,
  Tmb,
  askClaude,
  bareOrigin,
  bunTest,
  checkoutTree,
  fail,
  fixtureProject,
  preflight,
  readPrompt,
  revParse,
  run,
  show,
  tempDir,
} from "../lib/driver.ts";

// prompts/feature-1.txt and prompts/feature-2.txt are Human-authored, in a user's words: never
// edit them to make this test pass.
const firstPrompt = readPrompt(path.join(import.meta.dir, "prompts/feature-1.txt"));
const secondPrompt = readPrompt(path.join(import.meta.dir, "prompts/feature-2.txt"));
const fixture = path.join(import.meta.dir, "../agent-run/fixtures/math");
const base = "main";
const check = "bun test";
const tmbBin = preflight("feature chain", ["git", "bun"]);

const scratch = tempDir("tmb-feature-chain");
const logs = tempDir("tmb-feature-chain-logs", true);
const project = path.join(scratch, "project");
const origin = path.join(scratch, "origin.git");
const tree = path.join(scratch, "feature-tree");
const tmb = new Tmb(tmbBin, project);

fixtureProject(fixture, project, {
  base,
  name: "tmb feature chain",
  email: "feature-chain@example.com",
  message: "Add the math project",
  // The fixture's add is wrong on purpose for the worker run; this chain is about collecting
  // features, so the project starts green and every red check comes from the agents' own work.
  before: () => writeFileSync(path.join(project, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n"),
});
bareOrigin(project, origin, base);
if (!bunTest(project, path.join(logs, "base.log"))) {
  fail(`the project's tests fail before any work, so a refused close would prove nothing: ${readFileSync(path.join(logs, "base.log"), "utf8")}`);
}
tmb.shown(["setup", "--yes", "--base", base, "--check", check], `tmb setup failed in ${project}`);

const firstLog = path.join(logs, "session-1.log");
console.log(`Session 1, asking claude (${MODEL}): ${firstPrompt}`);
const firstStatus = askClaude(project, firstPrompt, firstLog, { allowedTools: CODE_TOOLS });
show("session 1 answer", firstLog);
const secondLog = path.join(logs, "session-2.log");
console.log(`Session 2, asking claude (${MODEL}): ${secondPrompt}`);
const secondStatus = askClaude(project, secondPrompt, secondLog, { allowedTools: CODE_TOOLS });
show("session 2 answer", secondLog);

if (firstStatus !== 0) fail(`session 1: claude exited ${firstStatus}`);
if (secondStatus !== 0) fail(`session 2: claude exited ${secondStatus}`);

const features = tmb.json<{ name: string }[]>(["feature", "list"]);
if (features.data.length !== 1) fail(`the record holds ${features.data.length} feature branches, not one: ${features.text}`);
const feature = features.data[0]!.name;

const tasks = tmb.json<{ state: string; feature: string | null }[]>(["task", "list", "--state", "all"]);
const closed = tasks.data.filter((task) => task.state === "closed" && task.feature === feature).length;
if (closed < 2) fail(`the feature branch ${feature} has ${closed} closed tasks, not at least two: ${tasks.text}`);

const tip = revParse(project, `refs/heads/${feature}`);
if (!tip) fail(`git has no branch ${feature}`);
console.log(`--- git log ${base}..${feature} ---`);
console.log(run("git", ["log", "--format=%h %s", `${base}..${feature}`], { cwd: project }).output.trimEnd());
console.log("--- end of git log ---");

try {
  checkoutTree(project, tip, tree);
} catch {
  fail(`could not check out ${feature} at ${tip}`);
}
// Loaded in a child bun, so the agents' code cannot end or crash this driver.
const exportsCheck = path.join(scratch, "exports.ts");
writeFileSync(
  exportsCheck,
  `import * as math from ${JSON.stringify(pathToFileURL(path.join(tree, "src/math.ts")).href)};
const subtract = (math as Record<string, unknown>).subtract;
const multiply = (math as Record<string, unknown>).multiply;
if (typeof subtract !== "function" || typeof multiply !== "function") {
  console.log("src/math.ts exports " + Object.keys(math).join(", "));
  process.exit(1);
}
if (subtract(7, 3) !== 4 || multiply(4, 3) !== 12) {
  console.log("subtract(7, 3) = " + subtract(7, 3) + ", multiply(4, 3) = " + multiply(4, 3));
  process.exit(1);
}
console.log("ok");
`,
);
const exportsResult = run("bun", [exportsCheck], { cwd: scratch });
if (exportsResult.status !== 0 || exportsResult.stdout.trim() !== "ok") {
  fail(`${feature} at ${tip} does not export a working subtract and multiply from src/math.ts: ${exportsResult.output.trim()}`);
}
const featureTestLog = path.join(logs, "feature-test.log");
if (!bunTest(tree, featureTestLog)) {
  show(`bun test on ${feature}`, featureTestLog);
  fail(`bun test fails on ${feature} at ${tip}`);
}

const pushed = revParse(origin, `refs/heads/${feature}`);
if (!pushed) fail(`origin has no branch ${feature}, so it was never pushed as a backup`);
if (pushed !== tip) fail(`origin's ${feature} is at ${pushed}, but the local tip is ${tip}`);

const branchList = run("git", ["branch", "--list", "tmb/*"], { cwd: project });
if (branchList.status !== 0) fail(`git branch --list failed: ${branchList.output}`);
const taskBranches = branchList.stdout.trim();
if (taskBranches) fail(`task branches remain: ${taskBranches}`);

console.log(`PASS one feature branch ${feature} at ${tip} collected ${closed} closed tasks across two sessions, exports subtract and multiply, passes bun test and is backed up on origin`);
