import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EMPTY_SETTINGS_HEADING,
  handleEvent,
  OPEN_WORK_HEADING,
  OPEN_WORK_MAX,
  openProjectStore,
  plannerRole,
  projectDbPath,
  UNATTENDED_INSTRUCTION,
  writeSetting,
} from "../src/engine/index.ts";
import type { Store } from "../src/engine/store/index.ts";

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-session-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function context(): string {
  return handleEvent({ type: "session-start", projectDir: project, unattended: false }).context;
}

function withStore(use: (store: Store) => void): void {
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  try {
    use(opened.store);
  } finally {
    opened.store.close();
  }
}

describe("session start", () => {
  test("gives the role alone when the project has no record", () => {
    expect(context()).toBe(plannerRole);
  });

  test("gives the role and one line naming the problem when the record cannot be read", () => {
    mkdirSync(path.dirname(projectDbPath(project)), { recursive: true });
    writeFileSync(projectDbPath(project), "this is not a database, only text long enough to look like a header");
    const text = context();
    expect(text).toStartWith(plannerRole.trimEnd());
    const extra = text.slice(plannerRole.trimEnd().length).trim();
    expect(extra.split("\n")).toHaveLength(1);
    expect(extra).toContain("tmb could not read the record");
    expect(extra).toContain("trajectory.db");
  });

  test("names a record made by a newer tmb", () => {
    withStore(() => {});
    const db = new Database(projectDbPath(project));
    db.run("PRAGMA user_version = 99");
    db.close();
    expect(context()).toContain("newer tmb");
  });

  test("lists the open issues newest first with their newest decision, and leaves closed ones out", () => {
    withStore((store) => {
      const older = store.createIssue({ kind: "human" }, { title: "Older issue" });
      store.appendDiscussion({ kind: "human" }, { issueId: older, kind: "decision", body: "First call" });
      store.appendDiscussion({ kind: "human" }, { issueId: older, kind: "decision", body: "Second call" });
      const closed = store.createIssue({ kind: "human" }, { title: "Closed issue" });
      store.updateIssue({ kind: "human" }, closed, { state: "closed" });
      store.createIssue({ kind: "agent", role: "planner", host: "h" }, { title: "Newer issue" });
    });
    const text = context();
    expect(text).toStartWith(plannerRole.trimEnd());
    const work = text.slice(text.indexOf(OPEN_WORK_HEADING));
    expect(work.indexOf("Newer issue")).toBeLessThan(work.indexOf("Older issue"));
    expect(work).toContain("Second call");
    expect(work).not.toContain("First call");
    expect(work).not.toContain("Closed issue");
  });

  test("lists the open tasks oldest first with their issue, feature branch and worktree, and leaves closed ones out", () => {
    let older = "";
    let newer = "";
    let issue = "";
    withStore((store) => {
      const human = { kind: "human" } as const;
      issue = store.createIssue(human, { title: "Has tasks" });
      const feature = store.createFeature(human, { name: "feat/goal", baseBranch: "main", baseCommit: "0".repeat(40) });
      older = store.appendTask(human, { issueId: issue, title: "Older task", state: "open", worktree: "/w/older", featureId: feature });
      store.appendTask(human, { issueId: issue, title: "Closed task", state: "closed", featureId: feature });
      newer = store.appendTask(human, { issueId: issue, title: "Newer task", state: "open", worktree: "/w/newer" });
    });
    const work = context().split(OPEN_WORK_HEADING)[1]!;
    expect(work).toContain(`- ${older} Older task (issue ${issue}, feature branch feat/goal, worktree /w/older)`);
    expect(work).toContain(`- ${newer} Newer task (issue ${issue}, worktree /w/newer)`);
    expect(work.indexOf("Has tasks")).toBeLessThan(work.indexOf("Older task"));
    expect(work.indexOf("Older task")).toBeLessThan(work.indexOf("Newer task"));
    expect(work).not.toContain("Closed task");
  });

  test("says so when nothing is open", () => {
    withStore(() => {});
    expect(context()).toContain(`${OPEN_WORK_HEADING}\n\nNo open issues.`);
  });

  test(`lists at most ${OPEN_WORK_MAX} issues and counts the rest`, () => {
    withStore((store) => {
      for (let i = 1; i <= OPEN_WORK_MAX + 3; i++) store.createIssue({ kind: "human" }, { title: `Issue number ${i}` });
    });
    const work = context().split(OPEN_WORK_HEADING)[1]!;
    const listed = work.split("\n").filter((line) => line.startsWith("- ") && line.includes("Issue number"));
    expect(listed).toHaveLength(OPEN_WORK_MAX);
    expect(listed[0]).toContain(`Issue number ${OPEN_WORK_MAX + 3}`);
    expect(work).not.toContain("Issue number 3\n");
    expect(work).toContain("3 older open issues");
  });
});

const HUMAN = { kind: "human" } as const;

/** The project settings onboarding fills, so a session start has none to ask for. */
function onboarded(store: Store): void {
  writeSetting(store, HUMAN, "base_branch", "main");
  writeSetting(store, HUMAN, "review_mode", "agile");
  writeSetting(store, HUMAN, "checks", ["bun test"]);
}

describe("unattended mode", () => {
  function contextWith(unattended: boolean): string {
    return handleEvent({ type: "session-start", projectDir: project, unattended }).context;
  }

  test("when on, the answer is the attended one followed by the unattended instruction", () => {
    withStore((store) => {
      onboarded(store);
      store.createIssue({ kind: "human" }, { title: "Open issue" });
    });
    const attended = contextWith(false);
    const text = contextWith(true);
    expect(text).toBe(`${attended.trimEnd()}\n\n${UNATTENDED_INSTRUCTION}\n`);
    expect(text.indexOf("Open issue")).toBeLessThan(text.indexOf(UNATTENDED_INSTRUCTION));
    expect(UNATTENDED_INSTRUCTION).toContain("No one can answer in this run");
    expect(UNATTENDED_INSTRUCTION).toContain("name each default you used");
    expect(UNATTENDED_INSTRUCTION).toContain("stop with the reason when a default is not safe");
  });

  test("when on and there is no record, the role is followed by the instruction", () => {
    expect(contextWith(true)).toBe(`${plannerRole.trimEnd()}\n\n${UNATTENDED_INSTRUCTION}\n`);
  });

  test("when off, the answer is the role and the open work alone", () => {
    withStore(onboarded);
    expect(contextWith(false)).toBe(`${plannerRole.trimEnd()}\n\n${OPEN_WORK_HEADING}\n\nNo open issues.\n`);
  });
});

describe("empty settings", () => {
  function contextWith(unattended: boolean): string {
    return handleEvent({ type: "session-start", projectDir: project, unattended }).context;
  }

  test("tell the planner to apply the settings it recommends, show them and remind the Human of tmb onboard", () => {
    writeFileSync(path.join(project, "go.mod"), "module x\n");
    withStore(() => {});
    const text = contextWith(false);
    expect(text).toContain(`${EMPTY_SETTINGS_HEADING}\n\nNot set yet: base branch, review mode, checks.`);
    expect(text).toContain("apply them with settings_set");
    expect(text).toContain("remind them that `tmb onboard` can be run again at any time");
    expect(text).toContain("you can change a value when they ask");
    expect(text).toContain("- checks: `go test ./...`");
    expect(text).toContain("- review modes: agile (one review of each feature branch as a whole; the fewer tokens) or truest (a review of every task before its push; more tokens, as every task is reviewed)");
    // The review mode is the Human's: the planner asks for it and never sets it itself.
    expect(text).toContain("work out the base branch and checks you recommend");
    expect(text).toContain("The review mode is the Human's choice");
    expect(text).toContain("do not set it yourself");
    // trustmybot/tmb#162: init asks nothing, so the planner asks among its onboarding questions.
    expect(text).toContain("Ask the Human for it among your onboarding questions, with your host's question tool, such as AskUserQuestion: one option per mode with what it costs, agile marked as recommended.");
    expect(text.indexOf(OPEN_WORK_HEADING)).toBeLessThan(text.indexOf(EMPTY_SETTINGS_HEADING));
  });

  test("name only the settings still empty", () => {
    withStore((store) => writeSetting(store, HUMAN, "base_branch", "main"));
    expect(contextWith(false)).toContain("Not set yet: review mode, checks.");
  });

  test("with only the review mode empty, ask the Human for it and apply nothing", () => {
    withStore((store) => {
      writeSetting(store, HUMAN, "base_branch", "main");
      writeSetting(store, HUMAN, "checks", []);
    });
    const text = contextWith(false);
    expect(text).toContain("Not set yet: review mode. The review mode is the Human's choice");
    expect(text).not.toContain("apply them with settings_set");
  });

  test("in an unattended run, the others are applied and named, and the review mode is left for the Human's tmb onboard", () => {
    withStore(() => {});
    const text = contextWith(true);
    expect(text).toContain("apply them with settings_set");
    expect(text).toContain("Name each value you applied in your answer.");
    expect(text).not.toContain("remind them");
    expect(text).toContain("no one can answer in this run: do not set it. task_start is refused until the Human runs `tmb onboard`");
  });

  test("are not mentioned once set", () => {
    withStore(onboarded);
    expect(contextWith(false)).not.toContain(EMPTY_SETTINGS_HEADING);
  });
});
