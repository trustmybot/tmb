// A feature branch after its pull request (trustmybot/tmb#131): merged or closed when GitHub says so,
// left in pr_open when GitHub cannot be read, and read only when the caller says to.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { featureList } from "../src/engine/handlers/index.ts";
import { handleEvent, openProjectStore, PULL_REQUESTS_ENDED_HEADING } from "../src/engine/index.ts";
import { CLOSED_UNMERGED, MERGED, type PullRequestReader, readPullRequestState, refreshPullRequestStates } from "../src/engine/pull-request-state.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
let project: string;
let store: Store;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-pr-state-"));
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

function feature(name: string, state: string, prUrl: string | null): string {
  const id = store.createFeature(HUMAN, { name, baseBranch: "main", baseCommit: "0".repeat(40) });
  store.updateFeature(HUMAN, id, { state, prUrl });
  return id;
}

const answers: Record<string, ReturnType<PullRequestReader>> = {
  "https://github.com/o/r/pull/1": "MERGED",
  "https://github.com/o/r/pull/2": "CLOSED",
  "https://github.com/o/r/pull/3": "OPEN",
  "https://github.com/o/r/pull/4": null,
};

describe("refreshPullRequestStates", () => {
  test("moves pr_open features whose pull request merged or closed, and keeps the rest", () => {
    const merged = feature("feat/merged", "pr_open", "https://github.com/o/r/pull/1");
    const closed = feature("feat/closed", "pr_open", "https://github.com/o/r/pull/2");
    const open = feature("feat/open", "pr_open", "https://github.com/o/r/pull/3");
    const unread = feature("feat/unread", "pr_open", "https://github.com/o/r/pull/4");
    const read: string[] = [];
    const moved = refreshPullRequestStates(store, PLANNER, project, {
      read: (_dir, url) => {
        read.push(url);
        return answers[url] ?? null;
      },
    });
    expect(moved).toHaveLength(2);
    expect(moved[0]).toContain("feat/merged");
    expect(store.getFeature(merged)).toMatchObject({ state: MERGED, prUrl: "https://github.com/o/r/pull/1" });
    expect(store.getFeature(closed)!.state).toBe(CLOSED_UNMERGED);
    expect(store.getFeature(open)!.state).toBe("pr_open");
    expect(store.getFeature(unread)!.state).toBe("pr_open");
    expect(read).toHaveLength(4);
    expect(store.history(merged).at(-1)).toMatchObject({ actor: PLANNER, data: { state: MERGED } });
  });

  test("reads only pr_open features with a pull request, and only those the caller picks", () => {
    feature("feat/working", "open", null);
    feature("feat/done", "merged", "https://github.com/o/r/pull/1");
    const picked = feature("feat/picked", "pr_open", "https://github.com/o/r/pull/1");
    feature("feat/skipped", "pr_open", "https://github.com/o/r/pull/2");
    const read: string[] = [];
    refreshPullRequestStates(store, HUMAN, project, {
      shouldRead: (f) => f.id === picked,
      read: (_dir, url) => {
        read.push(url);
        return answers[url] ?? null;
      },
    });
    expect(read).toEqual(["https://github.com/o/r/pull/1"]);
    expect(store.findFeature("feat/skipped")!.state).toBe("pr_open");
  });

  test("never throws: a reader that fails leaves every feature as it was", () => {
    const id = feature("feat/x", "pr_open", "https://github.com/o/r/pull/1");
    const moved = refreshPullRequestStates(store, HUMAN, project, {
      read: () => {
        throw new Error("no network");
      },
    });
    expect(moved).toEqual([]);
    expect(store.getFeature(id)!.state).toBe("pr_open");
  });
});

describe("through the Human's gh", () => {
  let savedPath: string | undefined;

  /** A gh on PATH that answers `gh pr view <url> --json state --jq .state` from `states`, and fails for any other url. */
  function fakeGh(states: Record<string, string>): void {
    const bin = path.join(project, "bin");
    mkdirSync(bin);
    const cases = Object.entries(states)
      .map(([url, state]) => `  ${JSON.stringify(url)}) echo ${state} ;;`)
      .join("\n");
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n[ "$1 $2" = "pr view" ] || exit 1\ncase "$3" in\n${cases}\n  *) echo "not found" >&2; exit 1 ;;\nesac\n`);
    chmodSync(path.join(bin, "gh"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  }

  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    savedPath = undefined;
  });

  test("reads a pull request's state, and gives null when gh fails", () => {
    fakeGh({ "https://github.com/o/r/pull/1": "MERGED" });
    expect(readPullRequestState(project, "https://github.com/o/r/pull/1")).toBe("MERGED");
    expect(readPullRequestState(project, "https://github.com/o/r/pull/9")).toBeNull();
  });

  test("feature_list moves a merged feature before it answers", () => {
    fakeGh({ "https://github.com/o/r/pull/1": "MERGED" });
    feature("feat/a", "pr_open", "https://github.com/o/r/pull/1");
    const listed = featureList(store, HUMAN, {}, { projectDir: project });
    expect(listed.find((f) => f.name === "feat/a")!.state).toBe(MERGED);
  });

  test("the planner's session start names the pull requests that ended", () => {
    fakeGh({ "https://github.com/o/r/pull/2": "CLOSED" });
    const id = feature("feat/b", "pr_open", "https://github.com/o/r/pull/2");
    const context = handleEvent({ type: "session-start", projectDir: project, unattended: false, host: "host-a" }).context;
    expect(context).toContain(PULL_REQUESTS_ENDED_HEADING);
    expect(context).toContain("feat/b");
    // A closed pull request says what the planner can do next (trustmybot/tmb#152).
    expect(context).toContain("Start a task on it to rework it, or open a new pull request with feature_pr");
    expect(store.getFeature(id)!.state).toBe(CLOSED_UNMERGED);
    expect(store.history(id).at(-1)!.actor).toEqual(PLANNER);
    const again = handleEvent({ type: "session-start", projectDir: project, unattended: false, host: "host-a" }).context;
    expect(again).not.toContain(PULL_REQUESTS_ENDED_HEADING);
  });
});
