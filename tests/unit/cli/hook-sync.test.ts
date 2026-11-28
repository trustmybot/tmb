// A session start polls the project's remote before it briefs: the state's hook waits for the poll
// only so long, answers from the record either way, and gives up a poll still running once it has
// answered, so nothing runs on after the hook. The role's hook only reads, and other events never poll.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HookCommand, SESSION_START_SYNC_WAIT_MS, type SessionStartSync } from "../../../src/cli/commands/hook.ts";
import { type ProcessPorts, Runtime } from "../../../src/cli/runtime.ts";
import { openProjectStore } from "../../../src/engine/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const PLANNER = { kind: "agent", role: "planner", host: "host-a" } as const;
const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
let project: string;
/** What happened, in order: each poll asked for, each answer written, each poll given up. */
let steps: string[];

beforeEach(() => {
  // The host's own variable would name the project this test runs in, not the one under test.
  delete process.env.CLAUDE_PROJECT_DIR;
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-hook-sync-")));
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  opened.store.close();
  steps = [];
});

afterEach(() => {
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  rmSync(project, { recursive: true, force: true });
});

/** Runs `tmb hook <event>` in this process with the given poll; returns its exit code and what it wrote to stdout. */
async function hook(event: string, sync: SessionStartSync, stdin = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: project })) {
  let out = "";
  const write = (text: string) => {
    out += text;
    steps.push("answer");
    return true;
  };
  const ports = {
    env: process.env,
    stdin: { isTTY: false },
    stdout: { write, isTTY: false },
    stderr: { write: () => true, isTTY: false },
    execPath: process.execPath,
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    cwd: () => project,
    main: Bun.main,
    readStdin: async () => stdin,
    once: () => undefined,
    exit: () => undefined,
  } as unknown as ProcessPorts;
  const code = await new HookCommand(new Runtime(ports), sync).run([event]);
  return { code, context: out === "" ? "" : (JSON.parse(out).hookSpecificOutput.additionalContext as string) };
}

/** A poll that ends, or does not, within the wait; `during` runs while the hook waits for it. */
function poll(ended: boolean, during: () => void = () => undefined): SessionStartSync {
  return async (projectDir, waitMs) => {
    steps.push(`poll ${projectDir} ${waitMs}`);
    during();
    return {
      ended: () => ended,
      giveUp: () => {
        steps.push("give up");
        return !ended;
      },
    };
  };
}

function createIssue(title: string): void {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  opened.store.createIssue(PLANNER, { title });
  opened.store.close();
}

test("the state's hook polls the session's project first, and briefs with what the poll brought in", async () => {
  const { code, context } = await hook("session-start", poll(true, () => createIssue("Opened on the remote")));
  expect(code).toBe(0);
  expect(context).toContain("Opened on the remote");
  expect(steps).toEqual([`poll ${project} ${SESSION_START_SYNC_WAIT_MS}`, "answer", "give up"]);
});

test("a poll still running at the wait is given up after the brief from the record as it is", async () => {
  createIssue("Already in the record");
  const { code, context } = await hook("session-start", poll(false));
  expect(code).toBe(0);
  expect(context).toContain("Already in the record");
  expect(steps).toEqual([`poll ${project} ${SESSION_START_SYNC_WAIT_MS}`, "answer", "give up"]);
});

test("a poll that cannot start never fails the session start", async () => {
  createIssue("Already in the record");
  const { code, context } = await hook("session-start", async () => {
    throw new Error("no syncer");
  });
  expect(code).toBe(0);
  expect(context).toContain("Already in the record");
});

test("the role's hook only reads, and no other event polls", async () => {
  expect((await hook("session-start-role", poll(true))).context).not.toBe("");
  await hook("user-prompt-submit", poll(true), JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: project }));
  await hook("session-end", poll(true), JSON.stringify({ hook_event_name: "SessionEnd", cwd: project }));
  expect(steps.filter((step) => step !== "answer")).toEqual([]);
});
