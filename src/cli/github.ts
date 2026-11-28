// What the command line asks GitHub, through the user's own gh.
import { spawnSync } from "node:child_process";

/** How long a question to GitHub may take. */
const GH_TIMEOUT_MS = 30_000;
/** The most merged pull requests one question lists. */
const MERGED_LIMIT = "1000";

/** The pull requests GitHub says were merged in a repo since a time (trustmybot/tmb#257). */
export function mergedPullsByGh(repoDir: string, since: string): { numbers: number[] } | { why: string } {
  if (Bun.which("gh") === null) return { why: "gh is not installed" };
  const result = spawnSync("gh", ["pr", "list", "--state", "merged", "--search", `merged:>=${since.slice(0, 10)}`, "--json", "number,mergedAt", "--limit", MERGED_LIMIT], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
  });
  if (result.status !== 0) return { why: `GitHub could not be asked: ${(result.stderr || result.error?.message || "gh failed").trim().split("\n")[0]}` };
  try {
    const pulls = JSON.parse(result.stdout) as { number: number; mergedAt: string }[];
    return { numbers: pulls.filter((pull) => Date.parse(pull.mergedAt) > Date.parse(since)).map((pull) => pull.number) };
  } catch {
    return { why: "GitHub's answer could not be read" };
  }
}
