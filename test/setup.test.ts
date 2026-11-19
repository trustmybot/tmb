// The setup flow with fake host adapters: host choice, the questions, flags and defaults.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HostAdapter } from "../src/adapters/index.ts";
import { openProjectStore, readSettings, SettingError, type Settings, TMB_EVENT_TYPES } from "../src/engine/index.ts";
import type { AuditEntry } from "../src/engine/store/index.ts";
import { type Ask, runSetup, SetupError, type SetupFlags } from "../src/setup.ts";

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

function setup(options: { adapters?: HostAdapter[]; flags?: SetupFlags; ask?: Ask | null } = {}): Promise<void> {
  return runSetup({
    projectDir: project,
    tmbCommand: ["tmb"],
    adapters: options.adapters ?? [A],
    flags: options.flags ?? {},
    ask: options.ask ?? null,
    out: (line) => output.push(line),
  });
}

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
    await expect(setup({ adapters: [MISSING, fakeHost("d", false)] })).rejects.toThrow(
      new SetupError("no supported host is installed; tmb supports Host C (c) and Host D (d). Install one, then run tmb setup again."),
    );
    expect(readdirSync(project)).toEqual([]);
    expect(setUpWith).toEqual([]);
  });

  test("with one installed, says which and uses it", async () => {
    await setup({ adapters: [MISSING, A] });
    expect(setUpWith).toEqual(["a"]);
    expect(output[0]).toBe("Found Host A, the one supported host installed; setting tmb up for it.");
    expect(settings().host).toBe("a");
  });

  test("with several installed, asks which, by number or id, asking again after a wrong answer", async () => {
    const ask = scripted(["x", "2", ""]);
    await setup({ adapters: [A, B], ask });
    expect(setUpWith).toEqual(["b"]);
    expect(ask.prompts.slice(0, 2)).toEqual(["Which host should tmb use? [a] ", "Which host should tmb use? [a] "]);
    expect(output).toContain("'x' is not one of them; answer with its number or its id.");
    expect(settings().host).toBe("b");
  });

  test("with several installed and no terminal, takes the stored host, else the first", async () => {
    await setup({ adapters: [A, B] });
    expect(settings().host).toBe("a");
    await setup({ adapters: [A, B], flags: { host: "b" } });
    await setup({ adapters: [A, B] });
    expect(setUpWith).toEqual(["a", "b", "b"]);
    expect(settings().host).toBe("b");
  });

  test("--host picks the host and refuses one unknown or not installed, before writing anything", async () => {
    await expect(setup({ adapters: [A, MISSING], flags: { host: "zz" } })).rejects.toThrow(/unknown host 'zz'; tmb supports Host A \(a\) and Host C \(c\)/);
    await expect(setup({ adapters: [A, MISSING], flags: { host: "c" } })).rejects.toThrow("Host C is not installed");
    expect(readdirSync(project)).toEqual([]);
    await setup({ adapters: [A, B], flags: { host: "b" }, ask: scripted([]) });
    expect(setUpWith).toEqual(["b"]);
  });
});

describe("the questions", () => {
  test("without a terminal, takes the defaults and prints each value it stored", async () => {
    writeFileSync(path.join(project, "go.mod"), "module x\n");
    await setup();
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: null, review_mode: "agile", checks: ["go test ./..."] });
    expect(output).toContain("There is no terminal to ask on, so each question takes its default; --base, --review-mode and --check set them.");
    expect(output).toContain("Settings in the record:");
    expect(output).toContain("  host: a");
    expect(output).toContain("  base branch: (not set)");
    expect(output).toContain("  review mode: agile");
    expect(output).toContain('  checks: "go test ./..."');
    expect(output).toContain("No base branch is set: this folder is not a git work tree. Run tmb setup --base <branch> to set one.");
    expect(output.at(-1)).toBe("tmb is set up for Host A. Open it in this project to start as the planner.");
  });

  test("on a terminal, asks each question in turn showing its default, and stores the answers", async () => {
    writeFileSync(path.join(project, "Cargo.toml"), "");
    const ask = scripted(["trunk", "", "cargo test", "cargo clippy", ""]);
    await setup({ ask });
    expect(ask.prompts).toEqual(["Base branch, the branch pull requests merge into: ", "Review mode, one of: agile, truest [agile]: ", "> ", "> ", "> "]);
    expect(output).toContain("  Detected:");
    expect(output).toContain("    cargo test");
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: "trunk", review_mode: "agile", checks: ["cargo test", "cargo clippy"] });
  });

  test("with no detected base branch, asks again until it gets one", async () => {
    const ask = scripted(["", "  ", "main"]);
    await setup({ ask });
    expect(ask.prompts.slice(0, 3)).toEqual(Array(3).fill("Base branch, the branch pull requests merge into: "));
    expect(settings().base_branch).toBe("main");
  });

  test("refuses a review mode that does not exist, and asks again", async () => {
    const ask = scripted(["main", "strict", "truest"]);
    await setup({ ask });
    expect(output).toContain('review mode must be agile or truest, got "strict"');
    expect(settings().review_mode).toBe("truest");
  });

  test("none clears the checks; Enter keeps the default", async () => {
    writeFileSync(path.join(project, "go.mod"), "");
    await setup({ ask: scripted(["main", "", "none"]) });
    expect(settings().checks).toEqual([]);
    await setup({ ask: scripted(["", "", ""]) });
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
    expect(ask.prompts[0]).toBe("Base branch, the branch pull requests merge into [develop]: ");
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
    expect(output).toContain("--yes was given, so each question takes its default; --base, --review-mode and --check set them.");
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: "release", review_mode: "agile", checks: ["make lint", "make test"] });
  });

  test("answer only their own question on a terminal", async () => {
    const ask = scripted(["", ""]);
    await setup({ ask, flags: { base: "main", reviewMode: "agile" } });
    expect(ask.prompts).toEqual(["> "]);
    expect(settings().base_branch).toBe("main");
  });

  test("refuse an unknown review mode and a blank check before anything is written", async () => {
    await expect(setup({ flags: { reviewMode: "strict" } })).rejects.toThrow(new SettingError('review mode must be agile or truest, got "strict"'));
    await expect(setup({ flags: { checks: ["bun test", ""] } })).rejects.toThrow(SettingError);
    await expect(setup({ flags: { base: " " } })).rejects.toThrow(SettingError);
    expect(setUpWith).toEqual([]);
    expect(existsSync(path.join(project, ".tmb"))).toBe(false);
  });
});
