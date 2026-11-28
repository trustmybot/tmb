// Where a language's tool comes from (CODE_GRAPH.md, "Where a language's tool comes from";
// trustmybot/tmb#392). One find order for every tool:
// - a setting names the path of a tool: that copy is used and nothing is searched;
// - else the user's own copy, when it is at or above the lowest version tmb supports;
// - else tmb's copy in its tools folder, kept once per machine;
// - else the built-in rules build the graph, and the answer names the missing tool.
// The layer records whose copy built it, with its version. tmb installs a tool, never a language,
// so a language's own command (`go`, a JDK's `java`) is the user's alone. No test downloads
// anything: every copy here is a small program written to a scratch folder.
// Each expectation is read off the page's rule, not off the graph's output.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../../../../src/engine/graph/build.ts";
import { GRAPH_SCHEMA_VERSION, layerRow, openGraphDb } from "../../../../src/engine/graph/db.ts";
import type { ToolCopy } from "../../../../src/engine/graph/languages/contract.ts";
import { clangdTool } from "../../../../src/engine/graph/languages/c/clangd.ts";
import { goTypeChecker } from "../../../../src/engine/graph/languages/go/tool.ts";
import { javacTool } from "../../../../src/engine/graph/languages/java/tool.ts";
import { pyright } from "../../../../src/engine/graph/languages/python/tool.ts";
import { rustAnalyzer as rustAnalyzerTool } from "../../../../src/engine/graph/languages/rust/tool.ts";
import { typescriptCompiler } from "../../../../src/engine/graph/languages/typescript/tool.ts";
import { type CopyPlaces, findCopy, TOOL_PATHS_FILE, toolsFolder } from "../../../../src/engine/graph/tool-copy.ts";
import { baseLanguages, toolLine, toolRows } from "../../../../src/engine/graph/tool-report.ts";
import { setEnv, restoreEnv } from "../../../lib/env.ts";

setDefaultTimeout(30_000);

let scratch: string;
let userBin: string;
let state: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-tool-copy-")));
  userBin = path.join(scratch, "user-bin");
  state = path.join(scratch, "state");
  mkdirSync(userBin, { recursive: true });
  mkdirSync(state, { recursive: true });
});

afterEach(() => {
  restoreEnv();
  rmSync(scratch, { recursive: true, force: true });
});

/** A program at `file` that prints `report` when asked its version, and fails otherwise. */
function fakeProgram(file: string, versionArg: string, report: string, more: string[] = []): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ["#!/bin/sh", `if [ "$1" = "${versionArg}" ]; then echo '${report}'; exit 0; fi`, ...more, "exit 1", ""].join("\n"));
  chmodSync(file, 0o755);
  return file;
}

/** tmb's copy of a program in its tools folder. */
const tmbCopyOf = (program: string): string => path.join(toolsFolder(state), program, "bin", program);

/** The setting that names a tool's path. */
function settingNames(program: string, file: string): void {
  writeFileSync(path.join(state, TOOL_PATHS_FILE), JSON.stringify({ paths: { [program]: file } }));
}

// A tool of no language: its facts are the engine's input, so the order is shown on its own.
const WIDGET: ToolCopy = {
  program: "widget",
  what: "widget",
  versionArgs: ["--version"],
  report: ({ stdout }) => stdout.trim(),
  lowest: "widget 2.0",
  supported: (report) => Number(/widget (\d+)/.exec(report)?.[1] ?? 0) >= 2,
  tmbInstalls: true,
};

const places = (): CopyPlaces => ({ searchPath: userBin, stateDir: state });

describe("the find order", () => {
  test("the user's copy at a version tmb supports is used as it is", () => {
    const mine = fakeProgram(path.join(userBin, "widget"), "--version", "widget 3.1");
    fakeProgram(tmbCopyOf("widget"), "--version", "widget 2.5");
    expect(findCopy(WIDGET, places())).toEqual({ whose: "user", path: mine, version: "widget 3.1" });
  });

  test("the user's copy older than tmb supports is skipped: tmb's copy is used, and the note says why", () => {
    const mine = fakeProgram(path.join(userBin, "widget"), "--version", "widget 1.9");
    const tmbs = fakeProgram(tmbCopyOf("widget"), "--version", "widget 2.5");
    const found = findCopy(WIDGET, places());
    expect(found).toMatchObject({ whose: "tmb", path: tmbs, version: "widget 2.5" });
    const note = (found as { note?: string }).note ?? "";
    expect(note).toContain(mine);
    expect(note).toContain("widget 1.9");
    expect(note).toContain("widget 2.0");
  });

  test("with no copy of the user's, tmb's copy in its tools folder is used", () => {
    const tmbs = fakeProgram(tmbCopyOf("widget"), "--version", "widget 2.5");
    expect(findCopy(WIDGET, places())).toEqual({ whose: "tmb", path: tmbs, version: "widget 2.5" });
  });

  test("with neither, the tool is missing, and why names the tool and where it was looked for", () => {
    const found = findCopy(WIDGET, places());
    expect("missing" in found).toBe(true);
    const why = (found as { missing: string }).missing;
    expect(why).toContain("widget");
    expect(why).toContain("PATH");
    expect(why).toContain("tools folder");
  });

  test("an older copy of the user's and none of tmb's: missing, and why names the older copy", () => {
    fakeProgram(path.join(userBin, "widget"), "--version", "widget 1.9");
    const why = (findCopy(WIDGET, places()) as { missing?: string }).missing ?? "";
    expect(why).toContain("widget 1.9");
    expect(why).toContain("widget 2.0");
  });

  test("a setting names the path of a tool: that copy is used, and nothing is searched", () => {
    fakeProgram(path.join(userBin, "widget"), "--version", "widget 3.1");
    fakeProgram(tmbCopyOf("widget"), "--version", "widget 2.5");
    const named = fakeProgram(path.join(scratch, "elsewhere", "widget"), "--version", "widget 1.0");
    settingNames("widget", named);
    expect(findCopy(WIDGET, places())).toEqual({ whose: "setting", path: named, version: "widget 1.0" });
  });

  test("a setting that names a copy that does not run: missing, and nothing else is searched", () => {
    fakeProgram(path.join(userBin, "widget"), "--version", "widget 3.1");
    settingNames("widget", path.join(scratch, "nowhere", "widget"));
    const why = (findCopy(WIDGET, places()) as { missing?: string }).missing ?? "";
    expect(why).toContain(path.join(scratch, "nowhere", "widget"));
  });

  test("a tool that is a language's own command has no copy of tmb's: tmb installs no language", () => {
    const language: ToolCopy = { ...WIDGET, tmbInstalls: false };
    fakeProgram(tmbCopyOf("widget"), "--version", "widget 2.5");
    const found = findCopy(language, places());
    expect("missing" in found).toBe(true);
    expect((found as { missing: string }).missing).not.toContain("tools folder");
  });
});

describe("each language's tool: whose copy the page names, and the lowest version tmb supports", () => {
  const copy = (c: ToolCopy) => c as Extract<ToolCopy, { program: string }>;

  test("TypeScript and pyright: tmb's pinned copy, never the user's", () => {
    expect("library" in typescriptCompiler.copy).toBe(true);
    expect("library" in pyright.copy).toBe(true);
  });

  test("rust-analyzer: the user's from rustup or a release, else tmb's; the error lines tool.ts reads came with Rust 1.92", () => {
    const ra = copy(rustAnalyzerTool.copy);
    expect(ra.program).toBe("rust-analyzer");
    expect(ra.tmbInstalls).toBe(true);
    expect(ra.supported("rust-analyzer 1.92.0 (ded5c06cf 2025-12-08)")).toBe(true);
    expect(ra.supported("rust-analyzer 1.100.0 (0ef1bc386 2026-11-09)")).toBe(true);
    expect(ra.supported("rust-analyzer 1.91.1 (ed61e7d7e 2025-11-07)")).toBe(false);
    // A release of rust-analyzer's own names the day of its commit.
    expect(ra.supported("rust-analyzer 0.3.2662-standalone (049767e6fa 2025-10-26)")).toBe(true);
    expect(ra.supported("rust-analyzer 0.3.2593-standalone (0e9c2fc5f5 2025-08-11)")).toBe(false);
    expect(ra.supported("rust-analyzer: unknown")).toBe(false);
  });

  test("clangd: the user's, else tmb's; symbolInfo gives a definition's range from clangd 16", () => {
    const c = copy(clangdTool.copy);
    expect(c.program).toBe("clangd");
    expect(c.tmbInstalls).toBe(true);
    expect(c.supported("clangd version 16.0.0")).toBe(true);
    expect(c.supported("Homebrew clangd version 19.1.7")).toBe(true);
    expect(c.supported("Ubuntu clangd version 15.0.7")).toBe(false);
    expect(c.supported("Apple clangd version 17.0.0 (clang-1700.0.13.5)")).toBe(true);
  });

  test("Go: the user's `go`, never tmb's; the helper needs Go 1.22", () => {
    const go = copy(goTypeChecker.copy);
    expect(go.program).toBe("go");
    expect(go.tmbInstalls).toBe(false);
    expect(go.supported("go version go1.22.0 linux/amd64")).toBe(true);
    expect(go.supported("go version go1.27.4 darwin/arm64")).toBe(true);
    expect(go.supported("go version go1.21.13 linux/amd64")).toBe(false);
    expect(go.supported("go version go2.0 linux/amd64")).toBe(true);
  });

  test("Java: the user's JDK, never tmb's; the adapter runs in source-file mode, from JDK 11", () => {
    const java = copy(javacTool.copy);
    expect(java.program).toBe("java");
    expect(java.tmbInstalls).toBe(false);
    expect(java.supported('openjdk version "11.0.2" 2019-01-15')).toBe(true);
    expect(java.supported('openjdk version "21.0.13.1" 2026-11-17 LTS')).toBe(true);
    expect(java.supported('java version "1.8.0_202"')).toBe(false);
    expect(java.supported('openjdk version "10.0.2" 2018-07-17')).toBe(false);
  });
});

describe("a build: whose copy built the layer", () => {
  const CARGO_TOML = '[package]\nname = "orchard"\nversion = "0.1.0"\nedition = "2021"\n';
  const CODE = "pub fn pick() -> i32 { sort() }\npub fn sort() -> i32 { 1 }\n";
  let project: string;
  let gitOnly: string;

  /** A rust-analyzer that resolves no name: `scip` writes an empty index, `diagnostics` reports no error. */
  const fakeRustAnalyzer = (file: string, report: string): string =>
    fakeProgram(file, "--version", report, [
      'if [ "$1" = "scip" ]; then while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then : > "$2"; fi; shift; done; exit 0; fi',
      'if [ "$1" = "diagnostics" ]; then echo "diagnostic scan complete"; exit 0; fi',
    ]);

  beforeEach(() => {
    project = path.join(scratch, "project");
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "Cargo.toml"), CARGO_TOML);
    writeFileSync(path.join(project, "src", "lib.rs"), CODE);
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    // A PATH that holds git and the user's folder alone: no other copy of a tool is on it.
    gitOnly = path.join(scratch, "git-only");
    mkdirSync(gitOnly);
    symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), path.join(gitOnly, "git"));
    setEnv("PATH", `${userBin}${path.delimiter}${gitOnly}`);
    setEnv("TMB_STATE_DIR", state);
    // Cargo's home holds no rustup copy.
    setEnv("CARGO_HOME", path.join(scratch, "cargo"));
  });

  async function build(): Promise<{ note: string | null; record: Record<string, { whose: string; path: string | null; tool: string }> }> {
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).stdout.trim();
    const db = openGraphDb(project, null);
    try {
      const stats = await buildLayer(db, project, sha, "base", { force: true, links: "language-tool" });
      const row = layerRow(db, "base")!;
      return { note: stats.linksNote, record: JSON.parse(row.built_with ?? "{}") };
    } finally {
      db.close();
    }
  }

  test("the user's copy built it: the layer records the user's copy, where it is and its version", async () => {
    const mine = fakeRustAnalyzer(path.join(userBin, "rust-analyzer"), "rust-analyzer 1.95.0 (abc 2026-03-01)");
    const { record } = await build();
    expect(record["rust-analyzer"]).toMatchObject({ whose: "user", path: mine, tool: "rust-analyzer 1.95.0 (abc 2026-03-01)" });
  });

  test("an older copy of the user's: tmb's copy builds it, and the note says why", async () => {
    fakeRustAnalyzer(path.join(userBin, "rust-analyzer"), "rust-analyzer 1.80.0 (abc 2024-07-24)");
    const tmbs = fakeRustAnalyzer(tmbCopyOf("rust-analyzer"), "rust-analyzer 1.95.0 (def 2026-03-01)");
    const { record, note } = await build();
    expect(record["rust-analyzer"]).toMatchObject({ whose: "tmb", path: tmbs, tool: "rust-analyzer 1.95.0 (def 2026-03-01)" });
    expect(note ?? "").toContain("rust-analyzer 1.80.0");
    expect(note ?? "").not.toContain("so the built-in rules");
  });

  test("rustup's copy in Cargo's home is the user's copy too", async () => {
    const rustup = fakeRustAnalyzer(path.join(scratch, "cargo", "bin", "rust-analyzer"), "rust-analyzer 1.95.0 (abc 2026-03-01)");
    const { record } = await build();
    expect(record["rust-analyzer"]).toMatchObject({ whose: "user", path: rustup });
  });

  test("no copy at all: the built-in rules build it, the note names the missing tool, and the layer records it missing", async () => {
    const { record, note } = await build();
    expect(note ?? "").toContain("rust: rust-analyzer cannot run (");
    expect(note ?? "").toContain("so the built-in rules");
    expect(record["rust-analyzer"]).toMatchObject({ whose: "missing", path: null });
  });

  test("the setting names a copy: it builds the layer, though the user has another", async () => {
    fakeRustAnalyzer(path.join(userBin, "rust-analyzer"), "rust-analyzer 1.95.0 (abc 2026-03-01)");
    const named = fakeRustAnalyzer(path.join(scratch, "named", "rust-analyzer"), "rust-analyzer 1.96.0 (fed 2026-04-01)");
    settingNames("rust-analyzer", named);
    const { record } = await build();
    expect(record["rust-analyzer"]).toMatchObject({ whose: "setting", path: named, tool: "rust-analyzer 1.96.0 (fed 2026-04-01)" });
  });

  test("tmb tools reads the languages of the indexed base branch", async () => {
    await build();
    const db = openGraphDb(project, null);
    try {
      expect(baseLanguages(db)).toEqual(["rust"]);
    } finally {
      db.close();
    }
  });
});

describe("the graph's store", () => {
  test("a record made before it named whose copy built the layer is dropped, so the layer is rebuilt", () => {
    const project = path.join(scratch, "store");
    mkdirSync(project);
    const db = openGraphDb(project, null);
    db.run("INSERT INTO layers (layer, commit_sha, extractor, built_at, files, symbols, edges, unresolved, links, built_with) VALUES ('base', 'abc', 1, 'then', 0, 0, 0, 0, 'language-tool', ?)", [
      JSON.stringify({ "rust-analyzer": { tool: "rust-analyzer 1.95.0", packages: "", places: [] } }),
    ]);
    db.run("PRAGMA user_version = 10");
    db.close();
    const upgraded = openGraphDb(project, null);
    try {
      expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
      expect(layerRow(upgraded, "base")).toMatchObject({ links: "language-tool", built_with: null });
    } finally {
      upgraded.close();
    }
  });
});

describe("tmb tools: each language with its tool and whose copy", () => {
  test("a language with its tool found, one with its tool missing, one with tmb's copy not installed yet, and one with no tool", () => {
    const mine = fakeProgram(path.join(userBin, "rust-analyzer"), "--version", "rust-analyzer 1.95.0 (abc 2026-03-01)");
    const rows = toolRows(["bash", "go", "rust", "typescript"], places());
    expect(rows).toEqual([
      { language: "bash", tool: null, whose: null, version: null, path: null, note: null },
      { language: "go", tool: goTypeChecker.name, whose: "missing", version: null, path: null, note: expect.stringContaining("`go`") },
      { language: "rust", tool: rustAnalyzerTool.name, whose: "user", version: "rust-analyzer 1.95.0 (abc 2026-03-01)", path: mine, note: null },
      { language: "typescript", tool: typescriptCompiler.name, whose: "missing", version: null, path: null, note: expect.stringContaining("tools install`") },
    ]);
    const lines = rows.map(toolLine);
    expect(lines[0]).toContain("no language tool");
    expect(lines[1]).toContain("missing");
    expect(lines[2]).toContain("the user's copy");
    expect(lines[2]).toContain(mine);
    expect(lines[3]).toContain("missing");
  });
});
