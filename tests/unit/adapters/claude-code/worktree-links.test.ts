// The project's shared folders in Claude Code's worktree links: tmb's entries beside the Human's own (trustmybot/tmb#286).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adapter } from "../../../../src/adapters/claude-code/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let project: string;
const settingsPath = () => path.join(project, ".claude", "settings.local.json");
const read = () => JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
const write = (value: unknown) => {
  mkdirSync(path.dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(value));
};

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-links-"));
  mkdirSync(path.join(project, ".tmb"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("shared folders in Claude Code's settings", () => {
  test("are listed beside the Human's own entries, refreshed, and taken away by remove", () => {
    write({ worktree: { symlinkDirectories: ["vendor"], sparsePaths: ["src"] }, model: "x" });

    expect(adapter.shareFolders(project, ["node_modules", "vendor"])).toEqual([
      "Set tmb's shared folders in worktree.symlinkDirectories in .claude/settings.local.json: node_modules.",
    ]);
    expect(read()).toEqual({ worktree: { symlinkDirectories: ["vendor", "node_modules"], sparsePaths: ["src"] }, model: "x" });
    // The same list again changes nothing.
    expect(adapter.shareFolders(project, ["node_modules", "vendor"])).toEqual([]);

    adapter.shareFolders(project, [".venv"]);
    expect(read()).toEqual({ worktree: { symlinkDirectories: ["vendor", ".venv"], sparsePaths: ["src"] }, model: "x" });
    expect(adapter.wiringGaps(project, ["tmb"], [".venv"]).some((gap) => gap.includes("symlinkDirectories"))).toBe(false);
    expect(adapter.wiringGaps(project, ["tmb"], ["node_modules"])).toContain(
      ".claude/settings.local.json does not link the shared folder node_modules in worktree.symlinkDirectories",
    );

    adapter.remove(project);
    // The Human's entry and keys stay; tmb's marker goes.
    expect(read()).toEqual({ worktree: { symlinkDirectories: ["vendor"], sparsePaths: ["src"] }, model: "x" });
    expect(existsSync(path.join(project, ".tmb", "claude-code-shared-folders.json"))).toBe(false);
  });

  test("an empty list leaves no worktree key behind and no file it did not need", () => {
    expect(adapter.shareFolders(project, [])).toEqual([]);
    expect(existsSync(settingsPath())).toBe(false);
    write({ model: "x" });
    adapter.shareFolders(project, ["node_modules"]);
    expect(read()).toEqual({ model: "x", worktree: { symlinkDirectories: ["node_modules"] } });
    adapter.shareFolders(project, []);
    expect(read()).toEqual({ model: "x" });
  });

  test("a settings file whose worktree links are no list is refused, not overwritten", () => {
    write({ worktree: { symlinkDirectories: "node_modules" } });
    expect(() => adapter.shareFolders(project, ["node_modules"])).toThrow("is not a list of folders");
    expect(read()).toEqual({ worktree: { symlinkDirectories: "node_modules" } });
  });
});
