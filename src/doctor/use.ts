// Whether tmb is being used and its record is whole (trustmybot/tmb#257): work that went around
// it, a plugin record that holds more than came across, runs with no cost, tasks that name no repo
// in a workspace, and worktrees a session can work in with none of tmb's wiring. Each reads only
// and is a warning at most: tmb does not own the repos, and a push typed by hand stays allowed.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { findPluginDb, MIGRATION_AUDIT } from "../adapters/claude-code/migrate-plugin.ts";
import { detectBaseBranch } from "../engine/base-branch.ts";
import { runGit } from "../engine/git.ts";
import { parseRemoteUrl } from "../engine/github.ts";
import { inGitWorkTree, repoDirOf, scanRepos, unnamedRepos, workingRepos } from "../engine/repos.ts";
import type { Settings } from "../engine/settings.ts";
import type { Store } from "../engine/store/index.ts";
import { tasksWithNoRepo } from "../engine/task-repos.ts";
import type { DoctorEnv, Finding } from "./types.ts";

const finding = (check: string, rest: Omit<Finding, "check" | "scope">): Finding => ({ check, scope: "project", ...rest });

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The repos the project's work happens in: a workspace's named repos, a folder's unnamed ones, or the project folder (named null). */
function reposOf(projectDir: string, settings: Settings): (string | null)[] {
  if (settings.repos !== null) return workingRepos(settings.repos);
  if (!inGitWorkTree(projectDir)) return scanRepos(projectDir);
  return [null];
}

function baseOf(projectDir: string, settings: Settings, repo: string | null): string | null {
  const set = repo === null ? settings.base_branch : (settings.repos?.[repo]?.base_branch ?? null);
  return set ?? detectBaseBranch(repoDirOf(projectDir, repo));
}

/** owner/name of a repo's origin, lower-cased; null when origin names no GitHub repository. */
function originOf(repoDir: string): string | null {
  const url = runGit(repoDir, ["config", "--get", "remote.origin.url"]);
  const parsed = url.ok ? parseRemoteUrl(url.stdout) : null;
  return parsed === null ? null : `${parsed.owner}/${parsed.name}`.toLowerCase();
}

/** The pull request numbers the record's tasks and feature branches opened, per owner/name. */
function recordedPulls(store: Store): Map<string, Set<number>> {
  const byRepo = new Map<string, Set<number>>();
  for (const url of store.pullRequestUrls()) {
    const found = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.trim());
    if (found === null) continue;
    const key = `${found[1]}/${found[2]}`.toLowerCase();
    byRepo.set(key, (byRepo.get(key) ?? new Set()).add(Number(found[3])));
  }
  return byRepo;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Commits on each repo's base branch, and pull requests merged where gh is signed in, since the
 * newest task in the record, with no task: a commit or pull request that names one of the record's
 * pull requests is the record's own.
 */
export function workAroundCheck(env: DoctorEnv, projectDir: string, store: Store, settings: Settings): Finding {
  const newest = store.newestTaskAt();
  const since = newest ?? store.firstEntryAt();
  if (since === null) return finding("work around tmb", { status: "ok", summary: "the record is empty, so there is nothing to compare the repos with" });
  const from = newest === null ? `since the record was made (${dayOf(since)})` : `since the newest task in the record (${dayOf(since)})`;
  const recorded = recordedPulls(store);
  const details: string[] = [];
  const gitAlone: string[] = [];
  let commits = 0;
  let pulls = 0;
  for (const repo of reposOf(projectDir, settings)) {
    const dir = repoDirOf(projectDir, repo);
    const base = baseOf(projectDir, settings, repo);
    if (base === null) continue;
    const origin = originOf(dir);
    const ours = origin === null ? new Set<number>() : (recorded.get(origin) ?? new Set<number>());
    const ref = runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]).ok ? `origin/${base}` : base;
    const log = runGit(dir, ["log", "--first-parent", `--since=${since}`, "--format=%ct %s", ref, "--"]);
    // git's --since is to the second and inclusive: a commit is after the record's newest only when strictly later.
    const after = Date.parse(since);
    const subjects = (log.ok && log.stdout !== "" ? log.stdout.split("\n") : [])
      .map((line) => /^(\d+) (.*)$/.exec(line))
      .filter((found): found is RegExpExecArray => found !== null && Number(found[1]) * 1000 > after)
      .map((found) => found[2]!);
    const named = (subject: string) => [...subject.matchAll(/#(\d+)\b/g)].some((match) => ours.has(Number(match[1])));
    const repoCommits = subjects.filter((subject) => !named(subject)).length;
    let repoPulls: number | null = null;
    const merged = env.mergedPulls?.(dir, since);
    if (merged === undefined) gitAlone.push("gh is not signed in");
    else if ("why" in merged) gitAlone.push(merged.why);
    else repoPulls = merged.numbers.filter((number) => !ours.has(number)).length;
    commits += repoCommits;
    pulls += repoPulls ?? 0;
    if (repoCommits > 0 || (repoPulls ?? 0) > 0) {
      const parts = [plural(repoCommits, `commit on ${base}`, `commits on ${base}`), ...(repoPulls === null ? [] : [plural(repoPulls, "pull request merged", "pull requests merged")])];
      details.push(`${repo ?? path.basename(projectDir)}: ${parts.join(", ")}`);
    }
  }
  const alone = gitAlone.length === 0 ? "" : ` (git alone: ${[...new Set(gitAlone)].join("; ")})`;
  if (commits === 0 && pulls === 0) return finding("work around tmb", { status: "ok", summary: `no commit or pull request on a base branch ${from} went around the record${alone}` });
  const counted = [plural(commits, "commit"), ...(pulls > 0 ? [plural(pulls, "pull request merged", "pull requests merged")] : [])].join(" and ");
  return finding("work around tmb", {
    status: "warn",
    summary: `${counted} ${from}, with no task${newest === null ? ": the record holds none" : ""}${alone}`,
    details,
    fix: { say: "shown only: work the planner starts gets a task; a push typed by hand is still allowed, and the record does not hold it" },
  });
}

type RepoCounts = { issues: number; tasks: number; runs: number };

/** What the plugin's record holds per plugin repo; a repo of null counts what names none. */
function pluginCounts(file: string): Map<string | null, RepoCounts> | null {
  let db: Database;
  try {
    db = new Database(file, { readonly: true });
  } catch {
    return null;
  }
  try {
    const counts = new Map<string | null, RepoCounts>();
    const at = (repo: string | null) => {
      const row = counts.get(repo) ?? { issues: 0, tasks: 0, runs: 0 };
      counts.set(repo, row);
      return row;
    };
    const taskRepo = "coalesce(t.repo, i.repo)";
    for (const row of db.query("SELECT repo, count(*) AS n FROM issues WHERE id <> -1 GROUP BY repo").all() as { repo: string | null; n: number }[]) at(row.repo).issues = row.n;
    for (const row of db.query(`SELECT ${taskRepo} AS repo, count(*) AS n FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id GROUP BY 1`).all() as { repo: string | null; n: number }[]) {
      at(row.repo).tasks = row.n;
    }
    for (const row of db
      .query(`SELECT ${taskRepo} AS repo, count(*) AS n FROM agent_runs a JOIN tasks t ON t.id = a.task_id LEFT JOIN issues i ON i.id = t.issue_id GROUP BY 1`)
      .all() as { repo: string | null; n: number }[]) {
      at(row.repo).runs = row.n;
    }
    return counts;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function countsLine(counts: RepoCounts): string {
  return [plural(counts.issues, "issue"), plural(counts.tasks, "task"), plural(counts.runs, "run")].join(", ");
}

/**
 * A plugin record beside this one that holds repos no migration brought over: their counts, and
 * the steps that bring them, init first when the folder's repos are not named yet.
 */
export function pluginHistoryCheck(env: DoctorEnv, projectDir: string, store: Store, settings: Settings): Finding {
  const file = findPluginDb(projectDir);
  if (file === null) return finding("plugin history", { status: "ok", summary: "no plugin record beside this one" });
  const counts = pluginCounts(file);
  if (counts === null) return finding("plugin history", { status: "ok", summary: `the plugin record at ${file} could not be read, so what it holds is not compared` });
  const earlier = store.listAuditAbout(MIGRATION_AUDIT).map((entry) => {
    try {
      return (JSON.parse(entry.detail) as { repo?: string | null }).repo ?? null;
    } catch {
      return null;
    }
  });
  const named = [...counts.keys()].filter((repo): repo is string => repo !== null).sort();
  const program = env.program.name;
  const single = settings.repos === null && inGitWorkTree(projectDir);
  let left: string[];
  if (single) {
    // A project of one repo takes one plugin repo: the folder's namesake, or the plugin's only one.
    const folder = path.basename(projectDir);
    const wanted = named.includes(folder) ? folder : named.length === 1 ? named[0]! : null;
    left = earlier.length > 0 || (wanted === null && named.length > 0) ? [] : [wanted ?? ""];
  } else {
    // A migration of a plugin with one repo or none records no repo: it brought everything.
    left = earlier.includes(null) ? [] : named.filter((repo) => !earlier.includes(repo));
  }
  left = left.filter((repo) => {
    const row = counts.get(repo === "" ? null : repo);
    return row !== undefined && row.issues + row.tasks + row.runs > 0;
  });
  if (left.length === 0) return finding("plugin history", { status: "ok", summary: `the plugin record at ${file} holds nothing this record lacks` });
  const details = left.map((repo) => `${repo === "" ? "the plugin's record" : `plugin repo ${repo}`}: ${countsLine(counts.get(repo === "" ? null : repo)!)}`);
  let say: string;
  if (single) {
    say = store.listIssues().length + store.listTasks().length === 0 ? `\`${program} migrate\`` : `shown only: \`${program} migrate\` fills only a new record, and this one holds issues or tasks`;
  } else if (unnamedRepos(projectDir, settings.repos).length > 0) {
    // Migrate by repo needs the workspace's repos named first (trustmybot/tmb#257, point 8).
    say = `two steps: \`${program} init\` again in the project folder, which names its repos; then ${left.map((repo) => `\`${program} migrate --repo ${repo}\``).join(", ")}`;
  } else {
    const repos = settings.repos ?? {};
    say = left.map((repo) => `\`${program} migrate --repo ${repo}${repos[repo] === undefined ? " --into <workspace repo>" : ""}\``).join(", ");
  }
  return finding("plugin history", {
    status: "warn",
    summary: `the plugin record at ${file} holds ${plural(left.length, "repo")} no migration brought here`,
    details,
    fix: { say },
  });
}

/** Ended runs that carry no cost, as a count and a share. */
export function costCheck(store: Store): Finding {
  const { ended, withoutCost } = store.runCostCounts();
  if (withoutCost === 0) return finding("run costs", { status: "ok", summary: ended === 0 ? "no run has ended yet" : `every one of ${plural(ended, "ended run")} carries its cost` });
  const share = Math.round((withoutCost / ended) * 100);
  return finding("run costs", {
    status: "warn",
    summary: `${withoutCost} of ${plural(ended, "ended run")} (${share}%) carry no cost`,
    fix: { say: "shown only: the host reported no cost for those runs, so what the work cost is not whole" },
  });
}

/** Tasks that name no repo in a workspace: made before it became one, and not placed since. */
export function repoOfTasksCheck(env: DoctorEnv, store: Store, settings: Settings): Finding {
  const tasks = tasksWithNoRepo(store, settings.repos);
  if (tasks.length === 0) return finding("task repos", { status: "ok", summary: settings.repos === null ? "a project of one repo: its tasks need no repo named" : "every task names its repo" });
  return finding("task repos", {
    status: "warn",
    summary: `${plural(tasks.length, "task names", "tasks name")} no repo, so ${tasks.length === 1 ? "its" : "their"} runs and checks name none either`,
    details: tasks.map((task) => `task ${task.id} "${task.title}"`),
    fix: { say: `\`${env.program.name} init\` again gives each task the repo its migration, branch or pull request shows; one that nothing shows stays as it is` },
  });
}

/** The worktrees git lists for a repo, the repo's own folder left out. */
function worktreesOf(repoDir: string): string[] {
  const listed = runGit(repoDir, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return [];
  const paths = listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return paths.slice(1);
}

function within(dir: string, parent: string): boolean {
  const relative = path.relative(parent, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Worktrees outside the project folder that the host's files do not wire: a session started in one
 * works with none of tmb's hooks or tool server. Worktrees of the record's tasks are tmb's own.
 */
export function unwiredWorktreesCheck(env: DoctorEnv, projectDir: string, store: Store, settings: Settings, command: readonly string[]): Finding {
  const ids = [...new Set([...Object.keys(settings.host_roles ?? {}), ...(settings.host === null ? [] : [settings.host])])];
  const adapters = env.adapters.filter((adapter) => ids.includes(adapter.id) && adapter.wiringGaps !== undefined);
  if (adapters.length === 0) return finding("unwired sessions", { status: "ok", summary: "no host here whose files this tmb can check" });
  const tasks = new Set(store.listTasks().flatMap((task) => (task.worktree === null ? [] : [path.resolve(task.worktree)])));
  const unwired: string[] = [];
  for (const repo of reposOf(projectDir, settings)) {
    for (const dir of worktreesOf(repoDirOf(projectDir, repo))) {
      if (!existsSync(dir) || within(dir, projectDir) || tasks.has(path.resolve(dir))) continue;
      const missing = adapters.filter((adapter) => adapter.wiringGaps!(dir, command).length > 0).map((adapter) => adapter.name);
      if (missing.length > 0) unwired.push(`${dir}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not wired there`);
    }
  }
  if (unwired.length === 0) return finding("unwired sessions", { status: "ok", summary: "no worktree outside the project folder lacks tmb's wiring" });
  return finding("unwired sessions", {
    status: "warn",
    summary: `${plural(unwired.length, "worktree")} outside the project folder ${unwired.length === 1 ? "has" : "have"} none of tmb's wiring: a session started there works without tmb's hooks or tool server`,
    details: unwired,
    fix: { say: "shown only: start sessions in the project folder, or let the planner start tasks, whose worktrees tmb makes" },
  });
}
