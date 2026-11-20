// The engine's GitHub client: the few REST calls tmb makes itself, sent through the user's own
// `gh` (which also reads GH_TOKEN or GITHUB_TOKEN), so tmb holds no login and is no GitHub App.
// The repository is the one origin names; an origin that is a local path, or a URL with no owner
// and name, is no GitHub repository and gets no call.
import { spawnSync } from "node:child_process";
import { runGit } from "./git.ts";

const GH_TIMEOUT_MS = 30_000;

export type GithubRepo = { host: string; owner: string; name: string };
export type GhResult = { ok: true; stdout: string } | { ok: false; why: string; notFound: boolean };
/** A commit status's state, in GitHub's own words. */
export type StatusState = "success" | "failure" | "pending" | "error";

/** GitHub caps a commit status's description at 140 characters. */
export const STATUS_DESCRIPTION_MAX = 140;

/**
 * The GitHub repository origin's URL names, or null when it names none: no origin, a local path,
 * or a URL with no owner and name. The URL is read as configured, before any `insteadOf` rewrite,
 * because that is the address the Human gave.
 */
export function githubRepoOf(projectDir: string): GithubRepo | null {
  const url = runGit(projectDir, ["config", "--get", "remote.origin.url"]);
  return url.ok ? parseRemoteUrl(url.stdout) : null;
}

/** Parses https://host/owner/name(.git), ssh://user@host[:port]/owner/name(.git) and user@host:owner/name(.git). */
export function parseRemoteUrl(url: string): GithubRepo | null {
  const trimmed = url.trim();
  const withScheme = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  const scpLike = /^(?:[^@/]+@)?([^/:]+):(?!\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  const found = withScheme ?? scpLike;
  if (found === null) return null;
  const [, host, owner, name] = found;
  // A Windows drive letter, as in C:folder/repo, is a local path, not a host.
  if (withScheme === null && host!.length === 1) return null;
  return { host: host!, owner: owner!, name: name! };
}

/** One `gh api` call; `fields` are sent as string fields of the request body. */
export function ghApi(projectDir: string, repo: GithubRepo, method: "GET" | "POST", endpoint: string, fields: Record<string, string> = {}): GhResult {
  const args = ["api", "--hostname", repo.host, "--method", method, endpoint];
  for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`);
  const result = spawnSync("gh", args, {
    cwd: projectDir,
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) return { ok: false, why: result.error.message, notFound: false };
  const said = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.replace(/\s+/g, " ").trim();
  if (result.status !== 0) return { ok: false, why: said === "" ? `gh exited ${result.status}` : said, notFound: /\b404\b|Not Found/.test(said) };
  return { ok: true, stdout: result.stdout ?? "" };
}

/** Sets the commit status named `context` on `sha`. */
export function setCommitStatus(projectDir: string, repo: GithubRepo, sha: string, context: string, state: StatusState, description: string): GhResult {
  return ghApi(projectDir, repo, "POST", `repos/${repo.owner}/${repo.name}/statuses/${sha}`, {
    state,
    context,
    description: description.length > STATUS_DESCRIPTION_MAX ? `${description.slice(0, STATUS_DESCRIPTION_MAX - 1)}…` : description,
  });
}

/**
 * Whether `branch`'s protection requires the status check named `context`: true or false as
 * GitHub says, or the reason it could not say. Only reads: tmb never changes protection.
 */
export function requiresStatusCheck(projectDir: string, repo: GithubRepo, branch: string, context: string): { required: boolean } | { unknown: string } {
  const result = ghApi(projectDir, repo, "GET", `repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`);
  // GitHub answers 404 when the branch has no such rule (and when the login may not read it).
  if (!result.ok) return result.notFound ? { required: false } : { unknown: result.why };
  try {
    const body = JSON.parse(result.stdout) as { contexts?: string[]; checks?: { context: string }[] };
    const names = [...(body.contexts ?? []), ...(body.checks ?? []).map((check) => check.context)];
    return { required: names.includes(context) };
  } catch {
    return { unknown: "GitHub's answer was not JSON" };
  }
}
