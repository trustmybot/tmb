// Steps 0 to 4: the commands the Human types to set tmb up. None uses the model.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { type Checks, doctor, showFindings, type Step } from "../chain.ts";
import { FOREIGN_HOOK } from "../demo.ts";
import { chainVersions } from "../release.ts";
import { callTools } from "../tool-server.ts";
import { PROGRAM, REPOS, type World } from "../world.ts";

/** tmb bugs the chain found, filed: their checks are marked known until each is fixed. */
const BUGS = {
  /** onboard says no review mode is chosen when every repo has its own. */
  onboardLastWord: 263,
};

const hookOf = (world: World, repo: string) => path.join(world.repo(repo as (typeof REPOS)[number]), ".git", "hooks", "pre-push");
const readIf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const runsPushGate = (hook: string) => /\bpre-push\b/.test(hook) && hook.includes(PROGRAM);

export const install: Step = {
  n: 0,
  name: "Install tmb in the empty container",
  model: false,
  covers: [],
  run(world, checks) {
    // As the install page says, in a shell opened before tmb is installed.
    const result = world.run("sh", ["-c", `curl -fsSL "$TMB_RELEASES_URL/releases/download/dev/install.sh" | sh`], { installedOnPath: false, cwd: world.home });
    world.log("00-install.log", result.output);
    checks.must("the install script exits 0", result.status === 0, result.output);
    checks.must(`it puts ${PROGRAM} at ~/.local/bin/${PROGRAM}`, existsSync(world.installed) && (statSync(world.installed).mode & 0o111) !== 0, result.output);
    const { first } = chainVersions();
    const version = world.tmb(["--version"]);
    checks.ok(`${PROGRAM} --version names the build under test on the dev channel`, version.status === 0 && version.stdout.startsWith(`${PROGRAM} ${first} `) && version.stdout.includes("on the dev channel"), version.output);
    const profile = readIf(path.join(world.home, ".profile"));
    checks.ok("it adds ~/.local/bin to the PATH in the shell's profile", profile.includes('export PATH="$HOME/.local/bin:$PATH"'), profile || "no ~/.profile");
  },
};

export const init: Step = {
  n: 1,
  name: "tmb init in the folder of three repos",
  model: false,
  covers: [162, 163, 167, 180, 184],
  run(world, checks) {
    const result = world.tmb(["init"]);
    world.log("01-init.log", result.output);
    checks.must("init exits 0 with no terminal and asks nothing (trustmybot/tmb#162)", result.status === 0, result.output);
    checks.ok("init says the review mode is the Human's choice and leaves it unset (trustmybot/tmb#162)", /review mode is chosen yet/.test(result.stdout), result.output);
    checks.must("init makes the record in the project folder", existsSync(path.join(world.project, ".tmb", "trajectory.db")));
    checks.ok("init runs no git init in a folder that holds repos (trustmybot/tmb#167)", !existsSync(path.join(world.project, ".git")));
    const config = world.tmbJson<{ repos: Record<string, { base_branch?: string }> | null }>(["config"]);
    checks.ok("the record names all three repos, each on main (trustmybot/tmb#163, trustmybot/tmb#167)", REPOS.every((repo) => config.repos?.[repo]?.base_branch === "main"), JSON.stringify(config.repos));
    for (const repo of ["api", "notes"]) checks.ok(`init writes the push gate's pre-push hook in ${repo} (trustmybot/tmb#163)`, runsPushGate(readIf(hookOf(world, repo))), readIf(hookOf(world, repo)));
    checks.ok("init leaves the other tool's pre-push hook in tools as it was (trustmybot/tmb#184)", readIf(hookOf(world, "tools")) === FOREIGN_HOOK, readIf(hookOf(world, "tools")));
    checks.ok("init says the push gate is off in tools and names the command that adds it (trustmybot/tmb#184)", /push gate is off in \S*tools/.test(result.stdout) && result.stdout.includes("--add-push-gate"), result.output);
    for (const repo of REPOS) checks.ok(`init indexes the code graph of ${repo} (trustmybot/tmb#163)`, result.stdout.includes(`Indexed the code graph of ${repo} from main`), result.output);
    for (const repo of REPOS) {
      const status = world.git(world.repo(repo), "status", "--porcelain", "--ignored=no");
      checks.ok(`git status in ${repo} lists none of tmb's files (trustmybot/tmb#180)`, status === "", status);
    }
    const mcp = JSON.parse(readIf(path.join(world.project, ".mcp.json")) || "{}") as { mcpServers?: { tmb?: { command?: string } } };
    checks.ok(`the host's tool server runs the installed ${PROGRAM}`, mcp.mcpServers?.tmb?.command === world.installed, JSON.stringify(mcp));
  },
};

export const doctorStep: Step = {
  n: 2,
  name: "tmb doctor on the fresh project, then with one thing broken on purpose",
  model: false,
  covers: [160, 257, 258],
  run(world, checks) {
    const fresh = doctor(world);
    world.log("02-doctor-fresh.log", showFindings(fresh));
    const of = (check: string) => fresh.filter((finding) => finding.check === check);
    checks.ok("doctor reports no failure on the fresh project (trustmybot/tmb#160)", fresh.every((finding) => finding.status !== "fail"), showFindings(fresh));
    checks.ok("the record is readable", of("record").some((finding) => finding.status === "ok"), showFindings(of("record")));
    checks.ok("the host files match", of("host files").some((finding) => finding.status === "ok" && /Claude Code/.test(finding.summary)), showFindings(of("host files")));
    checks.ok("doctor warns the push gate is off in tools, with the fix (trustmybot/tmb#184, trustmybot/tmb#258)", of("host files").some((finding) => finding.status === "warn" && /another tool's/.test(finding.summary) && /--add-push-gate/.test(finding.fix ?? "")), showFindings(of("host files")));
    checks.ok("doctor warns no review mode is chosen, naming tmb onboard", of("settings").some((finding) => finding.status === "warn" && /review mode is not chosen/.test(finding.summary) && /onboard/.test(finding.fix ?? "")), showFindings(of("settings")));
    for (const repo of REPOS) checks.ok(`doctor finds the code graph of ${repo} current`, of("code graph").some((finding) => finding.status === "ok" && finding.summary.includes(` of ${repo} is current`)), showFindings(of("code graph")));

    // Broken on purpose: the push hook in api goes missing, as when a repo is cloned again.
    const hook = hookOf(world, "api");
    rmSync(hook);
    const broken = doctor(world).filter((finding) => finding.check === "host files" && finding.status !== "ok");
    world.log("02-doctor-broken.log", showFindings(broken));
    const named = broken.find((finding) => (finding.details ?? []).some((detail) => /pre-push hook is missing/.test(detail) && detail.includes(world.repo("api"))));
    checks.ok("with api's push hook gone, doctor says the push gate is off in api and names the fix (trustmybot/tmb#257)", named !== undefined && /init/.test(named.fix ?? ""), showFindings(broken));
    // The Human follows doctor's fix.
    const again = world.tmb(["init"]);
    world.log("02-init-again.log", again.output);
    checks.ok("running init again, as doctor says, exits 0", again.status === 0, again.output);
    checks.ok("init again puts the push hook back in api", runsPushGate(readIf(hook)), readIf(hook));
    const mended = doctor(world).filter((finding) => finding.check === "host files" && finding.status !== "ok");
    checks.ok("doctor no longer says api's push hook is missing", !showFindings(mended).includes(`missing in ${world.repo("api")}`), showFindings(mended));
  },
};

export const onboard: Step = {
  n: 3,
  name: "tmb onboard: a review mode per repo; no task can start before it",
  model: false,
  covers: [120, 216, 223],
  async run(world, checks) {
    // Before onboarding, the planner cannot start a task, and cannot choose the mode for the Human.
    const [issue] = await callTools(world, [{ name: "issue_create", args: { title: "Check the review mode gate", body: "Opened by the chain before onboarding; closed after it." } }]);
    const issueId = (issue?.json as { id?: string } | null)?.id;
    checks.must("the planner can record an issue before onboarding", issue?.ok === true && typeof issueId === "string", issue?.text);
    const probe = { issue_id: issueId, kind: "code", repo: "api", intent: "Probe the review mode gate.", files: ["api/README.md"], criteria: ["It is refused."] };
    const [start, choose] = await callTools(
      world,
      [
        { name: "task_start", args: probe },
        { name: "settings_set", args: { review_mode: "agile" } },
      ],
      { TMB_UNATTENDED: "1" },
    );
    checks.ok("no task starts before the review mode is chosen, and the refusal names tmb onboard (trustmybot/tmb#120)", start?.ok === false && /review mode/.test(start.text) && /onboard/.test(start.text), start?.text);
    checks.ok("an unattended planner cannot choose the review mode (trustmybot/tmb#223)", choose?.ok === false && /Human/.test(choose.text), choose?.text);
    const typed = world.tmb(["onboard", "--repo", "api", "--review-mode", "agile", "--yes"]);
    checks.ok("onboard --review-mode with no terminal is refused as the Human's step (trustmybot/tmb#179)", typed.status !== 0 && /only the Human/.test(typed.output), typed.output);

    // The Human onboards, on a terminal, one repo at a time.
    const steps: [string, string[]][] = [
      ["api", ["--repo", "api", "--review-mode", "agile", "--check", "bun test"]],
      ["tools", ["--repo", "tools", "--review-mode", "truest", "--check", "python3 -m unittest", "--add-push-gate"]],
      ["notes", ["--repo", "notes", "--review-mode", "agile"]],
    ];
    let shown = "";
    for (const [repo, args] of steps) {
      const run = world.human(["onboard", ...args, "--yes"]);
      shown += run.output;
      checks.must(`the Human onboards ${repo} on a terminal`, run.status === 0, run.output);
    }
    world.log("03-onboard.log", shown);
    const config = world.tmbJson<{ repos: Record<string, { review_mode?: string; checks?: string[] }> }>(["config"]);
    const modes = Object.fromEntries(REPOS.map((repo) => [repo, config.repos[repo]?.review_mode]));
    checks.ok("each repo keeps its own review mode: api agile, tools truest, notes agile (trustmybot/tmb#216)", modes.api === "agile" && modes.tools === "truest" && modes.notes === "agile", JSON.stringify(modes));
    checks.ok("api's and tools' checks are the ones the Human gave", config.repos.api?.checks?.join() === "bun test" && config.repos.tools?.checks?.join() === "python3 -m unittest", JSON.stringify(config.repos));
    const change = world.tmb(["onboard", "--repo", "api", "--review-mode", "truest", "--yes"], { env: { TMB_UNATTENDED: "1" } });
    const after = world.tmbJson<{ repos: Record<string, { review_mode?: string }> }>(["config"]).repos.api?.review_mode;
    checks.ok("a run in unattended mode cannot change a review mode the Human chose (trustmybot/tmb#223)", change.status !== 0 && after === "agile", `${change.output}api's mode is now ${after}`);
    const toolsHook = readIf(hookOf(world, "tools"));
    checks.ok("--add-push-gate puts the push gate first in tools' hook and keeps the other tool's line (trustmybot/tmb#184)", runsPushGate(toolsHook.split("\n")[1] ?? "") && toolsHook.includes('echo "lint: ok"'), toolsHook);
    const settings = doctor(world).filter((finding) => finding.check === "settings");
    checks.ok("doctor no longer warns about the review mode", settings.every((finding) => finding.status === "ok"), showFindings(settings));
    const lastWord = shown.split("Settings in the record:").at(-1) ?? "";
    const saysNoMode = /no task starts yet/.test(lastWord);
    checks.known(BUGS.onboardLastWord, "onboard does not say no task starts once every repo has its own mode", !saysNoMode, lastWord);

    const close = world.tmb(["issue", "close", issueId!]);
    checks.ok("the Human closes the gate's issue", close.status === 0, close.output);
  },
};

type Expected = Record<string, { files: number; functions: number; notParsed: number; notRead: string }>;

export const index: Step = {
  n: 4,
  name: "tmb index: every function, unread languages counted, the minified file not parsed, alias and re-export links",
  model: false,
  covers: [140, 147, 232, 233, 234],
  async run(world, checks) {
    const result = world.tmb(["index"]);
    world.log("04-index.log", result.output);
    checks.must("tmb index exits 0", result.status === 0, result.output);
    const expected = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "demo-app", "expected.json"), "utf8")) as { index: Expected };
    for (const repo of REPOS) {
      const want = expected.index[repo]!;
      const line = result.stdout.split("\n").find((each) => each.startsWith(`Indexed ${repo} from `)) ?? "";
      const files = Number(/: (\d+) files,/.exec(line)?.[1] ?? -1);
      const functions = Number(/, (\d+) functions[,;]/.exec(line)?.[1] ?? -1);
      const notParsed = Number(/; (\d+) files? not parsed/.exec(line)?.[1] ?? -1);
      const notRead = /not read: ([^;.]+)/.exec(line)?.[1]?.trim() ?? "";
      checks.ok(`${repo}: ${want.files} files and ${want.functions} functions, unnamed ones included (trustmybot/tmb#140)`, files === want.files && functions === want.functions, line || result.output);
      checks.ok(`${repo}: ${want.notParsed} file(s) not parsed (trustmybot/tmb#232)`, notParsed === want.notParsed, line);
      checks.ok(`${repo}: languages tmb does not read are counted: ${want.notRead || "none"} (trustmybot/tmb#234)`, notRead === want.notRead, line);
    }
    const [handle, plan, addItem, bundle] = await callTools(world, [
      { name: "graph_symbol", args: { name: "handle", path: "src/server.ts", repo: "api" } },
      { name: "graph_symbol", args: { name: "planRelease", repo: "api" } },
      { name: "graph_symbol", args: { name: "add_item", path: "todo_cli.py", repo: "tools" } },
      { name: "graph_map", args: { path: "lib", repo: "api" } },
    ]);
    type Card = { symbol: { path: string }; callees: { name: string; resolution: string; target: { path: string } | null }[] };
    const callee = (answer: typeof handle, name: string) => ((answer?.json as { cards?: Card[] } | null)?.cards?.[0]?.callees ?? []).find((each) => each.name === name);
    const linked = (answer: typeof handle, name: string, file: string) => {
      const found = callee(answer, name);
      return found?.resolution === "exact" && found.target?.path === file;
    };
    checks.ok("a call through the path alias and the re-export links to the declaration in src/todo.ts (trustmybot/tmb#147, trustmybot/tmb#233)", linked(handle, "addTodo", "src/todo.ts") && linked(handle, "countOpen", "src/todo.ts"), handle?.text.slice(0, 1500));
    checks.ok("a call to the package inside the repo links to packages/format (trustmybot/tmb#147)", linked(handle, "formatTodo", "packages/format/src/index.ts"), handle?.text.slice(0, 1500));
    checks.ok("a Python call through the package's re-export links to todo_tools/store.py (trustmybot/tmb#233)", linked(addItem, "load", "todo_tools/store.py") && linked(addItem, "save", "todo_tools/store.py"), addItem?.text.slice(0, 1500));
    checks.ok("source in a folder named build is in the graph (trustmybot/tmb#234)", (plan?.json as { cards?: Card[] } | null)?.cards?.[0]?.symbol.path === "src/build/plan.ts", plan?.text.slice(0, 800));
    const graph = new Database(path.join(world.project, ".tmb", "graphs", "api.db"), { readonly: true });
    const marked = graph.query("SELECT path, parse_error FROM files WHERE parse_error IS NOT NULL").all() as { path: string; parse_error: string }[];
    graph.close();
    const shown = bundle?.ok === true && /lib\/todo-bundle\.js/.test(bundle.text);
    checks.ok("the minified file is kept as a file, found by path and marked \"minified; not parsed\" (trustmybot/tmb#232)", shown && marked.length === 1 && marked[0]!.path === "lib/todo-bundle.js" && /minified/.test(marked[0]!.parse_error), `${JSON.stringify(marked)}\n${bundle?.text.slice(0, 600)}`);

    // The Human's own lookups, typed in the project folder and in a repo's folder.
    const atRoot = world.tmb(["graph", "symbol", "handle", "--repo", "api"]);
    const inRepo = world.tmb(["graph", "symbol", "handle"], { cwd: world.repo("api") });
    const works = atRoot.status === 0 && inRepo.status === 0 && /src\/server\.ts/.test(atRoot.stdout + inRepo.stdout);
    checks.ok("tmb graph names a repo in a workspace, typed at its root or in the repo (trustmybot/tmb#262)", works, `${atRoot.output}${inRepo.output}`);
  },
};

export const SETUP_STEPS: Step[] = [install, init, doctorStep, onboard, index];
export type { Checks };
