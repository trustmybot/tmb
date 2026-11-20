import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { anchorsOf, slugify } from "./links.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const CHECKER = path.join(import.meta.dir, "links.ts");

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "tmb-links-"));
  spawnSync("git", ["init", "-q"], { cwd: repo, timeout: 10_000 });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeTracked(file: string, text: string): void {
  const absolute = path.join(repo, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
  spawnSync("git", ["add", file], { cwd: repo, timeout: 10_000 });
}

function runChecker(): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [CHECKER], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout };
}

describe("slugify", () => {
  test("follows GitHub's heading anchors", () => {
    expect(slugify("Build order")).toBe("build-order");
    expect(slugify("The gate: what it checks?")).toBe("the-gate-what-it-checks");
    expect(slugify("`tmb init` and [links](x.md)")).toBe("tmb-init-and-links");
    expect(slugify("Pre-merge snake_case")).toBe("pre-merge-snake_case");
  });

  test("repeated headings get numbered anchors", () => {
    expect([...anchorsOf("# Intro\n## Intro\n```\n# not a heading\n```\n")]).toEqual(["intro", "intro-1"]);
  });
});

describe("links.ts", () => {
  test("passes when every relative link and anchor resolves", () => {
    writeTracked("README.md", "See [docs](docs/guide.md#the-gate), [top](#title) and [web](https://example.com).\n# Title\n");
    writeTracked("docs/guide.md", "# Guide\n## The gate\n[back](../README.md) [mail](mailto:a@b.c)\n");
    const result = runChecker();
    expect(result.stdout).toContain("no broken links");
    expect(result.status).toBe(0);
  });

  test("fails with file:line on a missing file and on a missing anchor", () => {
    writeTracked("README.md", "# Title\n\nSee [gone](docs/missing.md).\nAnd [bad anchor](docs/guide.md#nowhere).\n");
    writeTracked("docs/guide.md", "# Guide\n");
    const result = runChecker();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("README.md:3: docs/missing.md (no such file)");
    expect(result.stdout).toContain("README.md:4: docs/guide.md#nowhere (no heading for #nowhere)");
  });

  test("ignores links inside code", () => {
    writeTracked("README.md", "`[x](missing.md)`\n```md\n[y](missing.md)\n```\n");
    expect(runChecker().status).toBe(0);
  });
});
