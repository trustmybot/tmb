// A task made before its project became a workspace names no repo: its runs and checks follow it,
// so they name none either. When init names the workspace's repos, each such task is given the
// repo the evidence points to, and one with no clear evidence is left for doctor to name
// (trustmybot/tmb#257).
import { runGit } from "./git.ts";
import { parseRemoteUrl } from "./github.ts";
import { repoDirOf, workingRepos } from "./repos.ts";
import type { RepoPolicies } from "./settings.ts";
import type { Actor, Store, Task } from "./store/index.ts";

/** The source an import from the plugin names; its detail holds the plugin repo it read and the ids it gave. */
export const PLUGIN_IMPORT = "plugin";

/** What a migration's import says, as far as a task's repo needs it. */
type MigrationDetail = { repo?: string | null; into?: string | null; ids?: { tasks?: Record<string, string> } };

/** Tasks that name no repo in a workspace; none in a project of one repo, where no task names one. */
export function tasksWithNoRepo(store: Store, repos: RepoPolicies | null): Task[] {
  if (repos === null || workingRepos(repos).length === 0) return [];
  return store.listTasks().filter((task) => task.repo === null);
}

/** The plugin repo each task migrated with no workspace repo came from, by task id. */
function migratedFrom(store: Store): Map<string, string> {
  const from = new Map<string, string>();
  for (const entry of store.listImports(PLUGIN_IMPORT)) {
    const detail = (entry.detail ?? {}) as MigrationDetail;
    if (typeof detail.repo !== "string" || (detail.into ?? null) !== null) continue;
    for (const id of Object.values(detail.ids?.tasks ?? {})) from.set(id, detail.repo);
  }
  return from;
}

function hasBranch(repoDir: string, branch: string): boolean {
  return ["refs/heads/", "refs/remotes/origin/"].some((prefix) => runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${prefix}${branch}`]).ok);
}

/** owner/name of a pull request's URL, or of a repo's origin, lower-cased; null when it names none. */
function pullRequestRepo(url: string): string | null {
  const found = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url.trim());
  return found === null ? null : `${found[1]}/${found[2]}`.toLowerCase();
}

function originRepo(repoDir: string): string | null {
  const url = runGit(repoDir, ["config", "--get", "remote.origin.url"]);
  const parsed = url.ok ? parseRemoteUrl(url.stdout) : null;
  return parsed === null ? null : `${parsed.owner}/${parsed.name}`.toLowerCase();
}

export type RepoEvidence = { repo: string; from: string };

/**
 * The workspace repo a task with no repo belongs to, and why; null when the evidence names no
 * single repo. Its proofs: the plugin repo it was migrated from, when the workspace has a repo of
 * that name; the one repo that holds its branch; the one repo whose origin its pull request is in.
 * The first proof is the one said; proofs that name different repos give none.
 */
export function evidenceOf(task: Task, projectDir: string, repos: RepoPolicies, migrated: ReadonlyMap<string, string>): RepoEvidence | null {
  const names = workingRepos(repos);
  const found: RepoEvidence[] = [];
  const plugin = migrated.get(task.id);
  if (plugin !== undefined && names.includes(plugin)) found.push({ repo: plugin, from: `it was migrated from the plugin's repo ${plugin}` });
  if (task.branch !== null) {
    const holding = names.filter((name) => hasBranch(repoDirOf(projectDir, name), task.branch!));
    if (holding.length === 1) found.push({ repo: holding[0]!, from: `its branch ${task.branch} is there` });
  }
  const wanted = task.prUrl === null ? null : pullRequestRepo(task.prUrl);
  if (wanted !== null) {
    const holding = names.filter((name) => originRepo(repoDirOf(projectDir, name)) === wanted);
    if (holding.length === 1) found.push({ repo: holding[0]!, from: `its pull request is in ${wanted}` });
  }
  // Two proofs that name different repos settle nothing: the task keeps no repo, and doctor lists it.
  if (found.length === 0 || new Set(found.map((evidence) => evidence.repo)).size > 1) return null;
  return found[0]!;
}

export type RepoGiven = { task: string; repo: string; from: string };

/** Gives each task with no repo the one the evidence names; returns what it gave and the tasks it left. */
export function giveTasksTheirRepos(store: Store, actor: Actor, projectDir: string, repos: RepoPolicies): { given: RepoGiven[]; left: Task[] } {
  const migrated = migratedFrom(store);
  const given: RepoGiven[] = [];
  const left: Task[] = [];
  for (const task of tasksWithNoRepo(store, repos)) {
    const evidence = evidenceOf(task, projectDir, repos, migrated);
    if (evidence === null) {
      left.push(task);
      continue;
    }
    store.updateTask(actor, task.id, { repo: evidence.repo });
    given.push({ task: task.id, ...evidence });
  }
  return { given, left };
}
