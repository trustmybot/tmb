// Prints the dev version for HEAD of the current repo: X.Y.Z-dev.<n>[.gh<PR>].
//   X.Y.Z  package.json version
//   n      first-parent commits since the highest stable vX.Y.Z tag (all of them with no such tag)
//   PR     number from the HEAD merge or squash commit subject, omitted when there is none
import { spawnSync } from "node:child_process";
import pkg from "../package.json" with { type: "json" };

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function highestStableTag(tags: readonly string[]): string | undefined {
  let best: { tag: string; parts: number[] } | undefined;
  for (const tag of tags) {
    const match = STABLE_TAG.exec(tag.trim());
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    if (!best || compareParts(parts, best.parts) > 0) best = { tag: tag.trim(), parts };
  }
  return best?.tag;
}

function compareParts(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function prNumberFromSubject(subject: string): number | undefined {
  const match = /^Merge pull request #(\d+) from /.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return match ? Number(match[1]) : undefined;
}

export function formatDevVersion(base: string, commitCount: number, pr?: number): string {
  return `${base}-dev.${commitCount}${pr === undefined ? "" : `.gh${pr}`}`;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

if (import.meta.main) {
  const lastTag = highestStableTag(git(["tag", "--list"]).split("\n"));
  const count = Number(git(["rev-list", "--first-parent", "--count", lastTag ? `${lastTag}..HEAD` : "HEAD"]));
  const pr = prNumberFromSubject(git(["log", "-1", "--format=%s", "HEAD"]));
  console.log(formatDevVersion(pkg.version, count, pr));
}
