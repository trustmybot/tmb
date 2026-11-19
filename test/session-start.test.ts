import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  handleEvent,
  OPEN_WORK_HEADING,
  OPEN_WORK_MAX,
  openProjectStore,
  plannerRole,
  projectDbPath,
  UNATTENDED_INSTRUCTION,
  UNATTENDED_VARIABLE,
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
  return handleEvent({ type: "session-start", projectDir: project }).context;
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

describe("unattended mode", () => {
  function contextWith(unattended: string | undefined): string {
    return handleEvent({ type: "session-start", projectDir: project, unattended }).context;
  }

  test("is read from TMB_UNATTENDED", () => {
    expect(UNATTENDED_VARIABLE).toBe("TMB_UNATTENDED");
  });

  test("with 1, the answer is the attended one followed by the unattended instruction", () => {
    withStore((store) => {
      store.createIssue({ kind: "human" }, { title: "Open issue" });
    });
    const attended = contextWith(undefined);
    const text = contextWith("1");
    expect(text).toBe(`${attended.trimEnd()}\n\n${UNATTENDED_INSTRUCTION}\n`);
    expect(text.indexOf("Open issue")).toBeLessThan(text.indexOf(UNATTENDED_INSTRUCTION));
    expect(UNATTENDED_INSTRUCTION).toContain("No one can answer in this run");
    expect(UNATTENDED_INSTRUCTION).toContain("name each default you used");
    expect(UNATTENDED_INSTRUCTION).toContain("stop with the reason when a default is not safe");
  });

  test("with 1 and no record, the role is followed by the instruction", () => {
    expect(contextWith("1")).toBe(`${plannerRole.trimEnd()}\n\n${UNATTENDED_INSTRUCTION}\n`);
  });

  test("unset or any other value gives exactly the attended answer", () => {
    withStore(() => {});
    const attended = context();
    for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
      expect(contextWith(value)).toBe(attended);
    }
    expect(attended).not.toContain(UNATTENDED_INSTRUCTION);
  });
});
