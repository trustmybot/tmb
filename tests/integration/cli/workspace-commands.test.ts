// The record and graph commands in a workspace, typed by hand (trustmybot/tmb#262): a folder
// `todo/` that is not a repo holds the repos api, tools and notes. Each command runs as its own
// process, from the workspace folder and from a repo folder below it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathWithFakeClaude } from "../../lib/fake-host.ts";
import { REPO_ROOT } from "../../lib/paths.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const CLI = path.join(REPO_ROOT, "src", "cli", "index.ts");
const REPOS = ["api", "tools", "notes"];

let scratch: string;
let workspace: string;
let env: Record<string, string>;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function run(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tmb(args: string[], cwd: string): string {
  const result = run(args, cwd);
  if (result.status !== 0) throw new Error(`tmb ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

/** The repo a graph lookup read, as its JSON answer names the file that defines `handle`. */
function symbolPaths(args: string[], cwd: string): string[] {
  const answer = JSON.parse(tmb(["graph", "symbol", "handle", ...args, "--json"], cwd)) as { cards: { symbol: { path: string } }[] };
  return answer.cards.map((card) => card.symbol.path);
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-workspace-commands-")));
  env = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: path.join(scratch, "no-xdg"),
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"),
    PATH: pathWithFakeClaude(scratch),
  };
  delete env.CLAUDE_PROJECT_DIR;
  workspace = path.join(scratch, "todo");
  for (const name of REPOS) {
    const dir = path.join(workspace, name);
    const origin = path.join(scratch, `${name}-origin.git`);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "user.email", "t@example.com");
    // Each repo defines `handle` in a file named after it, so an answer shows which repo it read.
    writeFileSync(path.join(dir, "src", `${name}.ts`), `export function handle() {}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `first in ${name}`);
    git(scratch, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-q", "origin", "main");
    git(dir, "remote", "set-head", "origin", "main");
  }
  tmb(["init"], workspace);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("record commands in a workspace", () => {
  test("run in the workspace folder and in a repo folder, they use the workspace's one record", () => {
    tmb(["issue", "create", "Made in the workspace folder"], workspace);
    const api = path.join(workspace, "api");
    tmb(["issue", "create", "Made in a repo folder"], api);
    const deeper = path.join(api, "src");
    for (const cwd of [workspace, api, deeper]) {
      const list = tmb(["issue", "list"], cwd);
      expect(list).toContain("Made in the workspace folder");
      expect(list).toContain("Made in a repo folder");
    }
  });
});

describe("graph commands in a workspace", () => {
  test("in the workspace folder, a lookup that names no repo is refused with the --repo option", () => {
    const result = run(["graph", "symbol", "handle"], workspace);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("this workspace has 3 repos (api, notes, tools)");
    expect(result.stderr).toContain("--repo");
  });

  test("--repo names the repo, from the workspace folder or from another repo's folder", () => {
    expect(symbolPaths(["--repo", "api"], workspace)).toEqual(["src/api.ts"]);
    expect(symbolPaths(["--repo", "tools"], workspace)).toEqual(["src/tools.ts"]);
    expect(symbolPaths(["--repo", "notes"], path.join(workspace, "api"))).toEqual(["src/notes.ts"]);
  });

  test("in a repo folder, or one below it, a lookup reads that repo without being asked", () => {
    expect(symbolPaths([], path.join(workspace, "api"))).toEqual(["src/api.ts"]);
    expect(symbolPaths([], path.join(workspace, "tools", "src"))).toEqual(["src/tools.ts"]);
  });

  test("every lookup takes --repo", () => {
    for (const args of [
      ["graph", "map"],
      ["graph", "find", "handle"],
      ["graph", "scope", "change handle"],
      ["graph", "concepts"],
      ["graph", "areas"],
    ]) {
      expect(run([...args, "--repo", "notes"], workspace).status).toBe(0);
    }
    expect(tmb(["graph", "find", "handle", "--repo", "notes"], workspace)).toContain("src/notes.ts");
  });

  test("an unknown repo is refused with the workspace's repos", () => {
    const result = run(["graph", "map", "--repo", "web"], workspace);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no repo "web" in this workspace');
  });
});
