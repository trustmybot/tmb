// The feedback program (trustmybot/tmb#122): the setting per program, the first run's notice or
// question, the report's contents and cleaning, the bug form it follows, the two routes, and
// the Human's yes before anything is sent.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFeedbackCommand } from "../../src/cli/commands/feedback.ts";
import { FEEDBACK_HEADING, firstRunAtInit, firstRunSection } from "../../src/engine/feedback/first-run.ts";
import {
  builtInBugForm,
  cleanText,
  type FeedbackEnv,
  type FeedbackGithub,
  feedbackRepoFrom,
  feedbackStatus,
  FORM_LINK_MAX,
  formLink,
  issueBody,
  KNOWN_FIELDS,
  keepLastError,
  parseForm,
  readBugForm,
  readDraft,
  readFeedbackState,
  REMOVED,
  reportValues,
} from "../../src/engine/feedback/index.ts";
import { feedbackDraft, feedbackSend, HandlerError, OPERATIONS } from "../../src/engine/handlers/index.ts";
import { handleEvent, openProjectStore } from "../../src/engine/index.ts";
import type { Program } from "../../src/engine/program.ts";
import type { Actor, Store } from "../../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ROOT = path.resolve(import.meta.dir, "../..");
const PLANNER: Actor = { kind: "agent", role: "planner", host: "test" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "test" };
const HOME = "/Users/someone";
const DEV: Program = { name: "tmb-dev", channel: "dev" };
const STABLE: Program = { name: "tmb", channel: "stable" };

type FakeGithub = FeedbackGithub & { issues: { title: string; body: string }[] };

function fakeGithub(signedIn: boolean): FakeGithub {
  const issues: { title: string; body: string }[] = [];
  return {
    issues,
    signedIn: () => signedIn,
    createIssue: (_repo, title, body) => {
      issues.push({ title, body });
      return `https://github.com/trustmybot/tmb/issues/${900 + issues.length}`;
    },
  };
}

let stateDir: string;
let project: string;
let opened: string[];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "tmb-feedback-state-"));
  project = mkdtempSync(path.join(tmpdir(), "tmb-feedback-project-"));
  opened = [];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function fakeEnv(overrides: Partial<FeedbackEnv> = {}): FeedbackEnv & { github: FakeGithub } {
  return {
    stateDir,
    program: DEV,
    version: "1.0.0-dev.7",
    versionLine: "tmb-dev 1.0.0-dev.7 (abc1234), on the dev channel",
    env: {},
    home: HOME,
    hosts: () => ["Claude Code 2.1.0"],
    os: () => "darwin 24.6.0 (arm64)",
    github: fakeGithub(true),
    fetchForm: async () => builtInBugForm,
    openUrl: (url) => {
      opened.push(url);
      return true;
    },
    repo: { owner: "trustmybot", name: "tmb" },
    now: () => new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  } as FeedbackEnv & { github: FakeGithub };
}

async function withStore<T>(use: (store: Store) => T | Promise<T>): Promise<T> {
  const result = openProjectStore(project, { create: true });
  if (!result.ok) throw result.error;
  try {
    return await use(result.store);
  } finally {
    result.store.close();
  }
}

async function refusal(run: () => unknown): Promise<HandlerError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const DRAFT_INPUT = { summary: "task_close failed on a clean worktree.", what_happened: "I closed a task after its worker committed." };

describe("the setting", () => {
  test("is on by default on dev and rc, off on stable", () => {
    expect(feedbackStatus(stateDir, "dev", {})).toMatchObject({ on: true, reason: "default" });
    expect(feedbackStatus(stateDir, "rc", {})).toMatchObject({ on: true, reason: "default" });
    expect(feedbackStatus(stateDir, "stable", {})).toMatchObject({ on: false, reason: "default" });
  });

  test("TMB_NO_FEEDBACK=1 and DO_NOT_TRACK=1 turn it off whatever the setting says", async () => {
    await runFeedbackCommand(["on"], fakeEnv(), { out: () => {}, err: () => {}, ask: null, cwd: project });
    expect(feedbackStatus(stateDir, "dev", { TMB_NO_FEEDBACK: "1" })).toMatchObject({ on: false, reason: "TMB_NO_FEEDBACK" });
    expect(feedbackStatus(stateDir, "dev", { DO_NOT_TRACK: "1" })).toMatchObject({ on: false, reason: "DO_NOT_TRACK" });
    expect(feedbackStatus(stateDir, "dev", { DO_NOT_TRACK: "0" })).toMatchObject({ on: true, reason: "setting" });
  });

  test("tmb feedback on, off and status change and show it, kept in the program's own state folder", async () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: () => {}, ask: null, cwd: project };
    expect(await runFeedbackCommand(["off"], fakeEnv(), io)).toBe(0);
    expect(readFeedbackState(stateDir).setting).toBe("off");
    expect(lines.at(-1)).toBe("The feedback program is off for tmb-dev (as you set it).");
    expect(await runFeedbackCommand(["status"], fakeEnv({ env: { TMB_NO_FEEDBACK: "1" } }), io)).toBe(0);
    expect(lines.some((line) => line.includes("TMB_NO_FEEDBACK=1 turns it off"))).toBe(true);
    expect(await runFeedbackCommand(["on", "now"], fakeEnv(), io)).toBe(2);
    // Another program's state folder holds its own setting.
    const other = mkdtempSync(path.join(tmpdir(), "tmb-feedback-other-"));
    try {
      expect(feedbackStatus(other, "dev", {})).toMatchObject({ on: true, reason: "default" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("the first run", () => {
  test("on dev, init's end gives the notice once", () => {
    const lines: string[] = [];
    firstRunAtInit(fakeEnv(), (line) => lines.push(line));
    expect(lines.join("\n")).toContain("The feedback program is on for tmb-dev, on the dev channel.");
    expect(lines.join("\n")).toContain("tmb-dev feedback off");
    expect(readFeedbackState(stateDir).firstRun?.how).toBe("notice");
    const again: string[] = [];
    firstRunAtInit(fakeEnv(), (line) => again.push(line));
    expect(again).toEqual([]);
  });

  // trustmybot/tmb#162: init asks nothing, so stable's question waits for the planner's first session.
  test("on stable, init's end asks nothing and leaves the question to the planner", () => {
    const lines: string[] = [];
    firstRunAtInit(fakeEnv({ program: STABLE, version: "1.0.0" }), (line) => lines.push(line));
    expect(lines).toEqual([]);
    expect(readFeedbackState(stateDir).firstRun).toBeNull();
    expect(readFeedbackState(stateDir).setting).toBeNull();
  });

  test("an off switch in the environment says nothing and marks nothing", async () => {
    const lines: string[] = [];
    firstRunAtInit(fakeEnv({ env: { DO_NOT_TRACK: "1" } }), (line) => lines.push(line));
    expect(lines).toEqual([]);
    expect(readFeedbackState(stateDir).firstRun).toBeNull();
    expect(firstRunSection(fakeEnv({ env: { TMB_NO_FEEDBACK: "1" } }))).toBe("");
  });

  test("else the planner's first session tells the Human once, and never in an unattended run", () => {
    const start = (unattended: boolean) => handleEvent({ type: "session-start", projectDir: project, unattended, feedback: fakeEnv() }).context;
    expect(start(true)).not.toContain(FEEDBACK_HEADING);
    expect(readFeedbackState(stateDir).firstRun).toBeNull();
    const first = start(false);
    expect(first).toContain(FEEDBACK_HEADING);
    expect(first).toContain("Tell the Human once");
    expect(start(false)).not.toContain(FEEDBACK_HEADING);
  });

  test("on stable the first session asks, naming the commands for the answer", () => {
    const text = handleEvent({ type: "session-start", projectDir: project, unattended: false, feedback: fakeEnv({ program: STABLE, version: "1.0.0" }) }).context;
    expect(text).toContain("Ask the Human once whether to join");
    expect(text).toContain("`tmb feedback on`");
    expect(text).toContain("No answer leaves it off.");
  });
});

describe("the bug form", () => {
  test("the built-in copy is the repo's form, with every field tmb fills", () => {
    expect(builtInBugForm).toBe(readFileSync(path.join(ROOT, ".github", "ISSUE_TEMPLATE", "bug.yml"), "utf8"));
    const form = parseForm(builtInBugForm, "built-in copy");
    const ids = form.fields.map((field) => field.id);
    for (const id of KNOWN_FIELDS) expect(ids).toContain(id);
    expect(form.labels.length).toBeGreaterThan(0);
  });

  test("is read from the default branch, and the built-in copy is used with the reason when it cannot be", async () => {
    const changed = builtInBugForm.replace("label: What went wrong", "label: In one sentence");
    const fresh = await readBugForm(async () => changed);
    expect(fresh.source).toBe("default branch");
    expect(fresh.fields.find((field) => field.id === "summary")?.label).toBe("In one sentence");
    const offline = await readBugForm(async () => {
      throw new Error("no network");
    });
    expect(offline).toMatchObject({ source: "built-in copy", fallbackReason: "no network" });
  });

  test("TMB_FEEDBACK_REPO names another repo, the tmb repo otherwise", () => {
    expect(feedbackRepoFrom({})).toEqual({ owner: "trustmybot", name: "tmb" });
    expect(feedbackRepoFrom({ TMB_FEEDBACK_REPO: "someone/tmb-fork" })).toEqual({ owner: "someone", name: "tmb-fork" });
    expect(feedbackRepoFrom({ TMB_FEEDBACK_REPO: "not a repo" })).toEqual({ owner: "trustmybot", name: "tmb" });
  });
});

describe("what a report holds", () => {
  test("paths are cleaned and values that look like secrets are removed", () => {
    const paths = { home: HOME, project: `${HOME}/code/app` };
    const text = [
      `at run (${HOME}/code/app/src/x.ts:3:1)`,
      `config in ${HOME}/.config/gh`,
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "https://bob:hunter2@example.com/repo.git",
      "API_KEY=abc123 password: 'p@ss word'",
      "Authorization: Bearer abcdefghijklmnop.qrstu",
    ].join("\n");
    const clean = cleanText(text, paths);
    expect(clean).toContain("at run (<project>/src/x.ts:3:1)");
    expect(clean).toContain("config in ~/.config/gh");
    expect(clean).not.toContain("ghp_abc");
    expect(clean).not.toContain("hunter2");
    expect(clean).not.toContain("abc123");
    expect(clean).not.toContain("p@ss");
    expect(clean).not.toContain("abcdefghijklmnop.qrstu");
    expect(clean).not.toContain(HOME);
    expect(clean.split(REMOVED).length).toBeGreaterThan(4);
  });

  test("holds the version, OS, host, command, error and event kinds; never the environment's variables", () => {
    process.env.TMB_FEEDBACK_TEST_SECRET = "sentinel-value-42";
    try {
      const values = reportValues(
        { summary: "It broke.", whatHappened: "Closing a task.", command: "task_close", error: "Error: boom\n    at x (/Users/someone/y.ts:1:1)" },
        { versionLine: "tmb-dev 1.0.0-dev.7 (abc), on the dev channel", os: "linux 6.1 (x64)", hosts: ["Codex 0.9"], eventKinds: ["issue created", "task updated"] },
        { home: HOME, project: null },
      );
      expect(values.version).toContain("on the dev channel");
      expect(values.error).toContain("Command or tool: task_close");
      expect(values.error).toContain("~/y.ts");
      expect(values.environment).toContain("OS: linux 6.1 (x64)");
      expect(values.environment).toContain("Host: Codex 0.9");
      expect(values.environment).toContain("issue created, task updated");
      expect(JSON.stringify(values)).not.toContain("sentinel-value-42");
    } finally {
      delete process.env.TMB_FEEDBACK_TEST_SECRET;
    }
  });

  test("the record gives the kinds of its newest events, never their content", async () => {
    await withStore((store) => {
      const id = store.createIssue({ kind: "human" }, { title: "Secret plan", body: "private words" });
      store.updateIssue({ kind: "human" }, id, { state: "closed" });
      expect(store.recentEventKinds(10)).toEqual(["issue created", "issue updated"]);
      expect(store.recentEventKinds(1)).toEqual(["issue updated"]);
    });
  });
});

describe("the issue body and the form link", () => {
  const form = parseForm(builtInBugForm, "built-in copy");
  const values = { summary: "It broke.", "what-happened": "Closing a task.", version: "tmb-dev 1.0.0-dev.7", error: "boom ``` fence", environment: "OS: x" };

  test("the body has the form's headings in order, the hidden line, and no answer where tmb knows none", () => {
    const body = issueBody(form, values);
    const headings = [...body.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(form.fields.map((field) => field.label));
    expect(body).toContain("### Impact\n\n_No response_");
    expect(body).toContain("````text\nboom ``` fence\n````");
    expect(body).toContain("- [x] I read this report and it contains no secrets, private code or personal paths.");
    expect(body).toContain("- [ ] I searched existing issues for this error.");
    expect(body.trimEnd().endsWith("<!-- tmb-feedback form=bug.yml -->")).toBe(true);
  });

  test("a field the form removed is not sent", async () => {
    const without = builtInBugForm.replace(/  - type: textarea\n    id: error\n[\s\S]*?(?=  - type: textarea\n    id: environment)/, "");
    expect(without).not.toContain("id: error");
    const env = fakeEnv({ fetchForm: async () => without });
    const draft = await withStore((store) => feedbackDraft(store, PLANNER, { ...DRAFT_INPUT, error: "Error: boom" }, { projectDir: project, feedback: env }));
    expect(draft.report).not.toContain("Error: boom");
    const kept = readDraft(stateDir, draft.draft_id)!;
    expect(Object.keys(kept.values)).not.toContain("error");
  });

  test("the link fills the form's fields by id and names the form", () => {
    const link = formLink({ owner: "trustmybot", name: "tmb" }, "bug.yml", "It broke.", values, "~/report.md");
    const url = new URL(link.url);
    expect(url.pathname).toBe("/trustmybot/tmb/issues/new");
    expect(url.searchParams.get("template")).toBe("bug.yml");
    expect(url.searchParams.get("title")).toBe("It broke.");
    expect(url.searchParams.get("what-happened")).toBe("Closing a task.");
    expect(url.searchParams.get("labels")).toBeNull();
    expect(link.shortened).toBe(false);
  });

  test("a report too long for a link keeps the first part of the error and asks for the file", () => {
    const long = { ...values, error: `Error: first line\n${"x".repeat(20_000)}` };
    const link = formLink({ owner: "trustmybot", name: "tmb" }, "bug.yml", "It broke.", long, "~/report.md");
    expect(link.shortened).toBe(true);
    expect(link.url.length).toBeLessThanOrEqual(FORM_LINK_MAX);
    const url = new URL(link.url);
    expect(url.searchParams.get("error")).toStartWith("Error: first line");
    expect(url.searchParams.get("what-happened")).toContain("Please attach the file ~/report.md here.");
  });
});

describe("the planner's tools", () => {
  test("are for the planner only, and drafting is refused when the program is off", async () => {
    expect(OPERATIONS.feedback_draft).toBeDefined();
    expect(OPERATIONS.feedback_send).toBeDefined();
    await withStore(async (store) => {
      expect((await refusal(() => feedbackDraft(store, WORKER, DRAFT_INPUT, { projectDir: project, feedback: fakeEnv() }))).message).toContain("for the planner");
      const off = await refusal(() => feedbackDraft(store, PLANNER, DRAFT_INPUT, { projectDir: project, feedback: fakeEnv({ env: { TMB_NO_FEEDBACK: "1" } }) }));
      expect(off.message).toContain("the feedback program is off");
      expect(off.message).toContain("tmb-dev feedback");
    });
  });

  test("a draft is shown whole and sent only with the Human's yes; the record keeps the issue's link", async () => {
    const env = fakeEnv();
    await withStore(async (store) => {
      const draft = await feedbackDraft(store, PLANNER, { ...DRAFT_INPUT, command: "task_close", error: `Error: boom at ${project}/src/a.ts` }, { projectDir: project, feedback: env });
      expect(draft.sendable).toBe(true);
      expect(draft.report).toContain("### What went wrong");
      expect(draft.report).toContain("<project>/src/a.ts");
      expect(draft.report).not.toContain(project);
      expect(readFileSync(draft.file, "utf8")).toContain("### What happened");
      expect(env.github.issues).toHaveLength(0);
      const context = { projectDir: project, feedback: env };
      expect((await refusal(() => feedbackSend(store, PLANNER, { draft_id: draft.draft_id, human_answer: "no" }, context))).code).toBe("invalid_input");
      expect((await refusal(() => feedbackSend(store, PLANNER, { draft_id: draft.draft_id }, context))).code).toBe("invalid_input");
      expect((await refusal(() => feedbackSend(store, PLANNER, { draft_id: "20261120-100000-abcdef", human_answer: "yes" }, context))).code).toBe("not_found");
      expect((await refusal(() => feedbackSend(store, PLANNER, { draft_id: draft.draft_id, human_answer: "yes" }, { ...context, unattended: true }))).code).toBe("refused");
      const sent = feedbackSend(store, PLANNER, { draft_id: draft.draft_id, human_answer: "yes" }, context);
      expect(sent).toMatchObject({ route: "issue", url: "https://github.com/trustmybot/tmb/issues/901" });
      expect(env.github.issues[0]!.title).toBe("task_close failed on a clean worktree.");
      expect(draft.report).toContain(env.github.issues[0]!.body.trimEnd().split("\n")[0]!);
      const reports = store.listFeedbackReports();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ route: "issue", url: "https://github.com/trustmybot/tmb/issues/901", issueId: null, createdBy: PLANNER });
      expect(store.history(reports[0]!.id)[0]!.data).toMatchObject({ title: "task_close failed on a clean worktree." });
      expect((await refusal(() => feedbackSend(store, PLANNER, { draft_id: draft.draft_id, human_answer: "yes" }, context))).message).toContain("already filed");
    });
  });

  test("without gh signed in the filled-in form is opened, and the record says opened, not sent", async () => {
    const env = fakeEnv({ github: fakeGithub(false) });
    await withStore(async (store) => {
      const draft = await feedbackDraft(store, PLANNER, DRAFT_INPUT, { projectDir: project, feedback: env });
      expect(draft.route).toContain("bug form");
      const sent = feedbackSend(store, PLANNER, { draft_id: draft.draft_id, human_answer: "yes" }, { projectDir: project, feedback: env });
      expect(sent).toMatchObject({ route: "form", opened: true });
      expect(opened).toHaveLength(1);
      expect(new URL(opened[0]!).searchParams.get("summary")).toBe(DRAFT_INPUT.summary);
      const report = store.listFeedbackReports()[0]!;
      expect(report).toMatchObject({ route: "form", url: null });
      expect(store.history(report.id)[0]!.data).toMatchObject({ opened: true });
    });
  });

  test("in an unattended run a draft is only kept as a file", async () => {
    await withStore(async (store) => {
      const draft = await feedbackDraft(store, PLANNER, DRAFT_INPUT, { projectDir: project, feedback: fakeEnv(), unattended: true });
      expect(draft.sendable).toBe(false);
      expect(draft.next).toContain("never sent");
    });
  });
});

describe("tmb feedback", () => {
  function io(answers: (string | null)[] | null) {
    const out: string[] = [];
    const queue = answers === null ? null : [...answers];
    return {
      out,
      io: {
        out: (line: string) => out.push(line),
        err: (line: string) => out.push(`ERR ${line}`),
        ask: queue === null ? null : async () => (queue.length === 0 ? null : queue.shift()!),
        cwd: project,
      },
    };
  }

  test("without a terminal it only writes the draft to a file", async () => {
    const env = fakeEnv();
    const run = io(null);
    expect(await runFeedbackCommand(["tmb", "init", "hung", "forever."], env, run.io)).toBe(0);
    expect(run.out.join("\n")).toContain("nothing was sent");
    expect(env.github.issues).toHaveLength(0);
    const saved = run.out.find((line) => line.startsWith("The draft is saved at "))!;
    expect(readFileSync(saved.slice("The draft is saved at ".length, -1), "utf8")).toContain("tmb init hung forever.");
  });

  test("on a terminal it files the report on a yes, sends nothing on a no, and works while the program is off", async () => {
    const env = fakeEnv({ env: { TMB_NO_FEEDBACK: "1" } });
    const no = io(["n"]);
    expect(await runFeedbackCommand(["It", "broke."], env, no.io)).toBe(0);
    expect(no.out.at(-1)).toBe("Nothing was sent.");
    expect(env.github.issues).toHaveLength(0);
    const yes = io(["Closing a task broke.", "y"]);
    expect(await runFeedbackCommand([], env, yes.io)).toBe(0);
    expect(yes.out.at(-1)).toBe("Filed: https://github.com/trustmybot/tmb/issues/901");
    expect(env.github.issues[0]!.title).toBe("Closing a task broke.");
  });

  test("puts the last recent error in the report", async () => {
    keepLastError(stateDir, { at: "2026-11-20T09:30:00Z", command: "migrate", message: "no plugin database in /Users/someone/app", stack: "Error: no plugin database\n    at run (/$bunfs/root/tmb:1:1)" });
    const run = io(null);
    await runFeedbackCommand([], fakeEnv(), run.io);
    const text = run.out.join("\n");
    expect(text).toContain("Command or tool: tmb migrate");
    expect(text).toContain("no plugin database in ~/app");
    expect(text).toContain("Title: no plugin database in ~/app");
  });
});
