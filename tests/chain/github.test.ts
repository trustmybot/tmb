// The chain's stand-in for GitHub: the fake gh opens, lists and reads pull requests as tmb asks,
// and a squash merge on "the site" moves the bare repo's base with a "github:" reflog message.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Github } from "./github.ts";
import { World } from "./world.ts";

setDefaultTimeout(30_000);

function demoWorld(): World {
  const world = new World(mkdtempSync(path.join(tmpdir(), "chain-github-")));
  world.prepare();
  const repo = world.repo("api");
  const bare = world.remote("api");
  world.git(world.remotes, "init", "-q", "--bare", "-b", "main", bare);
  world.git(bare, "config", "core.logAllRefUpdates", "always");
  world.git(world.work, "init", "-q", "-b", "main", repo);
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  world.git(repo, "add", ".");
  world.git(repo, "commit", "-q", "-m", "one");
  world.git(repo, "remote", "add", "origin", bare);
  world.git(repo, "push", "-q", "origin", "main");
  world.git(repo, "switch", "-q", "-c", "feat/two");
  writeFileSync(path.join(repo, "b.txt"), "two\n");
  world.git(repo, "add", ".");
  world.git(repo, "commit", "-q", "-m", "two");
  world.git(repo, "push", "-q", "origin", "feat/two");
  return world;
}

const gh = (world: World, ...args: string[]) => world.run("gh", args, { cwd: world.repo("api"), installedOnPath: false });

test("gh opens one pull request per branch, lists it and reads its state", () => {
  const world = demoWorld();
  expect(gh(world, "auth", "status", "--hostname", "github.com").status).toBe(0);
  const created = gh(world, "pr", "create", "--base", "main", "--head", "feat/two", "--title", "Two", "--body", "b");
  expect(created.stdout.trim()).toBe("https://github.com/demo/api/pull/1");
  const again = gh(world, "pr", "create", "--base", "main", "--head", "feat/two", "--title", "Two");
  expect(again.status).toBe(1);
  expect(again.stderr).toContain("already exists");
  expect(gh(world, "pr", "list", "--head", "feat/two", "--state", "open", "--json", "url", "--jq", ".[0].url").stdout.trim()).toBe("https://github.com/demo/api/pull/1");
  expect(gh(world, "pr", "view", "https://github.com/demo/api/pull/1", "--json", "state", "--jq", ".state").stdout.trim()).toBe("OPEN");
  expect(gh(world, "pr", "create", "--base", "main", "--head", "feat/none", "--title", "None").status).toBe(1);
  expect(new Github(world).calls().length).toBe(6);
});

test("a squash merge on the site puts one commit with the branch's work on the base, logged as github's", () => {
  const world = demoWorld();
  gh(world, "pr", "create", "--base", "main", "--head", "feat/two", "--title", "Two");
  const github = new Github(world);
  const [pull] = github.pulls("api");
  const before = world.git(world.remote("api"), "rev-parse", "main");
  const merged = github.squashMerge(pull!);
  const bare = world.remote("api");
  expect(world.git(bare, "rev-parse", "main")).toBe(merged);
  expect(world.git(bare, "rev-parse", `${merged}^`)).toBe(before);
  expect(world.git(bare, "show", `${merged}:b.txt`)).toBe("two");
  expect(world.git(bare, "log", "-1", "--format=%s", merged)).toBe("Two (#1)");
  expect(readFileSync(path.join(bare, "logs", "refs", "heads", "main"), "utf8").trim().split("\n").at(-1)).toContain("\tgithub: squash merge of pull request #1");
  expect(gh(world, "pr", "view", pull!.url, "--json", "state", "--jq", ".state").stdout.trim()).toBe("MERGED");
  expect(() => github.squashMerge(github.pulls("api")[0]!)).toThrow("is MERGED");
});
