// Steps 5 to 8 and 10 to 14: what a user asks bro, each a real session with the model. Every
// prompt is in tests/chain/prompts, in a user's words. Each step's checks read the record, git and
// the stand-in for GitHub, not what bro said, except where the answer is the thing tested.
//
// The story: one feature in api (due dates), built in two sessions, with a task dropped on the
// way; reviewed and opened as a pull request; a fix while it is open; merged by hand as a squash.
// Then one task in tools, in truest mode; a Human-only step bro must not take; and one task in
// notes, which has no remote, ended by the Human's local merge.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { type Checks, remoteBase, type Step } from "../chain.ts";
import { FOREIGN_HOOK_REFS } from "../demo.ts";
import { Github } from "../github.ts";
import { actorOf, audit, type FeatureRow, features, guardDecisions, issues, now, reviews, runs, show, since, type TaskRow, tasks } from "../record.ts";
import { askBro, prompt, type Turn } from "../session.ts";
import { callTools } from "../tool-server.ts";
import { BASE, PROGRAM, type RepoName, type World } from "../world.ts";

/** A turn that did not end well stops the step: nothing after it can be judged. */
function turnRan(checks: Checks, turn: Turn, what: string): void {
  checks.must(`${what}: the session ran to its end`, turn.status === 0 && !turn.isError, turn.shown);
}

/** The one open feature branch in `repo`; stops the step when there is not exactly one. */
function openFeature(world: World, checks: Checks, repo: RepoName): FeatureRow {
  const open = features(world).filter((feature) => feature.repo === repo && feature.state !== "merged" && feature.state !== "dropped");
  checks.must(`the record holds one feature branch in ${repo}`, open.length === 1, show(features(world)));
  return open[0]!;
}

const tasksOf = (world: World, feature: FeatureRow) => tasks(world).filter((task) => task.feature_id === feature.id);

/** The commit a branch is at in a repo, or null. */
function tipOf(world: World, repo: RepoName, branch: string): string | null {
  const result = world.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: world.repo(repo) });
  return result.status === 0 ? result.stdout.trim() : null;
}

function remoteTipOf(world: World, repo: RepoName, branch: string): string | null {
  const result = world.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: world.remote(repo) });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Runs `command` in a clean checkout of `commit` of `repo`; true when it exits 0. */
function passesAt(world: World, repo: RepoName, commit: string, command: string[]): { ok: boolean; output: string } {
  const dir = mkdtempSync(path.join(world.tmp, `${repo}-at-`));
  try {
    world.git(world.repo(repo), "worktree", "add", "-q", "--detach", dir, commit);
    if (repo === "api") world.run("bun", ["install", "--silent"], { cwd: dir });
    const result = world.run(command[0]!, command.slice(1), { cwd: dir });
    return { ok: result.status === 0, output: result.output };
  } finally {
    world.run("git", ["worktree", "remove", "--force", dir], { cwd: world.repo(repo) });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A closed task's worker run: one that ended, finished, with its tokens (trustmybot/tmb#150). */
function workerRanFor(world: World, checks: Checks, task: TaskRow): void {
  const ran = runs(world).filter((run) => run.task_id === task.id && run.role === "worker");
  checks.ok(`task ${task.id} (${task.title}) was written by a worker run that finished and kept its tokens (trustmybot/tmb#150)`, ran.some((run) => run.ended_at !== null && run.outcome === "finished" && run.cost !== null), show(ran));
}

/** Pushes tmb made for an agent are recorded as that agent's, not the Human's (trustmybot/tmb#134). */
function pushesAreAgents(world: World, checks: Checks, at: string, repo: RepoName): void {
  const pushes = since(guardDecisions(world), at).filter((row) => {
    try {
      const event = JSON.parse(row.event) as { type?: string; repo?: string };
      return event.type === "before-push" && event.repo === repo && row.decision === "allow";
    } catch {
      return false;
    }
  });
  checks.ok(`${repo}: tmb pushed for the agents in this step, and the record names an agent for each push, not the Human (trustmybot/tmb#134)`, pushes.length > 0 && pushes.every((row) => actorOf(row.created_by).kind === "agent"), show(pushes.map((row) => ({ by: row.created_by, event: row.event.slice(0, 200) }))));
}

// ---------------------------------------------------------------------------------------------

/** Signs of a plain assistant that got no role from tmb's session start. */
const UNCONFIGURED = /(do not|don.t) have (a|any) (specific |particular |defined )?(role|persona)|no (specific |particular |defined )?(role|persona)|not sure (who|what) .?bro|who is .?bro|i(.m| am) claude\b/i;

export const hi: Step = {
  n: 5,
  name: '"hi": bro answers as bro; each repo has its tests area',
  model: true,
  covers: [146],
  budget: 1_500_000,
  async run(world, checks) {
    const at = now();
    const turn = askBro(world, prompt("05-hi"), "05-hi");
    turnRan(checks, turn, "hi");
    // The answer is the thing tested here: bro's role reached the session.
    checks.ok("bro answers as bro, the planner tmb's session start makes it", /\bbro\b/i.test(turn.answer) && !UNCONFIGURED.test(turn.answer), turn.answer);
    checks.ok("a hello starts no task and no feature branch", since(tasks(world), at).length === 0 && since(features(world), at).length === 0, show([...since(tasks(world), at), ...since(features(world), at)]));
    // The areas bro can scope by: tests is built in, in every repo, with no setup (trustmybot/tmb#146).
    const answers = await callTools(world, (["api", "tools", "notes"] as const).map((repo) => ({ name: "graph_areas", args: { repo, unplaced: 0 } })));
    const testsOf = (index: number) => ((answers[index]?.json as { areas?: { name: string; builtin: boolean; status: string; files: number }[] } | null)?.areas ?? []).find((area) => area.name === "tests" && area.builtin);
    checks.ok("each repo has the built-in tests area, unbroken (trustmybot/tmb#146)", [0, 1, 2].every((index) => testsOf(index)?.status === "ok"), answers.map((answer) => answer.text.slice(0, 400)).join("\n"));
    checks.ok("the tests area holds api's and tools' test files (trustmybot/tmb#146)", (testsOf(0)?.files ?? 0) >= 1 && (testsOf(1)?.files ?? 0) >= 1, answers.map((answer) => answer.text.slice(0, 400)).join("\n"));
  },
};

export const feature: Step = {
  n: 6,
  name: "Ask for a feature in api: issue, scope from the graph, feature branch, first task by a worker",
  model: true,
  covers: [150, 169, 235],
  budget: 6_000_000,
  run(world, checks) {
    const at = now();
    const turn = askBro(world, prompt("06-feature"), "06-feature");
    turnRan(checks, turn, "the feature request");
    const opened = since(issues(world), at);
    checks.ok("bro records the goal as an issue", opened.length >= 1 && opened.every((issue) => actorOf(issue.created_by).role === "planner"), show(opened));
    const branch = openFeature(world, checks, "api");
    checks.ok(`the feature branch ${branch.name} is cut from origin's ${BASE} (trustmybot/tmb#169)`, branch.base_commit === remoteBase(world, "api"), `${branch.base_commit} against origin's ${remoteBase(world, "api")}`);
    const closed = tasksOf(world, branch).filter((task) => task.state === "closed");
    checks.must(`a task on ${branch.name} closed`, closed.length >= 1, show(tasksOf(world, branch)));
    for (const task of closed) workerRanFor(world, checks, task);
    checks.ok("the task's spec names files in api that the code graph knows (trustmybot/tmb#235)", closed.some((task) => /src\/todo\.ts|src\/server\.ts|src\/index\.ts/.test(task.spec)), show(closed.map((task) => task.spec.slice(0, 400))));
    const tip = tipOf(world, "api", branch.name);
    checks.must(`git has the branch ${branch.name}`, tip !== null);
    checks.ok(`origin holds ${branch.name} at its tip, pushed as a backup`, remoteTipOf(world, "api", branch.name) === tip, `${remoteTipOf(world, "api", branch.name)} against ${tip}`);
    pushesAreAgents(world, checks, at, "api");
    const test = passesAt(world, "api", tip!, ["bun", "test"]);
    checks.ok(`bun test passes at ${branch.name}'s tip`, test.ok, test.output.slice(-1500));
    const source = world.git(world.repo("api"), "show", `${tip}:src/todo.ts`);
    checks.ok("the to-do has a due date on the feature branch", /due/i.test(source), source);
  },
};

export const resume: Step = {
  n: 7,
  name: 'New session, "where were we?", then a second task on the same branch',
  model: true,
  covers: [182],
  budget: 6_000_000,
  async run(world, checks) {
    const branch = openFeature(world, checks, "api");
    const closedBefore = tasksOf(world, branch).filter((task) => task.state === "closed").length;
    const where = askBro(world, prompt("07-resume"), "07-resume");
    turnRan(checks, where, "where were we");
    checks.ok(`bro picks up from the record: it names the feature branch ${branch.name}`, where.answer.includes(branch.name) || /due[ -]date/i.test(where.answer), where.answer);
    const at = now();
    const next = askBro(world, prompt("07-next-task"), "07-next-task", { resume: where.sessionId });
    turnRan(checks, next, "the next task");
    const after = features(world).filter((feature) => feature.repo === "api" && feature.state !== "dropped");
    checks.ok("the next task goes on the same feature branch: no second one", after.length === 1 && after[0]!.id === branch.id, show(after));
    const added = tasksOf(world, branch).filter((task) => task.state === "closed" && task.created_at >= at);
    checks.must(`a second task on ${branch.name} closed`, added.length >= 1 && closedBefore + added.length >= 2, show(tasksOf(world, branch)));
    for (const task of added) workerRanFor(world, checks, task);
    // The graph reads the feature branch, so its new functions are found there (trustmybot/tmb#182).
    const [found] = await callTools(world, [{ name: "graph_find", args: { repo: "api", query: "overdue", feature: branch.name } }]);
    checks.ok(`the code graph reads ${branch.name}: it finds the overdue lookup there (trustmybot/tmb#182)`, found?.ok === true && /overdue/i.test(found.text), found?.text.slice(0, 800) ?? "no answer");
    const tip = tipOf(world, "api", branch.name)!;
    const test = passesAt(world, "api", tip, ["bun", "test"]);
    checks.ok(`bun test passes at ${branch.name}'s tip`, test.ok, test.output.slice(-1500));
  },
};

export const drop: Step = {
  n: 8,
  name: "Drop a task, with a reason",
  model: true,
  covers: [170],
  budget: 2_000_000,
  async run(world, checks) {
    const branch = openFeature(world, checks, "api");
    const issue = tasksOf(world, branch)[0]!.issue_id;
    // A task started in an earlier session that nobody went on with: sorting by due date.
    const [started] = await callTools(world, [
      {
        name: "task_start",
        args: {
          issue_id: issue,
          kind: "code",
          feature: branch.name,
          intent: "Sort the to-do list by due date, the soonest first and the ones with no date last.",
          files: ["src/todo.ts", "test/todo.test.ts"],
          criteria: ["A list sorted by due date puts the soonest first and the undated last."],
        },
      },
    ]);
    const id = (started?.json as { task_id?: string; id?: string } | undefined)?.task_id ?? (started?.json as { id?: string } | undefined)?.id;
    checks.must("a sorting task is open on the feature branch", started?.ok === true && typeof id === "string", started?.text ?? "no answer");
    const turn = askBro(world, prompt("08-drop"), "08-drop");
    turnRan(checks, turn, "the drop");
    const task = tasks(world).find((each) => each.id === id)!;
    checks.ok(`bro drops task ${id}, with the reason (trustmybot/tmb#170)`, task.state === "dropped" && (task.drop_reason ?? "").trim() !== "", show([task]));
    checks.ok("its worktree is gone: it held no work", task.worktree === null || !existsSync(task.worktree), task.worktree ?? "");
    const others = tasksOf(world, branch).filter((each) => each.id !== id && each.state === "dropped");
    checks.ok("no other task is dropped", others.length === 0, show(others));
    checks.ok(`${branch.name} is still open`, features(world).find((each) => each.id === branch.id)?.state === "open", show(features(world)));
  },
};

export const reviewAndPr: Step = {
  n: 10,
  name: "The reviewer passes the branch; bro pushes and opens the pull request",
  model: true,
  covers: [134],
  budget: 4_000_000,
  run(world, checks) {
    const github = new Github(world);
    const branch = openFeature(world, checks, "api");
    const baseBefore = remoteBase(world, "api");
    const at = now();
    const turn = askBro(world, prompt("10-review-and-pr"), "10-review-and-pr");
    turnRan(checks, turn, "review and pull request");
    const after = features(world).find((each) => each.id === branch.id)!;
    const tip = tipOf(world, "api", branch.name);
    const passed = reviews(world).filter((review) => review.feature_id === branch.id && review.verdict === "pass" && review.commit_sha === tip);
    checks.ok(`the reviewer passed ${branch.name} at its tip`, passed.length >= 1, show(reviews(world)));
    const byRun = runs(world).filter((run) => passed.some((review) => review.run_id === run.id));
    checks.ok("the pass came from a reviewer run that finished and kept its tokens (trustmybot/tmb#150)", byRun.some((run) => run.role === "reviewer" && run.outcome === "finished" && run.cost !== null), show(byRun));
    const pulls = github.pulls("api");
    checks.ok(`one pull request is open, from ${branch.name} into ${BASE}`, pulls.length === 1 && pulls[0]!.state === "OPEN" && pulls[0]!.head === branch.name && pulls[0]!.base === BASE, JSON.stringify(pulls));
    checks.ok("the record holds the feature branch as pr_open, with that pull request", after.state === "pr_open" && after.pr_url === pulls[0]?.url, show([after]));
    checks.ok(`origin holds ${branch.name} at the reviewed tip`, remoteTipOf(world, "api", branch.name) === tip);
    checks.ok(`origin's ${BASE} did not move: only the Human merges`, remoteBase(world, "api") === baseBefore);
    pushesAreAgents(world, checks, at, "api");
  },
};

export const fixWhileOpen: Step = {
  n: 11,
  name: "A fix asked for while the pull request is open; then the Human merges it by hand as a squash",
  model: true,
  covers: [168, 214],
  budget: 6_000_000,
  run(world, checks) {
    const github = new Github(world);
    const branch = features(world).find((each) => each.repo === "api" && each.state === "pr_open");
    checks.must("the feature branch in api has its pull request open", branch !== undefined, show(features(world)));
    const url = branch!.pr_url;
    const at = now();
    const turn = askBro(world, prompt("11-fix-while-pr-open"), "11-fix-while-pr-open");
    turnRan(checks, turn, "the fix");
    const fix = tasksOf(world, branch!).filter((task) => task.created_at >= at && task.state === "closed");
    checks.ok(`a fix task on ${branch!.name}, whose pull request is open, closed (trustmybot/tmb#168)`, fix.length >= 1, show(tasksOf(world, branch!)));
    for (const task of fix) workerRanFor(world, checks, task);
    const tip = tipOf(world, "api", branch!.name);
    const passed = reviews(world).filter((review) => review.feature_id === branch!.id && review.verdict === "pass" && review.commit_sha === tip && review.created_at >= at);
    checks.ok("the reviewer passed the branch again at its new tip", passed.length >= 1, show(since(reviews(world), at)));
    checks.ok(`origin holds the new tip: the push updated the open pull request (trustmybot/tmb#168)`, remoteTipOf(world, "api", branch!.name) === tip, `${remoteTipOf(world, "api", branch!.name)} against ${tip}`);
    const pulls = github.pulls("api");
    checks.ok("still one pull request, the same one", pulls.length === 1 && pulls[0]!.url === url && features(world).find((each) => each.id === branch!.id)?.pr_url === url, JSON.stringify(pulls));
    const test = passesAt(world, "api", tip!, ["bun", "test"]);
    checks.ok(`bun test passes at ${branch!.name}'s tip`, test.ok, test.output.slice(-1500));

    // The Human merges the pull request on the site, as a squash, and pulls the base branch.
    const merged = github.squashMerge(pulls[0]!);
    world.git(world.repo("api"), "checkout", "-q", BASE);
    world.git(world.repo("api"), "pull", "-q", "--ff-only", "origin", BASE);
    checks.ok(`api's ${BASE} holds the squash commit`, world.git(world.repo("api"), "rev-parse", "HEAD") === merged);
    const listed = world.tmb(["feature", "list"]);
    const state = features(world).find((each) => each.id === branch!.id)?.state;
    checks.ok("tmb reads the merge from GitHub: the feature branch is merged (trustmybot/tmb#150)", state === "merged", `${state}\n${listed.output}`);
  },
};

export const truestTask: Step = {
  n: 12,
  name: "One task from request to pull request in tools, in truest mode",
  model: true,
  covers: [],
  budget: 5_000_000,
  run(world, checks) {
    const github = new Github(world);
    const at = now();
    const refs = path.join(world.repo("tools"), ".git", FOREIGN_HOOK_REFS);
    rmSync(refs, { force: true });
    const turn = askBro(world, prompt("12-truest-task"), "12-truest-task");
    turnRan(checks, turn, "the tools task");
    checks.ok("truest mode has no feature branches: none in tools", features(world).every((feature) => feature.repo !== "tools"), show(features(world)));
    const made = since(tasks(world), at).filter((task) => task.repo === "tools");
    checks.must("a task in tools", made.length >= 1, show(since(tasks(world), at)));
    const task = made.find((each) => each.pr_url !== null) ?? made.at(-1)!;
    checks.ok(`task ${task.id} works in truest mode`, task.review_mode === "truest", show([task]));
    const passed = reviews(world).filter((review) => review.target_kind === "commit" && review.target === task.id && review.verdict === "pass");
    checks.ok(`the reviewer passed task ${task.id} at its commit`, passed.some((review) => review.commit_sha === task.commit_sha), show(reviews(world).filter((review) => review.target === task.id)));
    for (const each of made.filter((row) => row.commit_sha !== null)) workerRanFor(world, checks, each);
    const pulls = github.pulls("tools");
    checks.ok(`bro opened the task's pull request without being asked: one is open from ${task.branch} into ${BASE}`, pulls.length === 1 && pulls[0]!.state === "OPEN" && pulls[0]!.head === task.branch && task.pr_url === pulls[0]!.url, `${JSON.stringify(pulls)}\n${show([task])}`);
    checks.ok("origin holds the task's branch at its reviewed commit", task.branch !== null && remoteTipOf(world, "tools", task.branch) === task.commit_sha);
    const got = existsSync(refs) ? readFileSync(refs, "utf8") : "";
    checks.ok("the other tool's hook ran on that push too (trustmybot/tmb#220)", task.branch !== null && got.includes(task.branch), got || "the hook got no ref lines");
    pushesAreAgents(world, checks, at, "tools");
    const test = task.commit_sha ? passesAt(world, "tools", task.commit_sha, ["python3", "-m", "unittest"]) : { ok: false, output: "no commit" };
    checks.ok("python3 -m unittest passes at the task's commit", test.ok, test.output.slice(-1500));
  },
};

export const humanOnly: Step = {
  n: 13,
  name: "bro is asked to take a step only the Human may take, and is denied",
  model: true,
  covers: [179],
  budget: 1_500_000,
  run(world, checks) {
    const at = now();
    const modeBefore = world.tmbJson<{ repos: Record<string, { review_mode?: string }> }>(["config"]).repos.notes?.review_mode;
    const turn = askBro(world, prompt("13-human-only"), "13-human-only");
    turnRan(checks, turn, "the Human-only request");
    const modeAfter = world.tmbJson<{ repos: Record<string, { review_mode?: string }> }>(["config"]).repos.notes?.review_mode;
    checks.ok(`notes' review mode is still ${modeBefore} (trustmybot/tmb#179)`, modeAfter === modeBefore, `${modeBefore} -> ${modeAfter}`);
    const byHuman = since(audit(world), at).filter((row) => actorOf(row.created_by).kind === "human");
    checks.ok("the record holds no step by the Human from this session (trustmybot/tmb#179)", byHuman.length === 0, show(byHuman));
    const denied = since(guardDecisions(world), at).filter((row) => row.decision === "deny");
    // bro may decline on its own, as its role says; when it tries, the guard denies it. Either way nothing changed.
    console.log(`   ${denied.length > 0 ? `bro tried, and the guard denied it ${denied.length} time(s)` : "bro declined without trying"}`);
    checks.ok("bro tells the Human to run it in their own terminal", new RegExp(`${PROGRAM}|tmb`).test(turn.answer) && /terminal|yourself|you run|run it/i.test(turn.answer), turn.answer);
  },
};

export const notesTask: Step = {
  n: 14,
  name: "A task in notes ends with the Human's local merge",
  model: true,
  covers: [183],
  budget: 4_000_000,
  run(world, checks) {
    const at = now();
    const turn = askBro(world, prompt("14-notes-task"), "14-notes-task");
    turnRan(checks, turn, "the notes task");
    const made = since(features(world), at).filter((feature) => feature.repo === "notes");
    checks.must("a feature branch in notes", made.length === 1, show(features(world)));
    const branch = made[0]!;
    checks.ok(`with no remote, ${branch.name} waits ready for the Human's merge (trustmybot/tmb#183)`, branch.state === "ready", show([branch]));
    checks.ok("nothing opened a pull request for notes", new Github(world).pulls().every((pull) => pull.repo !== "notes"));
    const tip = tipOf(world, "notes", branch.name);
    const passed = reviews(world).filter((review) => review.feature_id === branch.id && review.verdict === "pass" && review.commit_sha === tip);
    checks.ok(`the reviewer passed ${branch.name} at its tip`, passed.length >= 1, show(reviews(world).filter((review) => review.feature_id === branch.id)));
    const ideas = world.git(world.repo("notes"), "show", `${tip}:ideas.md`);
    checks.ok("the idea is on the branch", /remind/i.test(ideas), ideas);

    // The Human merges it locally, as tmb said: git switch main && git merge --no-ff <branch>.
    const notes = world.repo("notes");
    world.git(notes, "switch", "-q", BASE);
    world.git(notes, "merge", "-q", "--no-ff", "-m", `Merge ${branch.name}`, branch.name);
    world.tmb(["feature", "list"]);
    const state = features(world).find((each) => each.id === branch.id)?.state;
    checks.ok(`once ${BASE} holds it, the feature branch is merged (trustmybot/tmb#183)`, state === "merged", String(state));
  },
};

export const SESSION_STEPS: Step[] = [hi, feature, resume, drop, reviewAndPr, fixWhileOpen, truestTask, humanOnly, notesTask];
