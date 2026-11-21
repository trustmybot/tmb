// Steps 9, 15 and 16: what the Human does by hand between sessions. None uses the model, so they
// run on every pull request with steps 0 to 4.
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { doctor, remoteBase, showFindings, type Step } from "../chain.ts";
import { FOREIGN_HOOK_REFS } from "../demo.ts";
import { chainVersions, publishDev } from "../release.ts";
import { BASE, PROGRAM, type RepoName, type Result, type World } from "../world.ts";

/** How many pushes the gate refused, by the record. */
function refusedPushes(world: World): number {
  const db = new Database(path.join(world.project, ".tmb", "trajectory.db"), { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM guard_decisions WHERE decision = 'deny' AND event LIKE '%before-push%'").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

export const handPush: Step = {
  n: 9,
  name: "A push typed by hand is refused, in the repo and in a folder below it",
  model: false,
  covers: [178, 201, 220, 225],
  run(world, checks) {
    const tmpBefore = new Set(readdirSync(world.tmp));
    const refusedBefore = refusedPushes(world);
    const below: Record<string, string> = { api: "src", tools: "todo_tools" };
    let shown = "";
    for (const repo of ["api", "tools"] as RepoName[]) {
      const dir = world.repo(repo);
      const before = remoteBase(world, repo);
      appendFileSync(path.join(dir, "README.md"), "\nEdited by hand, with no task.\n");
      world.git(dir, "commit", "-q", "-am", "Edited by hand");
      const commit = world.git(dir, "rev-parse", "--short=7", "HEAD");
      for (const [where, cwd] of [
        ["the repo", dir],
        ["a folder below it", path.join(dir, below[repo]!)],
      ] as const) {
        const push = world.run("git", ["push", "origin", BASE], { cwd });
        shown += `$ git push origin ${BASE}   (${repo}, in ${where})\n${push.output}\n`;
        checks.ok(`${repo}: a hand push of an unreviewed commit onto ${BASE}, typed in ${where}, is refused and names the commit (trustmybot/tmb#178)`, push.status !== 0 && /tmb refused the push/.test(push.output) && push.output.includes(commit), push.output);
      }
      checks.ok(`${repo}: origin's ${BASE} did not move`, remoteBase(world, repo) === before);
      // The Human puts the repo back as it was.
      world.git(dir, "reset", "-q", "--hard", before);
    }
    checks.ok("the record holds each refusal (trustmybot/tmb#201)", refusedPushes(world) - refusedBefore === 4, `${refusedPushes(world) - refusedBefore} refusals recorded`);

    // In tools, tmb's line runs first in the other tool's hook; a push the gate allows still
    // reaches that tool, with git's ref lines.
    const tools = world.repo("tools");
    const refs = path.join(tools, ".git", FOREIGN_HOOK_REFS);
    rmSync(refs, { force: true });
    const head = world.git(tools, "rev-parse", "HEAD");
    const branch = world.run("git", ["push", "origin", "HEAD:refs/heads/hand/scratch"], { cwd: tools });
    shown += `$ git push origin HEAD:refs/heads/hand/scratch   (tools)\n${branch.output}\n`;
    checks.ok("tools: a push of a branch that is not the base is allowed, and the other tool's hook still runs (trustmybot/tmb#220)", branch.status === 0 && branch.output.includes("lint: ok"), branch.output);
    const got = existsSync(refs) ? readFileSync(refs, "utf8") : "";
    checks.ok("tools: the other tool's hook gets git's ref lines after tmb's line read them (trustmybot/tmb#220)", got.includes("refs/heads/hand/scratch") && got.includes(head), got || "the hook got no ref lines");
    const gone = world.run("git", ["push", "-q", "origin", "--delete", "hand/scratch"], { cwd: tools });
    checks.ok("tools: the scratch branch is deleted from origin", gone.status === 0, gone.output);
    const left = readdirSync(world.tmp).filter((name) => !tmpBefore.has(name));
    checks.ok("tmb's line leaves no temporary file behind, on a refused push or an allowed one (trustmybot/tmb#225)", left.length === 0, left.join("\n"));
    world.log("09-hand-push.log", shown);
  },
};

/** Runs one of the host's hooks as Claude Code does, with its event on stdin. */
function hook(world: World, name: string, event: Record<string, unknown>): Result {
  return world.tmb(["hook", name], { input: JSON.stringify(event) });
}

export const update: Step = {
  n: 15,
  name: "tmb update while a session runs; the next session refreshes the project",
  model: false,
  covers: [128, 173, 188],
  run(world, checks) {
    const { first, next } = chainVersions();
    const version = () => world.tmb(["--version"], { cwd: world.home });
    const before = version();
    checks.must(`${PROGRAM} is at ${first} before the update`, before.stdout.startsWith(`${PROGRAM} ${first} `), before.output);
    // A session is running on the installed build when the newer one is published.
    const session = { session_id: "chain-step-15", transcript_path: path.join(world.tmp, "chain-step-15.jsonl"), cwd: world.project };
    const start = hook(world, "session-start", { ...session, hook_event_name: "SessionStart", source: "startup" });
    checks.must("a session starts in the project", start.status === 0, start.output);
    publishDev(world.release.dir, world.release.next, next, world.release.asset);
    const applied = world.tmb(["update"], { cwd: world.home });
    world.log("15-update.log", applied.output);
    checks.ok(`${PROGRAM} update applies ${next} at once, though a session runs and the project holds a record (trustmybot/tmb#173, trustmybot/tmb#188)`, applied.status === 0 && applied.stdout.includes(`from ${first} to ${next}`), applied.output);
    const after = version();
    checks.ok(`the installed ${PROGRAM} is ${next}`, after.stdout.startsWith(`${PROGRAM} ${next} `), after.output);
    const end = hook(world, "session-end", { ...session, hook_event_name: "SessionEnd", reason: "exit" });
    checks.ok("the session ends", end.status === 0, end.output);

    // The next session start brings the project's host files to the new build (trustmybot/tmb#128).
    const nextSession = { ...session, session_id: "chain-step-15-next" };
    const again = hook(world, "session-start", { ...nextSession, hook_event_name: "SessionStart", source: "startup" });
    world.log("15-session-start.log", again.output);
    let context = "";
    try {
      context = (JSON.parse(again.stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
    } catch {}
    checks.ok(`the next session start refreshes the host files from ${first} to ${next} and says so (trustmybot/tmb#128)`, again.status === 0 && context.includes(`refreshed this project's host files from ${PROGRAM} ${first} to ${next}`), context.slice(-800) || again.output);
    hook(world, "session-end", { ...nextSession, hook_event_name: "SessionEnd", reason: "exit" });
    const findings = doctor(world);
    const tie = findings.filter((finding) => finding.check === "program tie");
    checks.ok(`the project is tied to ${PROGRAM} ${next}`, tie.some((finding) => finding.status === "ok" && finding.summary.includes(`${PROGRAM} ${next}`)), showFindings(tie));
    const record = findings.filter((finding) => finding.check === "record");
    checks.ok(`${next} reads the record ${first} wrote`, record.some((finding) => finding.status === "ok"), showFindings(record));
    const inProject = world.tmb(["--version"]);
    checks.ok(`with no session running, a call in the project runs ${next}`, inProject.stdout.startsWith(`${PROGRAM} ${next} `), inProject.output);
  },
};

type TreeChild = { kind: "dir" | "file"; path: string; functions: number; notParsed?: string | null };
type Symbol = { id: number; name: string; unnamed: boolean; parent: number | string | null };

export const dashboard: Step = {
  n: 16,
  name: "The dashboard's Code page: the code as a graph, down to every function",
  model: false,
  covers: [142],
  async run(world, checks) {
    const child = Bun.spawn([PROGRAM, "dashboard", "--port", "0"], { cwd: world.project, env: world.env(), stdout: "pipe", stderr: "pipe" });
    try {
      const url = await readUrl(child.stdout);
      checks.must("tmb dashboard starts and says its address", url !== null);
      const get = async <T>(route: string): Promise<{ status: number; body: T | string }> => {
        const response = await fetch(`${url}${route}`);
        const text = await response.text();
        try {
          return { status: response.status, body: JSON.parse(text) as T };
        } catch {
          return { status: response.status, body: text };
        }
      };
      const page = await get<string>("/");
      checks.ok("the dashboard's page loads", page.status === 200 && String(page.body).includes("<script"), String(page.body).slice(0, 300));
      const repos = await get<{ repos: string[] }>("/api/graph/repos");
      checks.ok("the Code page offers each repo of the workspace", JSON.stringify((repos.body as { repos: string[] }).repos?.slice().sort()) === JSON.stringify(["api", "notes", "tools"]), JSON.stringify(repos.body));

      const tree = (await get<{ functions: number; children: TreeChild[] }>("/api/graph/tree?repo=api&path=.")).body as { functions: number; children: TreeChild[] };
      const summed = (tree.children ?? []).reduce((sum, each) => sum + each.functions, 0);
      // 12 functions as the demo app was built; more once the session steps merged their work.
      checks.ok("api's top level: every folder and file shows how many functions it holds, and they add up to all of api's", tree.functions >= 12 && summed === tree.functions && (tree.children ?? []).every((each) => typeof each.functions === "number"), JSON.stringify(tree).slice(0, 800));
      const lib = (await get<{ children: TreeChild[] }>("/api/graph/tree?repo=api&path=lib")).body as { children: TreeChild[] };
      checks.ok("the minified file is shown as a file marked not parsed", (lib.children ?? []).some((each) => each.path === "lib/todo-bundle.js" && /not parsed/.test(each.notParsed ?? "")), JSON.stringify(lib).slice(0, 600));
      const todo = (await get<{ symbols: Symbol[] }>("/api/graph/file?repo=api&path=src/todo.ts")).body as { symbols: Symbol[] };
      const unnamed = (todo.symbols ?? []).filter((symbol) => symbol.unnamed);
      checks.ok("src/todo.ts shows its unnamed functions, each inside its parent", unnamed.length > 0 && unnamed.every((symbol) => symbol.parent !== null), JSON.stringify(todo.symbols ?? todo).slice(0, 800));

      const search = (await get<{ hits: { id: number; path: string }[] }>("/api/graph/search?repo=api&q=handle")).body as { hits: { id: number; path: string }[] };
      const hit = (search.hits ?? []).find((each) => each.path === "src/server.ts");
      checks.must("the search box finds handle in src/server.ts", hit !== undefined, JSON.stringify(search));
      const view = await get<unknown>(`/api/graph/function/${hit!.id}?repo=api`);
      const text = JSON.stringify(view.body);
      world.log("16-function-view.json", JSON.stringify(view.body, null, 2));
      checks.ok("handle's view shows what it calls across the alias, the re-export and the package: addTodo and formatTodo", view.status === 200 && text.includes("addTodo") && text.includes("src/todo.ts") && text.includes("formatTodo") && text.includes("packages/format/src/index.ts"), text.slice(0, 1200));
      const tools = (await get<{ children: TreeChild[] }>("/api/graph/tree?repo=tools&path=.")).body as { children: TreeChild[] };
      checks.ok("tools' top level lists the Ruby file tmb does not read", (tools.children ?? []).some((each) => each.path === "report.rb"), JSON.stringify(tools).slice(0, 800));
    } finally {
      child.kill();
      await child.exited;
    }
  },
};

/** The dashboard's address, from the first line it prints. */
async function readUrl(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader();
  let text = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = /(http:\/\/[^\s]+)/.exec(text);
    if (found) {
      reader.releaseLock();
      return found[1]!.replace(/\/$/, "");
    }
    const read = await reader.read();
    if (read.done) return null;
    text += new TextDecoder().decode(read.value);
  }
  return null;
}

export const NO_MODEL_STEPS: Step[] = [handPush, update, dashboard];
