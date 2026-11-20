// tmb init and tmb onboard with fake host adapters: host choice, defaults, the questions and flags.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostAdapter, SUPPORTED_HOST_IDS } from "../src/adapters/index.ts";
import { openProjectStore, readSettings, reviewModeChosenVia, SettingError, type Settings, tiedProgram, TMB_EVENT_TYPES } from "../src/engine/index.ts";
import type { AuditEntry } from "../src/engine/store/index.ts";
import { type Ask, runInit, runOnboard, SetupError, type SetupFlags, type SetupOptions } from "../src/setup.ts";

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
    command: `host-${id}`,
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

type RunOptions = {
  adapters?: HostAdapter[];
  flags?: SetupFlags;
  ask?: Ask | null;
  supportedHostIds?: string[];
  program?: { name: string; version: string };
  tmbCommand?: string[];
  colour?: boolean;
};

function optionsOf(options: RunOptions): SetupOptions {
  const adapters = options.adapters ?? [A];
  return {
    projectDir: project,
    tmbCommand: options.tmbCommand ?? ["tmb"],
    program: options.program,
    adapters,
    supportedHostIds: options.supportedHostIds ?? adapters.map((adapter) => adapter.id),
    flags: options.flags ?? {},
    ask: options.ask ?? null,
    out: (line) => output.push(line),
    colour: options.colour,
  };
}

const init = (options: RunOptions = {}) => runInit(optionsOf(options));
const onboard = (options: RunOptions = {}) => runOnboard(optionsOf(options));
/** init, then onboard with the same options, as the Human runs them on a fresh project. */
async function initAndOnboard(options: RunOptions = {}): Promise<void> {
  await init(options);
  await onboard(options);
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
const chosenVia = () => {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return reviewModeChosenVia(opened.store);
  } finally {
    opened.store.close();
  }
};

const REVIEW_MODE_PROMPT = "Review mode, one of: agile, truest [agile]: ";
const NO_REVIEW_MODE_LINE =
  "No review mode is chosen, so no task starts yet: it is your choice, as it decides how many tokens the project uses. Run tmb onboard on a terminal, or tmb onboard --review-mode <agile|truest> --yes.";
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
    await init({ adapters: [A, B], ask });
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
    await init({ adapters: [A, B], flags: { host: "b" }, supportedHostIds: ["a"] });
    expect(output[1]).toBe(warning);
    expect(output.at(-1)).toBe(warning);
    output.length = 0;
    await init({ adapters: [A, B], flags: { host: "a" }, supportedHostIds: ["a"] });
    expect(output.join("\n")).not.toContain("Warning:");
  });

  test("in this release, only Claude Code is supported", () => {
    expect(SUPPORTED_HOST_IDS).toEqual(["claude-code"]);
  });
});

describe("tmb init", () => {
  test("with no terminal, asks nothing, sets only the host and its role, and ends saying how the settings get filled and that no task starts without a review mode", async () => {
    writeFileSync(path.join(project, "go.mod"), "module x\n");
    await init({ flags: { base: "main", reviewMode: "truest", checks: ["x"] } });
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: null, review_mode: null, checks: null });
    expect(output).toContain("Settings in the record:");
    expect(output.slice(-5)).toEqual([
      "tmb is set up for Host A. Next:",
      "  1. Run `host-a` in this folder.",
      "  2. Send `@bro`.",
      "The settings are still empty: base branch and checks; bro applies the ones it recommends. To set them yourself, run `tmb onboard`.",
      "No review mode is chosen yet: it is your choice, as it decides how many tokens the project uses. To choose it, bro asks you before the first task, or run `tmb onboard`; no task starts until it is set.",
    ]);
  });

  test("on a terminal, asks one question, the review mode, with what each mode costs, and records that init chose it", async () => {
    const ask = scripted(["truest"]);
    await init({ ask });
    expect(ask.prompts).toEqual([REVIEW_MODE_PROMPT]);
    expect(output).toContain("  agile: one review of each feature branch as a whole; the fewer tokens (recommended)");
    expect(output).toContain("  truest: a review of every task before its push; more tokens, as every task is reviewed");
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: null, review_mode: "truest", checks: null });
    expect(chosenVia()).toBe("init");
    expect(output.join("\n")).not.toContain("No review mode is chosen");

    // A project that has a review mode is not asked again.
    const again = scripted(["agile"]);
    await init({ ask: again });
    expect(again.prompts).toEqual([]);
    expect(settings().review_mode).toBe("truest");
  });

  test("on a terminal whose input ends before an answer, chooses nothing", async () => {
    const ask = scripted([]);
    await init({ ask });
    expect(ask.prompts).toEqual([REVIEW_MODE_PROMPT]);
    expect(settings().review_mode).toBeNull();
    expect(chosenVia()).toBeNull();
  });

  test("names the channel's program in the onboard hint", async () => {
    await init({ program: { name: "tmb-dev", version: "1.0.0-dev.1" } });
    expect(output.at(-2)).toEndWith("To set them yourself, run `tmb-dev onboard`.");
    expect(output.at(-1)).toContain("or run `tmb-dev onboard`;");
  });

  test("paints the commands to run when colour is on, and only then", async () => {
    await init({ colour: true });
    const painted = output.slice(-5).join("\n");
    expect(painted).toContain("`\u001b[1m\u001b[36mhost-a\u001b[39m\u001b[22m`");
    expect(painted).toContain("`\u001b[1m\u001b[36m@bro\u001b[39m\u001b[22m`");
    expect(painted).toContain("`\u001b[1m\u001b[36mtmb onboard\u001b[39m\u001b[22m`");
    output.length = 0;
    await init({ colour: false });
    expect(output.join("\n")).not.toContain("\u001b[");
  });

  test("keeps what onboard stored, and a re-run changes nothing", async () => {
    await init();
    await onboard({ flags: { base: "trunk", reviewMode: "truest", checks: ["make check"], role: "reviewer" } });
    expect(chosenVia()).toBe("onboard");
    const recorded = auditCount();
    output.length = 0;
    await init({ ask: scripted(["agile"]) });
    expect(settings()).toEqual({ host: "a", host_roles: { a: "reviewer" }, base_branch: "trunk", review_mode: "truest", checks: ["make check"] });
    expect(auditCount()).toBe(recorded);
    expect(output).toContain("No setting changed, so nothing was recorded.");
    expect(output.slice(-3)).toEqual(["tmb is set up for Host A. Next:", "  1. Run `host-a` in this folder; it starts as the reviewer.", "To change the settings, run `tmb onboard`."]);
  });

  test("sets the role --role names, and a reviewer host leaves the settings to the planner's", async () => {
    await init({ flags: { role: "reviewer" } });
    expect(settings().host_roles).toEqual({ a: "reviewer" });
    expect(output.at(-2)).toBe(
      "The settings are still empty: base branch and checks; the planner's host applies the ones it recommends at its first session. To set them yourself, run `tmb onboard`.",
    );
    expect(output.at(-1)).toBe(
      "No review mode is chosen yet: it is your choice, as it decides how many tokens the project uses. To choose it, run `tmb onboard`; no task starts until it is set.",
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
    // Three settings, and which way the review mode was chosen.
    expect(auditCount()).toBe(before + 4);
    expect(chosenVia()).toBe("onboard");
    await onboard({ ask: scripted(["reviewer", "", "truest", "make test", ""]) });
    expect(settings()).toEqual({ host: "a", host_roles: { a: "reviewer" }, base_branch: "release", review_mode: "truest", checks: ["make test"] });
    expect(auditCount()).toBe(before + 8);
  });

  test("sets the role of the host --host names, keeping the others'", async () => {
    await init({ adapters: [A, B], flags: { host: "a" } });
    await init({ adapters: [A, B], flags: { host: "b" } });
    await onboard({ adapters: [A, B], flags: { host: "a", role: "reviewer" } });
    expect(settings().host_roles).toEqual({ a: "reviewer", b: "planner" });
  });
});

describe("the questions", () => {
  test("without a terminal, take the defaults but never choose the review mode, and print each value stored", async () => {
    writeFileSync(path.join(project, "go.mod"), "module x\n");
    await initAndOnboard();
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: null, review_mode: null, checks: ["go test ./..."] });
    expect(output).toContain(
      "There is no terminal to ask on, so each question takes its default, except the review mode, which is yours to choose; --role, --base, --review-mode and --check set them.",
    );
    expect(output).toContain("Settings in the record:");
    expect(output).toContain("  host: a");
    expect(output).toContain("  base branch: (not set)");
    expect(output).toContain("  review mode: (not set)");
    expect(output.at(-1)).toBe(NO_REVIEW_MODE_LINE);
    expect(output).toContain('  checks: "go test ./..."');
    expect(output).toContain("No base branch is set: this folder is not a git work tree. Run tmb onboard --base <branch> to set one.");
  });

  test("on a terminal, are asked in turn showing their default, and the answers stored", async () => {
    writeFileSync(path.join(project, "Cargo.toml"), "");
    const ask = scripted(["", "", "trunk", "", "cargo test", "cargo clippy", ""]);
    await initAndOnboard({ ask });
    expect(ask.prompts).toEqual([
      REVIEW_MODE_PROMPT,
      "Role of Host A's main agent, one of: planner, reviewer [planner]: ",
      "Base branch, the branch pull requests merge into: ",
      REVIEW_MODE_PROMPT,
      "> ",
      "> ",
      "> ",
    ]);
    expect(output).toContain("  Detected:");
    expect(output).toContain("    cargo test");
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: "trunk", review_mode: "agile", checks: ["cargo test", "cargo clippy"] });
  });

  test("with no detected base branch, asks again until it gets one", async () => {
    const ask = scripted(["", "", "", "  ", "main"]);
    await initAndOnboard({ ask });
    expect(ask.prompts.slice(2, 5)).toEqual(Array(3).fill("Base branch, the branch pull requests merge into: "));
    expect(settings().base_branch).toBe("main");
  });

  test("refuse a role or review mode that does not exist, and ask again", async () => {
    const ask = scripted(["strict", "truest", "boss", "reviewer", "main", ""]);
    await initAndOnboard({ ask });
    expect(output).toContain('a host\'s role must be planner or reviewer, got "boss"');
    expect(output).toContain('review mode must be agile or truest, got "strict"');
    expect(settings().review_mode).toBe("truest");
    expect(settings().host_roles).toEqual({ a: "reviewer" });
  });

  test("none clears the checks; Enter keeps the default", async () => {
    writeFileSync(path.join(project, "go.mod"), "");
    await initAndOnboard({ ask: scripted(["", "", "main", "", "none"]) });
    expect(settings().checks).toEqual([]);
    await initAndOnboard({ ask: scripted(["", "", "", ""]) });
    expect(output).toContain("  Stored: none.");
    expect(settings().checks).toEqual([]);
  });

  test("a re-run offers the stored answers as defaults and, given them back, records nothing", async () => {
    writeFileSync(path.join(project, "go.mod"), "");
    await initAndOnboard({ flags: { base: "develop", reviewMode: "agile", checks: ["make check"] } });
    const recorded = auditCount();
    // Five settings, which way the review mode was chosen, and the program the project is tied to.
    expect(recorded).toBe(7);
    output = [];
    const ask = scripted([]);
    await initAndOnboard({ ask });
    expect(ask.prompts[1]).toBe("Base branch, the branch pull requests merge into [develop]: ");
    expect(output).toContain("    make check");
    expect(output).toContain("No setting changed, so nothing was recorded.");
    expect(auditCount()).toBe(recorded);
  });
});

describe("the program the project is tied to (trustmybot/tmb#89)", () => {
  test("is the one whose init wired it, and moves only when another program's init runs; another version is recorded quietly", async () => {
    await init({ program: { name: "tmb-dev", version: "1.0.0-dev.3" }, tmbCommand: ["/bin/tmb-dev"] });
    expect(output).toContain("This project runs tmb-dev: its hooks and tool server call /bin/tmb-dev.");
    const opened = openProjectStore(project, { create: false });
    if (!opened.ok) throw opened.error;
    try {
      expect(tiedProgram(opened.store)).toEqual({ program: "tmb-dev", version: "1.0.0-dev.3", command: ["/bin/tmb-dev"] });
    } finally {
      opened.store.close();
    }

    output = [];
    const before = auditCount();
    await init({ program: { name: "tmb-dev", version: "1.0.0-dev.4" }, tmbCommand: ["/bin/tmb-dev"] });
    expect(output.some((line) => line.startsWith("This project runs") || line.startsWith("Moved"))).toBe(false);
    // The record names the version that last wired the project, so a session start can tell when to refresh (trustmybot/tmb#128).
    expect(auditCount()).toBe(before + 1);
    const reopened = openProjectStore(project, { create: false });
    if (!reopened.ok) throw reopened.error;
    try {
      expect(tiedProgram(reopened.store)?.version).toBe("1.0.0-dev.4");
    } finally {
      reopened.store.close();
    }

    output = [];
    await init({ program: { name: "tmb", version: "1.0.0" }, tmbCommand: ["/bin/tmb"] });
    expect(output).toContain("Moved this project from tmb-dev 1.0.0-dev.4 to tmb 1.0.0.");
    expect(output).toContain("This project runs tmb: its hooks and tool server call /bin/tmb.");
  });
});

describe("flags", () => {
  test("answer their questions without asking and override the defaults; --yes takes the rest but not the review mode", async () => {
    writeFileSync(path.join(project, "go.mod"), "");
    await init();
    const ask = scripted([]);
    await onboard({ ask, flags: { base: "release", checks: ["make lint", "make test"], yes: true } });
    expect(ask.prompts).toEqual([]);
    expect(output).toContain(
      "--yes was given, so each question takes its default, except the review mode, which is yours to choose; --role, --base, --review-mode and --check set them.",
    );
    expect(settings()).toEqual({ host: "a", host_roles: { a: "planner" }, base_branch: "release", review_mode: null, checks: ["make lint", "make test"] });
    expect(output.at(-1)).toBe(NO_REVIEW_MODE_LINE);

    // --review-mode with --yes sets it without a question, for scripts.
    await onboard({ ask, flags: { reviewMode: "truest", yes: true } });
    expect(ask.prompts).toEqual([]);
    expect(settings().review_mode).toBe("truest");
    expect(chosenVia()).toBe("onboard");
  });

  test("answer only their own question on a terminal", async () => {
    await init();
    const ask = scripted([""]);
    await onboard({ ask, flags: { base: "main", reviewMode: "agile", role: "planner" } });
    expect(ask.prompts).toEqual(["> "]);
    expect(settings().base_branch).toBe("main");
  });

  test("refuse an unknown review mode and a blank check before anything is written", async () => {
    await expect(onboard({ flags: { reviewMode: "strict" } })).rejects.toThrow(new SettingError('review mode must be agile or truest, got "strict"'));
    await expect(onboard({ flags: { checks: ["bun test", ""] } })).rejects.toThrow(SettingError);
    await expect(onboard({ flags: { base: " " } })).rejects.toThrow(SettingError);
    await expect(onboard({ flags: { role: "boss" } })).rejects.toThrow(SettingError);
    expect(setUpWith).toEqual([]);
    expect(existsSync(path.join(project, ".tmb"))).toBe(false);
  });
});
