// Builds the demo app, a to-do app as a folder of three repos, from tests/chain/demo-app. Every
// commit has a fixed author, committer and date, so every run starts from the same commits.
//   api    TypeScript, with a path alias, a re-export, a package inside the repo and one
//          minified file; agile mode; a bare remote.
//   tools  Python and bash, and one Ruby file, a language tmb does not read; truest mode; a
//          bare remote; a pre-push hook of another tool's, as husky or lefthook write.
//   notes  Markdown, with no remote.
import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BASE, REMOTE_REPOS, REPOS, type World } from "./world.ts";

export const DEMO_APP = path.join(import.meta.dir, "demo-app");
const FIXED = "2026-01-01T09:00:00Z";

/** The pre-push hook another tool wrote in tools before tmb came. */
export const FOREIGN_HOOK = '#!/bin/sh\n# Written by the lint tool: lints the commits of every push.\ncat > "$(git rev-parse --git-dir)/lint-refs"\necho "lint: ok"\n';

/** Where the other tool's hook keeps the ref lines git gave it, so the chain can see it got them. */
export const FOREIGN_HOOK_REFS = "lint-refs";

/** Lays the demo app out in the world's project folder; returns each repo's first commit. */
export function buildDemoApp(world: World): Record<string, string> {
  const commitEnv = {
    GIT_AUTHOR_NAME: "Demo Human",
    GIT_AUTHOR_EMAIL: "human@example.com",
    GIT_AUTHOR_DATE: FIXED,
    GIT_COMMITTER_NAME: "Demo Human",
    GIT_COMMITTER_EMAIL: "human@example.com",
    GIT_COMMITTER_DATE: FIXED,
  };
  const first: Record<string, string> = {};
  mkdirSync(world.project, { recursive: true });
  for (const name of REPOS) {
    const dir = world.repo(name);
    cpSync(path.join(DEMO_APP, name), dir, { recursive: true });
    const git = (...args: string[]) => {
      const result = world.run("git", args, { cwd: dir, env: commitEnv });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${dir}: ${result.output}`);
      return result.stdout.trim();
    };
    git("init", "-q", "-b", BASE);
    git("add", ".");
    git("commit", "-q", "-m", `The ${name} repo`);
    first[name] = git("rev-parse", "HEAD");
  }
  for (const name of REMOTE_REPOS) {
    const bare = world.remote(name);
    world.git(world.remotes, "init", "-q", "--bare", "-b", BASE, bare);
    world.git(world.repo(name), "remote", "add", "origin", bare);
    world.git(world.repo(name), "push", "-q", "origin", BASE);
    // From here on every change to the remote's branches is logged, so the chain can match each
    // push against the push gate's record of it.
    world.git(bare, "config", "core.logAllRefUpdates", "always");
  }
  const hook = path.join(world.repo("tools"), ".git", "hooks", "pre-push");
  writeFileSync(hook, FOREIGN_HOOK);
  chmodSync(hook, 0o755);
  return first;
}
