// tmb init and the tools a repo's languages miss (CODE_GRAPH.md, "Where a language's tool comes
// from"; 2_ONBOARD.md): init asks nothing and reads no input, on a terminal or not
// (trustmybot/tmb#414). It names the tools the repo's languages miss and `tmb tools install`, whose
// run is the yes; it downloads nothing. A language's own toolchain is never offered. No test
// downloads anything: the release is a small archive a fetch the test gives returns, and each test
// shows it is never fetched.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { HostAdapter } from "../../src/adapters/index.ts";
import { openProjectStore, TMB_EVENT_TYPES } from "../../src/engine/index.ts";
import type { ToolRelease } from "../../src/engine/graph/languages/contract.ts";
import { toolsFolder } from "../../src/engine/graph/tool-copy.ts";
import type { InstallOptions } from "../../src/engine/graph/tool-install.ts";
import { type Ask, runInit } from "../../src/setup.ts";

setDefaultTimeout(30_000);

let scratch: string;
let project: string;
let state: string;
let userBin: string;
let output: string[];
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

const HOST: HostAdapter = {
  id: "a",
  name: "Host A",
  command: "host-a",
  reconnectToolServer: "restart the host",
  limits: { canDenyToolCall: true, modelPerRole: true, namesAgentOnToolCall: true, events: TMB_EVENT_TYPES },
  detect: () => ({ installed: true }),
  setup(projectDir) {
    const opened = openProjectStore(projectDir, { create: true });
    if (!opened.ok) throw opened.error;
    opened.store.close();
    return ["wired a"];
  },
  remove: () => [],
  answerHook: () => "",
};

/** A repo of one commit holding the files given. */
function repoWith(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
}

const RUST = { "Cargo.toml": '[package]\nname = "orchard"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": "pub fn pick() -> i32 { 1 }\n" };
const GO = { "go.mod": "module example.com/orchard\n\ngo 1.22\n", "main.go": "package main\n\nfunc main() {}\n" };

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-init-tools-")));
  project = path.join(scratch, "project");
  state = path.join(scratch, "state");
  userBin = path.join(scratch, "user-bin");
  mkdirSync(project);
  mkdirSync(state);
  mkdirSync(userBin);
  output = [];
  // A PATH that holds git alone, and a Cargo home with no rustup copy: no copy of a tool is found.
  const gitOnly = path.join(scratch, "git-only");
  mkdirSync(gitOnly);
  symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), path.join(gitOnly, "git"));
  setEnv("PATH", `${userBin}${path.delimiter}${gitOnly}`);
  setEnv("TMB_STATE_DIR", state);
  setEnv("CARGO_HOME", path.join(scratch, "cargo"));
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** An asker that gives the answers in turn and keeps each prompt. */
function scripted(answers: string[]): Ask & { prompts: string[] } {
  const prompts: string[] = [];
  const ask = async (prompt: string) => {
    prompts.push(prompt);
    return answers.shift() ?? null;
  };
  return Object.assign(ask, { prompts });
}

/** A release of rust-analyzer for this machine that the fetch below serves, and each URL fetched. */
function fakeRelease(): { install: InstallOptions; fetched: string[] } {
  const bytes = gzipSync(new TextEncoder().encode("#!/bin/sh\necho 'rust-analyzer 0.3.3113-standalone (e5e7830640 2026-11-08)'\n"));
  const release: ToolRelease = {
    version: "2026-11-09",
    page: "https://example.invalid/",
    assets: { [`${process.platform}-${process.arch}`]: { url: "https://example.invalid/rust-analyzer.gz", sha256: createHash("sha256").update(bytes).digest("hex"), archive: { format: "gzip" } } },
  };
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    return new Response(bytes);
  };
  return { fetched, install: { places: { searchPath: userBin, stateDir: state }, fetch, releaseOf: (copy) => ("program" in copy && copy.program === "rust-analyzer" ? release : undefined) } };
}

const init = (ask: Ask | null, tools: InstallOptions) => runInit({ projectDir: project, tmbCommand: ["tmb"], adapters: [HOST], supportedHostIds: ["a"], flags: {}, ask, out: (line) => output.push(line), tools });
const installed = () => existsSync(path.join(toolsFolder(state), "rust-analyzer", "bin", "rust-analyzer"));

describe("tmb init and the tools a repo misses", () => {
  test("on a terminal, an asker that would say yes is never asked: nothing is downloaded, and the tool and the command are named", async () => {
    repoWith(RUST);
    const { install, fetched } = fakeRelease();
    const ask = scripted(["y", "y"]);
    await init(ask, install);
    expect(ask.prompts).toEqual([]);
    expect(fetched).toEqual([]);
    expect(installed()).toBe(false);
    const said = output.join("\n");
    expect(said).toContain("rust-analyzer");
    expect(said).toContain("`tmb tools install`");
  });

  test("with no one to ask, nothing is downloaded, and the missing tool and the command are named", async () => {
    repoWith(RUST);
    const { install, fetched } = fakeRelease();
    await init(null, install);
    expect(fetched).toEqual([]);
    expect(installed()).toBe(false);
    const said = output.join("\n");
    expect(said).toContain("rust-analyzer");
    expect(said).toContain("`tmb tools install");
  });

  test("with installs turned off, nothing is asked or downloaded, and init says installs are off", async () => {
    repoWith(RUST);
    writeFileSync(path.join(state, "tools.json"), JSON.stringify({ install: false }));
    const { install, fetched } = fakeRelease();
    const ask = scripted(["y"]);
    await init(ask, install);
    expect(ask.prompts).toEqual([]);
    expect(fetched).toEqual([]);
    expect(installed()).toBe(false);
    expect(output.join("\n")).toContain("installs are off");
  });

  test("a language's toolchain is never offered: a Go repo with no `go` asks nothing", async () => {
    repoWith(GO);
    const { install, fetched } = fakeRelease();
    const ask = scripted(["y"]);
    await init(ask, install);
    expect(ask.prompts).toEqual([]);
    expect(fetched).toEqual([]);
  });
});
