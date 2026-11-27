// Base branch detection, in temporary git repositories.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectBaseBranch, FALLBACK_BASE_BRANCH } from "../../src/engine/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const GIT_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CEILING_DIRECTORIES"] as const;
const savedEnv = Object.fromEntries(GIT_ENV.map((name) => [name, process.env[name]]));

let scratch: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-base-branch-")));
  // Keep the machine's git configuration, and any repository above the scratch folder, out of the tests.
  process.env.GIT_CONFIG_GLOBAL = path.join(scratch, "no-gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CEILING_DIRECTORIES = scratch;
});

afterAll(() => {
  for (const name of GIT_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(scratch, "case-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function repo(name: string, branch: string): string {
  const repoDir = path.join(dir, name);
  mkdirSync(repoDir);
  git(repoDir, "init", "-q", "-b", branch);
  return repoDir;
}

describe("detectBaseBranch", () => {
  test("takes origin's default branch over the current branch", () => {
    const upstream = repo("upstream", "develop");
    git(upstream, "commit", "-q", "--allow-empty", "-m", "first");
    git(dir, "clone", "-q", upstream, "clone");
    const clone = path.join(dir, "clone");
    git(clone, "checkout", "-q", "-b", "feature");
    expect(detectBaseBranch(clone)).toBe("develop");
  });

  test("takes the current branch when origin names no default, even before the first commit", () => {
    const project = repo("project", "trunk");
    expect(detectBaseBranch(project)).toBe("trunk");
    git(project, "remote", "add", "origin", path.join(dir, "nowhere"));
    expect(detectBaseBranch(project)).toBe("trunk");
  });

  test("works from a subfolder of the work tree", () => {
    const project = repo("project", "trunk");
    const sub = path.join(project, "src");
    mkdirSync(sub);
    expect(detectBaseBranch(sub)).toBe("trunk");
  });

  test("falls back to main on a detached HEAD with no origin", () => {
    const project = repo("project", "trunk");
    git(project, "commit", "-q", "--allow-empty", "-m", "first");
    git(project, "checkout", "-q", "--detach");
    expect(detectBaseBranch(project)).toBe(FALLBACK_BASE_BRANCH);
    expect(FALLBACK_BASE_BRANCH).toBe("main");
  });

  test("suggests nothing outside a git work tree", () => {
    expect(detectBaseBranch(dir)).toBeNull();
  });
});
