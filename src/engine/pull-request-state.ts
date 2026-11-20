// A feature branch after its pull request (trustmybot/tmb#131): `merged` when the pull request
// merged, `closed` when it was closed without a merge. tmb reads the pull request's state through
// the Human's own `gh`, only for features in pr_open. A read that fails changes nothing and never
// fails the caller: with no network the feature stays pr_open. The change is kept in the record
// like any other change of state. tmb never deletes the local branch of a merged feature.
import { spawnSync } from "node:child_process";
import { PR_OPEN } from "./handlers/reviews.ts";
import type { Actor, Feature, Store } from "./store/index.ts";

export const MERGED = "merged";
export const CLOSED_UNMERGED = "closed";

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
      moved.push(`${feature.name}: its pull request ${feature.prUrl} ${next === MERGED ? "merged" : "was closed without a merge"}, so the feature branch is ${next}`);
    }
  } catch {
    // A read or a write that fails leaves the feature as it was; the next read tries again.
  }
  return moved;
}
