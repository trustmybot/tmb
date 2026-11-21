// The chain's stand-in for GitHub. GitHub is never reached: each repo's remote is a bare repo,
// and a fake `gh` on the chain's PATH answers the calls tmb makes for pull requests. Its pull
// requests live in remotes/github.json, beside the bare repos, so a saved state holds them too.
//
// A pull request the Human merges "on the site" is merged here, in the bare repo, with a reflog
// message that starts "github:", so the after-step check knows no push made that change.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RepoName, World } from "./world.ts";

export type PullRequest = {
  number: number;
  repo: string;
  url: string;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "OPEN" | "MERGED" | "CLOSED";
};
export type GithubState = { pulls: PullRequest[] };

export const OWNER = "demo";

/** The fake gh: a bun script, given the state file's path first. */
const GH_PROGRAM = `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const [statePath, ...args] = process.argv.slice(2);
appendFileSync(statePath.replace(/\\.json$/, ".log"), JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const fail = (said) => { process.stderr.write(said + "\\n"); process.exit(1); };
const read = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { pulls: [] });
const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
// gh names the repo from the git remote of the folder it runs in.
const repoHere = () => {
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (origin.status !== 0) fail("none of the git remotes configured for this repository point to a known GitHub host");
  return path.basename(origin.stdout.trim()).replace(/\\.git$/, "");
};
const [command, sub] = args;
if (command === "--version") { console.log("gh version 2.99.0 (chain stand-in)"); process.exit(0); }
if (command === "auth" && sub === "status") { console.log("github.com\\n  ✓ Logged in to github.com account demo-human"); process.exit(0); }
if (command !== "pr") fail("the chain's stand-in for gh does not know: gh " + args.join(" "));
const state = read();
if (sub === "create") {
  const repo = repoHere();
  const head = flag("--head"), base = flag("--base");
  if (!head || !base) fail("gh pr create: --head and --base are needed");
  const bare = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
  if (spawnSync("git", ["-C", bare, "rev-parse", "--verify", "--quiet", "refs/heads/" + head]).status !== 0) fail("pull request create failed: GraphQL: Head sha can't be blank, No commits between " + base + " and " + head);
  const open = state.pulls.find((pull) => pull.repo === repo && pull.head === head && pull.state === "OPEN");
  if (open) fail("a pull request for branch \\"" + head + "\\" into branch \\"" + base + "\\" already exists:\\n" + open.url);
  const number = state.pulls.filter((pull) => pull.repo === repo).length + 1;
  const url = "https://github.com/${OWNER}/" + repo + "/pull/" + number;
  state.pulls.push({ number, repo, url, head, base, title: flag("--title") ?? "", body: flag("--body") ?? "", state: "OPEN" });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(url);
  process.exit(0);
}
if (sub === "list") {
  const repo = repoHere();
  const head = flag("--head"), wanted = (flag("--state") ?? "open").toUpperCase();
  const found = state.pulls.filter((pull) => pull.repo === repo && (!head || pull.head === head) && (wanted === "ALL" || pull.state === wanted));
  // Only the form tmb asks for: --json url --jq .[0].url
  if (found.length > 0) console.log(found[0].url);
  process.exit(0);
}
if (sub === "view") {
  const pull = state.pulls.find((each) => each.url === args[2]);
  if (!pull) fail("GraphQL: Could not resolve to a PullRequest (" + args[2] + ")");
  // Only the form tmb asks for: --json state --jq .state
  console.log(pull.state);
  process.exit(0);
}
fail("the chain's stand-in for gh does not know: gh " + args.join(" "));
`;

export class Github {
  constructor(readonly world: World) {}

  get statePath(): string {
    return path.join(this.world.remotes, "github.json");
  }

  /** Writes the fake gh into the chain's tool folder; its pull requests stay in the remotes folder. */
  install(): void {
    const program = path.join(this.world.bin, "gh.cjs");
    writeFileSync(program, GH_PROGRAM);
    writeFileSync(path.join(this.world.bin, "gh"), `#!/bin/sh\nexec '${process.execPath}' '${program}' '${this.statePath}' "$@"\n`, { mode: 0o755 });
  }

  read(): GithubState {
    return existsSync(this.statePath) ? (JSON.parse(readFileSync(this.statePath, "utf8")) as GithubState) : { pulls: [] };
  }

  pulls(repo?: RepoName): PullRequest[] {
    return this.read().pulls.filter((pull) => repo === undefined || pull.repo === repo);
  }

  /** Every call tmb made to gh, oldest first. */
  calls(): { cwd: string; args: string[] }[] {
    const log = this.statePath.replace(/\.json$/, ".log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { cwd: string; args: string[] });
  }

  /**
   * The Human merges a pull request on the site as a squash: one new commit on the base branch
   * with the head's work, made in the bare repo. Returns the new commit.
   */
  squashMerge(pull: PullRequest): string {
    if (pull.state !== "OPEN") throw new Error(`${pull.url} is ${pull.state}, not open`);
    const bare = this.world.remote(pull.repo as RepoName);
    const base = this.world.git(bare, "rev-parse", `refs/heads/${pull.base}`);
    const head = this.world.git(bare, "rev-parse", `refs/heads/${pull.head}`);
    const tree = this.world.git(bare, "merge-tree", "--write-tree", "--no-messages", base, head).split("\n")[0]!;
    const commit = this.world.git(bare, "commit-tree", tree, "-p", base, "-m", `${pull.title} (#${pull.number})`);
    this.world.git(bare, "update-ref", "-m", `github: squash merge of pull request #${pull.number}`, `refs/heads/${pull.base}`, commit, base);
    const state = this.read();
    state.pulls.find((each) => each.url === pull.url)!.state = "MERGED";
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    return commit;
  }
}
