// A feature branch after its pull request (trustmybot/tmb#131): `merged` when the pull request
// merged, `closed` when it was closed without a merge. tmb reads the pull request's state through
// the Human's own `gh`, only for features in pr_open. A read that fails changes nothing and never
// fails the caller: with no network the feature stays pr_open. The change is kept in the record
// like any other change of state. tmb never deletes the local branch of a merged feature. In a repo
// with no remote there is no pull request: a ready feature or truest task moves on once the local
// base branch holds its tip (trustmybot/tmb#183), or the work of it, after a squash or a rebase
// merge by hand (trustmybot/tmb#214).
import { spawnSync } from "node:child_process";
import { runGit } from "./git.ts";
import { CLOSED, CLOSED_UNMERGED, MERGED, READY } from "./handlers/common.ts";
import { featureDir } from "./handlers/features.ts";
import { branchRef, isAncestor } from "./handlers/fold.ts";
import { PR_OPEN } from "./handlers/reviews.ts";
import { repoOfRow } from "./repos.ts";
import type { Actor, Feature, Store } from "./store/index.ts";

export { CLOSED_UNMERGED, MERGED };

const GH_TIMEOUT_MS = 15_000;

/** What GitHub says of a pull request: OPEN, MERGED or CLOSED; null when it could not be read. */
export type PullRequestReader = (projectDir: string, url: string) => "OPEN" | "MERGED" | "CLOSED" | null;

export const readPullRequestState: PullRequestReader = (projectDir, url) => {
  const result = spawnSync("gh", ["pr", "view", url, "--json", "state", "--jq", ".state"], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) return null;
  const state = (result.stdout ?? "").trim();
  return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
};

/**
 * Moves each feature in pr_open whose pull request merged or closed to `merged` or `closed`, as
 * `actor`. `shouldRead` picks which features to read now (the dashboard reads each at most once a
 * minute). Never throws; returns one line per feature it moved.
 */
export function refreshPullRequestStates(
  store: Store,
  actor: Actor,
  projectDir: string,
  options: { shouldRead?: (feature: Feature) => boolean; read?: PullRequestReader } = {},
): string[] {
  const read = options.read ?? readPullRequestState;
  const moved: string[] = [];
  try {
    for (const feature of store.listFeatures(PR_OPEN)) {
      if (feature.prUrl === null || !(options.shouldRead?.(feature) ?? true)) continue;
      const state = read(projectDir, feature.prUrl);
      const next = state === "MERGED" ? MERGED : state === "CLOSED" ? CLOSED_UNMERGED : null;
      if (next === null) continue;
      store.updateFeature(actor, feature.id, { state: next });
      moved.push(
        next === MERGED
          ? `${feature.name}: its pull request ${feature.prUrl} merged, so the feature branch is ${next}`
          : `${feature.name}: its pull request ${feature.prUrl} was closed without a merge, so the feature branch is ${next}. Start a task on it to rework it, or open a new pull request with feature_pr.`,
      );
    }
  } catch {
    // A read or a write that fails leaves the feature as it was; the next read tries again.
  }
  return [...moved, ...refreshLocalMerges(store, actor, projectDir)];
}

/** Whether this git has `merge-tree --write-tree` (git 2.38 and later), which the squash check needs. */
let writeTreeSupport: boolean | null = null;
function gitWritesMergeTrees(dir: string): boolean {
  if (writeTreeSupport === null) {
    const version = /(\d+)\.(\d+)/.exec(runGit(dir, ["version"]).stdout);
    writeTreeSupport = version !== null && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 38));
  }
  return writeTreeSupport;
}

/** The note tmb gives when its git cannot see a squash or a rebase merge. */
export const OLD_GIT_NOTE =
  "git is older than 2.38, so tmb records a ready branch merged only once the base branch holds its tip, not after a squash or a rebase merge by hand; end such a branch with tmb feature drop or tmb task drop and the reason";

/**
 * Whether the local `base` branch in `dir` holds the work of `commit`, made on top of `from`;
 * false when git cannot tell. It does when it holds the commit itself (a merge), or when merging
 * the commit into it would change nothing, as after a squash or a rebase merge done by hand
 * (trustmybot/tmb#214). A commit with no work of its own past `from` never counts as merged. When
 * the base changed the same lines again after the merge, the check cannot tell, and it says no.
 */
function baseHolds(dir: string, base: string, commit: string | null, from: string | null): boolean {
  if (commit === null) return false;
  if (from !== null) {
    const own = runGit(dir, ["rev-list", "--count", `${from}..${commit}`]);
    if (!own.ok || own.stdout === "0") return false;
  }
  const baseTree = runGit(dir, ["rev-parse", "--verify", "--quiet", `${branchRef(base)}^{tree}`]);
  if (!baseTree.ok) return false;
  if (isAncestor(dir, commit, branchRef(base))) return true;
  if (!gitWritesMergeTrees(dir)) return false;
  const merged = runGit(dir, ["merge-tree", "--write-tree", "--no-messages", branchRef(base), commit]);
  return merged.ok && merged.stdout.split("\n")[0] === baseTree.stdout;
}

/**
 * In a repo with no remote (trustmybot/tmb#183) the Human merges a ready feature branch, or a ready
 * truest task, locally. Once the local base branch holds its work, a feature moves to merged and a
 * task to closed. Never throws; returns one line per one it moved, and a note when git is too old
 * to see a squash or a rebase merge while something is still ready.
 */
export function refreshLocalMerges(store: Store, actor: Actor, projectDir: string): string[] {
  const moved: string[] = [];
  let stillReady = false;
  try {
    for (const feature of store.listFeatures(READY)) {
      const dir = featureDir(store, projectDir, feature);
      const tip = runGit(dir, ["rev-parse", "--verify", "--quiet", `${branchRef(feature.name)}^{commit}`]);
      if (!tip.ok || !baseHolds(dir, feature.baseBranch, tip.stdout, feature.baseCommit)) {
        stillReady = true;
        continue;
      }
      store.updateFeature(actor, feature.id, { state: MERGED });
      moved.push(`${feature.name}: the base branch ${feature.baseBranch} holds the work of its tip ${tip.stdout}, so the feature branch is ${MERGED}`);
    }
    for (const task of store.listTasks(READY)) {
      const repo = repoOfRow(store, projectDir, task);
      if (repo.baseBranch === null || !baseHolds(repo.dir, repo.baseBranch, task.commitSha, task.baseCommit)) {
        stillReady = true;
        continue;
      }
      store.updateTask(actor, task.id, { state: CLOSED });
      moved.push(`task ${task.id}: the base branch ${repo.baseBranch} holds the work of its commit ${task.commitSha}, so the task is ${CLOSED}`);
    }
    if (stillReady && !gitWritesMergeTrees(projectDir)) moved.push(OLD_GIT_NOTE);
  } catch {
    // A read or a write that fails leaves the record as it was; the next read tries again.
  }
  return moved;
}
