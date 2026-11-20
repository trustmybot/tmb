// A workspace: a project folder that is not a git work tree and holds several repos, which share
// one record (trustmybot/tmb#163). The record keeps each repo's policy in the repos setting, so no
// call scans or guesses: a repo comes from the task or feature that names it, then from the repo a
// call names, then from the git top level of the folder a command acts in, never from cwd alone.
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { runGit } from "./git.ts";
import { HandlerError } from "./handlers/errors.ts";
import { readSettings, type RepoPolicies, type RepoPolicy } from "./settings.ts";
import type { Store } from "./store/index.ts";

/** How deep under the workspace folder a scan looks for repos: its folders and theirs. */
export const SCAN_DEPTH = 2;
const SKIPPED = new Set(["node_modules"]);

/** A repo a feature or task works in: its name in the workspace (null for the project folder itself), its folder and its policy. */
export type Repo = { name: string | null; dir: string; baseBranch: string | null; checks: string[] };

function isDirectory(file: string): boolean {
  return statSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** Whether `dir` is inside a git work tree. */
export function inGitWorkTree(dir: string): boolean {
  const result = runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout === "true";
}

/** What a scan of a workspace finds: its repos, and its top-level folders that are no repo and hold none. */
export type Scan = { repos: string[]; folders: string[] };

/**
 * The folders under a workspace folder, by name. A repo is a folder up to SCAN_DEPTH down whose
 * .git is a folder, a repo's own checkout; a .git file is a linked worktree or a submodule, never a
 * repo of its own, and is skipped. A top-level folder that is no repo and holds none is recorded as a folder, such as
 * one of test material. A scan does not go into a repo it found, a dot-folder or node_modules.
 */
export function scanWorkspace(workspaceDir: string): Scan {
  const scan: Scan = { repos: [], folders: [] };
  const nameOf = (dir: string) => path.relative(workspaceDir, dir).split(path.sep).join("/");
  const walk = (dir: string, depth: number): number => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return 0;
    }
    let found = 0;
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIPPED.has(entry)) continue;
      const child = path.join(dir, entry);
      if (!isDirectory(child)) continue;
      if (isDirectory(path.join(child, ".git"))) {
        scan.repos.push(nameOf(child));
        found++;
        continue;
      }
      // A linked worktree or a submodule belongs to a repo found elsewhere: neither a repo nor a folder.
      if (statSync(path.join(child, ".git"), { throwIfNoEntry: false }) !== undefined) continue;
      const inside = depth < SCAN_DEPTH ? walk(child, depth + 1) : 0;
      if (depth === 1 && inside === 0) scan.folders.push(nameOf(child));
      found += inside;
    }
    return found;
  };
  walk(workspaceDir, 1);
  scan.repos.sort();
  return scan;
}

/** The repos under a workspace folder, by name. */
export function scanRepos(workspaceDir: string): string[] {
  return scanWorkspace(workspaceDir).repos;
}

/** The workspace's repos as the record holds them, or null in a single-repo project. */
export function workspaceRepos(store: Store): RepoPolicies | null {
  return readSettings(store).repos;
}

/** The folder of a repo by its name; null names the project folder itself. */
export function repoDirOf(projectDir: string, name: string | null): string {
  return name === null ? projectDir : path.join(projectDir, ...name.split("/"));
}

function repoFrom(projectDir: string, name: string, policy: RepoPolicy): Repo {
  return { name, dir: repoDirOf(projectDir, name), baseBranch: policy.base_branch ?? null, checks: policy.checks ?? [] };
}

/** The project folder as its one repo, with the project's own base branch and checks. */
function projectRepo(store: Store, projectDir: string): Repo {
  const settings = readSettings(store);
  return { name: null, dir: projectDir, baseBranch: settings.base_branch, checks: settings.checks ?? [] };
}

function listNames(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

/** Whether tmb manages a recorded folder: a repo, not exempt. */
export function isManaged(policy: RepoPolicy): boolean {
  return policy.git !== false && policy.exempt !== true;
}

/** The repos a feature or task may be cut in: registered repos tmb manages. */
export function workingRepos(repos: RepoPolicies): string[] {
  return Object.keys(repos).filter((name) => isManaged(repos[name]!));
}

/** The name of a single-repo project's one repo, the project folder itself. */
export const PROJECT_REPO = ".";

/**
 * The repo a call works in: the one it names, else the only one. In a single-repo project, the
 * project folder, and a named repo is refused. In a workspace with several repos and none named,
 * refuses and lists them: tmb never picks one.
 */
export function resolveRepo(store: Store, projectDir: string, named: string | undefined): Repo {
  const repos = workspaceRepos(store);
  if (repos === null) {
    // A single-repo project is a project of one repo, the project folder, named ".".
    if (named !== undefined && named.trim().replace(/[\\/]+$/, "") !== PROJECT_REPO) {
      throw new HandlerError("not_found", `no repo ${JSON.stringify(named)} in this project; its one repo is ${PROJECT_REPO}, the project folder`);
    }
    return projectRepo(store, projectDir);
  }
  const working = workingRepos(repos);
  if (named !== undefined) {
    const name = named.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const policy = repos[name];
    if (policy === undefined) throw new HandlerError("not_found", `no repo ${JSON.stringify(named)} in this workspace; its repos are ${listNames(working)}`);
    if (policy.git === false) throw new HandlerError("refused", `the folder ${name} is not a repo, so tmb does no work in it; its repos are ${listNames(working)}`);
    if (policy.exempt === true) throw new HandlerError("refused", `the repo ${name} is exempt, so tmb does no work in it; its other repos are ${listNames(working.filter((other) => other !== name))}`);
    return repoFrom(projectDir, name, policy);
  }
  if (working.length === 1) return repoFrom(projectDir, working[0]!, repos[working[0]!]!);
  if (working.length === 0) throw new HandlerError("refused", "this workspace has no repo tmb works in; run `tmb init` in it to find its repos");
  throw new HandlerError("refused", `this workspace has ${working.length} repos (${working.join(", ")}); name the one this works in with repo`);
}

/**
 * The repo a feature or task was cut in, as the record holds it. A repo no longer registered keeps
 * its folder, so its work can still close; its policy is then empty.
 */
export function repoOfRow(store: Store, projectDir: string, row: { repo: string | null }): Repo {
  if (row.repo === null) return projectRepo(store, projectDir);
  const policy = workspaceRepos(store)?.[row.repo];
  return policy === undefined ? { name: row.repo, dir: repoDirOf(projectDir, row.repo), baseBranch: null, checks: [] } : repoFrom(projectDir, row.repo, policy);
}

function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * The repo a folder is in, from git's top level: the project folder itself in a single-repo
 * project; in a workspace, the registered repo whose folder that is. Null when the folder is in no
 * git work tree, or in one the record does not register (or registers as exempt): tmb has no
 * policy there and judges nothing. A task worktree belongs to the repo it was cut from.
 * In a single-repo project, always the project folder.
 */
export function repoOf(store: Store, projectDir: string, dir: string): Repo | null {
  const repos = workspaceRepos(store);
  // A single-repo project judges every push from its record's folder, as it always has.
  if (repos === null) return projectRepo(store, projectDir);
  const top = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  // A linked worktree's top level is itself; the repo is the one its common git folder belongs to.
  const common = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repoTop = common.ok && path.basename(common.stdout) === ".git" ? path.dirname(common.stdout) : top.stdout;
  const relative = path.relative(real(projectDir), real(repoTop));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const name = relative.split(path.sep).join("/");
  const policy = repos[name];
  return policy === undefined || !isManaged(policy) ? null : repoFrom(projectDir, name, policy);
}

/** The checks every task in a repo runs: the project's own in a single-repo project, else the repo's. */
export function repoChecks(store: Store, repo: string | null): string[] {
  const settings = readSettings(store);
  return repo === null ? (settings.checks ?? []) : (settings.repos?.[repo]?.checks ?? []);
}
