// Check detection: the commands a project's files suggest, one fixture per stack.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectChecks } from "../src/engine/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-checks-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function files(contents: Record<string, string>): void {
  for (const [name, text] of Object.entries(contents)) writeFileSync(path.join(project, name), text);
}

function packageJson(scripts: Record<string, unknown>): string {
  return JSON.stringify({ name: "fixture", scripts });
}

const ALL_SCRIPTS = { test: "x", build: "x", typecheck: "x", lint: "x" };

describe("detectChecks", () => {
  test("an empty folder suggests nothing", () => {
    expect(detectChecks(project)).toEqual([]);
  });

  test("a bun project runs lint, typecheck and test with bun, in that order, and skips other scripts", () => {
    files({ "package.json": packageJson(ALL_SCRIPTS), "bun.lock": "" });
    expect(detectChecks(project)).toEqual(["bun run lint", "bun run typecheck", "bun run test"]);
  });

  test("an older bun lockfile also means bun", () => {
    files({ "package.json": packageJson({ test: "x" }), "bun.lockb": "" });
    expect(detectChecks(project)).toEqual(["bun run test"]);
  });

  test("an npm project runs its scripts with npm, and only the ones it has", () => {
    files({ "package.json": packageJson({ test: "jest", build: "tsc" }), "package-lock.json": "{}" });
    expect(detectChecks(project)).toEqual(["npm run test"]);
  });

  test("pnpm and yarn lockfiles pick their tool, and no lockfile means npm", () => {
    files({ "package.json": packageJson({ lint: "eslint ." }), "pnpm-lock.yaml": "" });
    expect(detectChecks(project)).toEqual(["pnpm run lint"]);
    rmSync(path.join(project, "pnpm-lock.yaml"));
    files({ "yarn.lock": "" });
    expect(detectChecks(project)).toEqual(["yarn run lint"]);
    rmSync(path.join(project, "yarn.lock"));
    expect(detectChecks(project)).toEqual(["npm run lint"]);
  });

  test("an empty or non-text script, a package.json without scripts and one that does not parse suggest nothing", () => {
    files({ "package.json": packageJson({ test: "", lint: 3 }) });
    expect(detectChecks(project)).toEqual([]);
    files({ "package.json": JSON.stringify({ name: "x" }) });
    expect(detectChecks(project)).toEqual([]);
    files({ "package.json": "{ not json" });
    expect(detectChecks(project)).toEqual([]);
  });

  test("a Python project runs pytest, from pyproject.toml or setup.cfg", () => {
    files({ "pyproject.toml": "[project]\nname = 'x'\n" });
    expect(detectChecks(project)).toEqual(["pytest"]);
    rmSync(path.join(project, "pyproject.toml"));
    files({ "setup.cfg": "[metadata]\nname = x\n" });
    expect(detectChecks(project)).toEqual(["pytest"]);
  });

  test("a Rust project runs cargo test", () => {
    files({ "Cargo.toml": "[package]\nname = 'x'\n" });
    expect(detectChecks(project)).toEqual(["cargo test"]);
  });

  test("a Go project runs go test on every package", () => {
    files({ "go.mod": "module x\n" });
    expect(detectChecks(project)).toEqual(["go test ./..."]);
  });

  test("a project of several stacks gets package.json's checks first, then Python, Rust and Go", () => {
    files({ "go.mod": "", "Cargo.toml": "", "pyproject.toml": "", "package.json": packageJson({ test: "x" }) });
    expect(detectChecks(project)).toEqual(["npm run test", "pytest", "cargo test", "go test ./..."]);
  });
});
