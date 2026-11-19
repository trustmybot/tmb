// tmb init, tmb onboard and tmb setup with fake host adapters: host choice, defaults, the questions and flags.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostAdapter, SUPPORTED_HOST_IDS } from "../src/adapters/index.ts";
import { openProjectStore, readSettings, SettingError, type Settings, TMB_EVENT_TYPES } from "../src/engine/index.ts";
import type { AuditEntry } from "../src/engine/store/index.ts";
import { type Ask, runInit, runOnboard, runSetup, SetupError, type SetupFlags, type SetupOptions } from "../src/setup.ts";

let project: string;
let output: string[];
let setUpWith: string[];

beforeEach(() => {
  // Not a git work tree, so the base branch has no detected default unless a test makes one.
  project = mkdtempSync(path.join(tmpdir(), "tmb-setup-"));
  output = [];
  setUpWith = [];
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

/** A host adapter whose setup only creates the record, as every real one does first. */
function fakeHost(id: string, installed: boolean): HostAdapter {
  return {
    id,
    name: `Host ${id.toUpperCase()}`,
    limits: { canDenyToolCall: true, modelPerRole: true, namesAgentOnToolCall: true, events: TMB_EVENT_TYPES },
    detect: () => ({ installed }),
    setup(projectDir) {
      setUpWith.push(id);
      const opened = openProjectStore(projectDir, { create: true });
      if (!opened.ok) throw opened.error;
      opened.store.close();
      return [`wired ${id}`];
    },
    remove: () => [],
    answerHook: () => "",
  };
}

const A = fakeHost("a", true);
const B = fakeHost("b", true);
const MISSING = fakeHost("c", false);

/** An asker that gives the scripted answers in turn, then ends input, keeping each prompt. */
function scripted(answers: (string | null)[]): Ask & { prompts: string[] } {
  const prompts: string[] = [];
  const ask = async (prompt: string) => {
    prompts.push(prompt);
    return answers.length > 0 ? answers.shift()! : null;
  };
  return Object.assign(ask, { prompts });
}

type RunOptions = { adapters?: HostAdapter[]; flags?: SetupFlags; ask?: Ask | null; supportedHostIds?: string[] };

function optionsOf(options: RunOptions): SetupOptions {
  const adapters = options.adapters ?? [A];
  return {
    projectDir: project,
    tmbCommand: ["tmb"],
    adapters,
    supportedHostIds: options.supportedHostIds ?? adapters.map((adapter) => adapter.id),
    flags: options.flags ?? {},
    ask: options.ask ?? null,
    out: (line) => output.push(line),
  };
}

const setup = (options: RunOptions = {}) => runSetup(optionsOf(options));
const init = (options: RunOptions = {}) => runInit(optionsOf(options));
const onboard = (options: RunOptions = {}) => runOnboard(optionsOf(options));

function record<T>(read: (settings: Settings, audit: AuditEntry[]) => T): T {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return read(readSettings(opened.store), opened.store.listAudit());
  } finally {
    opened.store.close();
  }
}

const settings = () => record((current) => current);
const auditCount = () => record((_, audit) => audit.length);

describe("choosing the host", () => {
  test("with none installed, fails naming every supported host and writes nothing", async () => {
    await expect(init({ adapters: [MISSING, fakeHost("d", false)] })).rejects.toThrow(
      new SetupError("no supported host is installed; tmb supports Host C (c) and Host D (d). Install one, then run tmb init again."),
    );
    expect(readdirSync(project)).toEqual([]);
    expect(setUpWith).toEqual([]);
  });

  test("with one installed, says which and uses it", async () => {
    await init({ adapters: [MISSING, A] });
    expect(setUpWith).toEqual(["a"]);
    expect(output[0]).toBe("Found Host A, the one supported host installed; setting tmb up for it.");
    expect(settings().host).toBe("a");
  });

  test("with several installed, never asks: takes the stored host, else the first, and names --host", async () => {
    const ask = scripted(["2"]);
    await setup({ adapters: [A, B], ask });
    expect(output[0]).toBe("Several hosts are installed (Host A and Host B); taking Host A. Pass --host to choose.");
    expect(ask.prompts).not.toContain("Which host should tmb use? [a] ");
    expect(settings().host).toBe("a");
    await init({ adapters: [A, B], flags: { host: "b" } });
    await init({ adapters: [A, B] });
    expect(setUpWith).toEqual(["a", "b", "b"]);
    expect(settings().host).toBe("b");
  });

  test("--host picks the host and refuses one unknown or not installed, before writing anything", async () => {
    await expect(init({ adapters: [A, MISSING], flags: { host: "zz" } })).rejects.toThrow(/unknown host 'zz'; tmb supports Host A \(a\) and Host C \(c\)/);
    await expect(init({ adapters: [A, MISSING], flags: { host: "c" } })).rejects.toThrow("Host C is not installed");
    expect(readdirSync(project)).toEqual([]);
    await init({ adapters: [A, B], flags: { host: "b" } });
    expect(setUpWith).toEqual(["b"]);
  });
});

describe("a host this release does not support yet", () => {
  test("is set up so it can be tried, with a warning first and last", async () => {
    const warning = "Warning: Host B is not supported yet in this release: tmb sets it up so you can try it, but nothing guarantees it works.";
    for (const run of [init, setup]) {
      output.length = 0;
      await run({ adapters: [A, B], flags: { host: "b" }, supportedHostIds: ["a"] });
      expect(output[1]).toBe(warning);
      expect(output.at(-1)).toBe(warning);
    }
    output.length = 0;
    await init({ adapters: [A, B], flags: { host: "a" }, supportedHostIds: ["a"] });
    expect(output.join("\n")).not.toContain("Warning:");
  });

  test("in this release, only Claude Code is supported", () => {
    expect(SUPPORTED_HOST_IDS).toEqual(["claude-code"]);
  });
});

describe("tmb init", () => {
  test("asks nothing, sets only the host and its role, and ends saying the settings are empty and how they get filled", async () => {
    writeFileSync(path.join(project, "go.mod"), "module x\n");
    const ask = scripted(["should not be read"]);
    await init({ ask, flags: { base: "main", reviewMode: "truest", checks: ["x"] } });
    expect(ask.prompts).toEqual([]);
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: null, review_mode: null, checks: null });
    expect(output).toContain("Settings in the record:");
    expect(output).toContain("tmb is set up for Host A. Open it in this project to start as the planner.");
    expect(output.at(-1)).toBe(
      "The settings are still empty: base branch, review mode and checks. When you open Host A here, the planner applies the ones it recommends for this project and shows them; " +
        "run tmb onboard to set them yourself instead, at any time.",
    );
  });

  test("keeps what onboard stored, and a re-run changes nothing", async () => {
    await init();
    await onboard({ flags: { base: "trunk", reviewMode: "truest", checks: ["make check"], role: "reviewer" } });
    const recorded = auditCount();
    output.length = 0;
    await init();
    expect(settings()).toEqual({ host: "a", host_roles: { a: "reviewer" }, base_branch: "trunk", review_mode: "truest", checks: ["make check"] });
    expect(auditCount()).toBe(recorded);
    expect(output).toContain("No setting changed, so nothing was recorded.");
    expect(output.at(-1)).toBe("Run tmb onboard to change the settings, at any time.");
  });

  test("sets the role --role names, and a reviewer host leaves the settings to the planner's", async () => {
    await init({ flags: { role: "reviewer" } });
    expect(settings().host_roles).toEqual({ a: "reviewer" });
    expect(output.at(-1)).toBe(
      "The settings are still empty: base branch, review mode and checks. The planner's host applies the ones it recommends at its first session; run tmb onboard to set them yourself, at any time.",
    );
  });

  test("refuses an unknown role before anything is written", async () => {
    await expect(init({ flags: { role: "boss" } })).rejects.toThrow(new SettingError('a host\'s role must be planner or reviewer, got "boss"'));
    expect(setUpWith).toEqual([]);
    expect(existsSync(path.join(project, ".tmb"))).toBe(false);
  });
});

describe("tmb onboard", () => {
  test("refuses a project init has not prepared, and writes nothing", async () => {
    await expect(onboard({ flags: { base: "main" } })).rejects.toThrow(new SetupError("tmb is not set up in this project; run tmb init first"));
    expect(readdirSync(project)).toEqual([]);
  });

  test("refuses a host init has not wired", async () => {
    await init();
    await expect(onboard({ adapters: [A, B], flags: { host: "b", role: "reviewer" } })).rejects.toThrow(
      new SetupError("Host B is not set up in this project; run tmb init --host b first"),
    );
  });

  test("changes a setting, and can be run twice", async () => {
    await init();
    const before = auditCount();
    await onboard({ ask: scripted(["", "release", "", ""]) });
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: "release", review_mode: "agile", checks: [] });
    expect(auditCount()).toBe(before + 3);
    await onboard({ ask: scripted(["reviewer", "", "truest", "make test", ""]) });
    expect(settings()).toEqual({ host: "a", host_roles: { a: "reviewer" }, base_branch: "release", review_mode: "truest", checks: ["make test"] });
    expect(auditCount()).toBe(before + 6);
  });

  test("sets the role of the host --host names, keeping the others'", async () => {
    await init({ adapters: [A, B], flags: { host: "a" } });
    await init({ adapters: [A, B], flags: { host: "b" } });
    await onboard({ adapters: [A, B], flags: { host: "a", role: "reviewer" } });
    expect(settings().host_roles).toEqual({ a: "reviewer", b: "planner" });
  });
});

describe("the questions", () => {
  test("without a terminal, take the defaults and print each value stored", async () => {
    writeFileSync(path.join(project, "go.mod"), "module x\n");
    await setup();
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: null, review_mode: "agile", checks: ["go test ./..."] });
    expect(output).toContain("There is no terminal to ask on, so each question takes its default; --role, --base, --review-mode and --check set them.");
    expect(output).toContain("Settings in the record:");
    expect(output).toContain("  host: a");
    expect(output).toContain("  base branch: (not set)");
    expect(output).toContain("  review mode: agile");
    expect(output).toContain('  checks: "go test ./..."');
    expect(output).toContain("No base branch is set: this folder is not a git work tree. Run tmb onboard --base <branch> to set one.");
    expect(output.at(-1)).toBe("tmb is set up for Host A. Open it in this project to start as the planner.");
  });

  test("on a terminal, are asked in turn showing their default, and the answers stored", async () => {
    writeFileSync(path.join(project, "Cargo.toml"), "");
    const ask = scripted(["", "trunk", "", "cargo test", "cargo clippy", ""]);
    await setup({ ask });
    expect(ask.prompts).toEqual([
      "Role of Host A's main agent, one of: planner, reviewer [planner]: ",
      "Base branch, the branch pull requests merge into: ",
      "Review mode, one of: agile, truest [agile]: ",
      "> ",
      "> ",
      "> ",
    ]);
    expect(output).toContain("  Detected:");
    expect(output).toContain("    cargo test");
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: "trunk", review_mode: "agile", checks: ["cargo test", "cargo clippy"] });
  });

  test("with no detected base branch, asks again until it gets one", async () => {
    const ask = scripted(["", "", "  ", "main"]);
    await setup({ ask });
    expect(ask.prompts.slice(1, 4)).toEqual(Array(3).fill("Base branch, the branch pull requests merge into: "));
    expect(settings().base_branch).toBe("main");
  });

  test("refuse a role or review mode that does not exist, and ask again", async () => {
    const ask = scripted(["boss", "reviewer", "main", "strict", "truest"]);
    await setup({ ask });
    expect(output).toContain('a host\'s role must be planner or reviewer, got "boss"');
    expect(output).toContain('review mode must be agile or truest, got "strict"');
    expect(settings().review_mode).toBe("truest");
    expect(settings().host_roles).toEqual({ a: "reviewer" });
  });

  test("none clears the checks; Enter keeps the default", async () => {
    writeFileSync(path.join(project, "go.mod"), "");
    await setup({ ask: scripted(["", "main", "", "none"]) });
    expect(settings().checks).toEqual([]);
    await setup({ ask: scripted(["", "", "", ""]) });
    expect(output).toContain("  Stored: none.");
    expect(settings().checks).toEqual([]);
  });

  test("a re-run offers the stored answers as defaults and, given them back, records nothing", async () => {
    writeFileSync(path.join(project, "go.mod"), "");
    await setup({ flags: { base: "develop", checks: ["make check"] } });
    const recorded = auditCount();
    expect(recorded).toBe(5);
    output = [];
    const ask = scripted([]);
    await setup({ ask });
    expect(ask.prompts[1]).toBe("Base branch, the branch pull requests merge into [develop]: ");
    expect(output).toContain("    make check");
    expect(output).toContain("No setting changed, so nothing was recorded.");
    expect(auditCount()).toBe(recorded);
  });
});

describe("flags", () => {
  test("answer their questions without asking and override the defaults; --yes takes the rest", async () => {
    writeFileSync(path.join(project, "go.mod"), "");
    const ask = scripted([]);
    await setup({ ask, flags: { base: "release", checks: ["make lint", "make test"], yes: true } });
    expect(ask.prompts).toEqual([]);
    expect(output).toContain("--yes was given, so each question takes its default; --role, --base, --review-mode and --check set them.");
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: "release", review_mode: "agile", checks: ["make lint", "make test"] });
  });

  test("answer only their own question on a terminal", async () => {
    const ask = scripted([""]);
    await setup({ ask, flags: { base: "main", reviewMode: "agile", role: "planner" } });
    expect(ask.prompts).toEqual(["> "]);
    expect(settings().base_branch).toBe("main");
  });

  test("refuse an unknown review mode and a blank check before anything is written", async () => {
    await expect(setup({ flags: { reviewMode: "strict" } })).rejects.toThrow(new SettingError('review mode must be agile or truest, got "strict"'));
    await expect(setup({ flags: { checks: ["bun test", ""] } })).rejects.toThrow(SettingError);
    await expect(setup({ flags: { base: " " } })).rejects.toThrow(SettingError);
    await expect(onboard({ flags: { role: "boss" } })).rejects.toThrow(SettingError);
    expect(setUpWith).toEqual([]);
    expect(existsSync(path.join(project, ".tmb"))).toBe(false);
  });
});
