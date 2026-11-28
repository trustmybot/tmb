// The syncer's folding half and its polls, on recorded and made-up answers: no network, no `gh`.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTSIDE_CHANGES_HEADING, openProjectStore, type Store, takeOutsideChanges, writeSetting } from "../../../src/engine/index.ts";
import { type Answer, type Ask, type Changes, Folder, type Request, syncProject, UNTITLED } from "../../../src/syncer/index.ts";
import { readGhOutput } from "../../../src/syncer/transport.ts";
import { RECORD_READ_WAIT_MS, SYNC_RUNNING_NOTE } from "../../../src/engine/index.ts";
import { ToolSession } from "../../../src/engine/tool-server.ts";

setDefaultTimeout(30_000);

const REMOTE = "github.com/trustmybot/tmb";
const recorded = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", `${name}.txt`), "utf8");
const onePage = (raw: string): string => raw.replace(/^Link:.*\r\n/m, "");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmb-sync-"));
  spawnSync("git", ["init", "-q", dir]);
  spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/trustmybot/tmb.git"]);
  const opened = openProjectStore(dir, { create: true });
  if (!opened.ok) throw opened.error;
  opened.store.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withStore<T>(work: (store: Store) => T): T {
  const opened = openProjectStore(dir, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    return work(opened.store);
  } finally {
    opened.store.close();
  }
}

const eventCount = (): number => withStore((store) => store.recentEventKinds(10_000).length);

/** Answers each request from the first recording whose key its path contains, and counts the asks. */
function recordedAsk(answers: [string, string | Answer][]): { ask: Ask; asked: Request[] } {
  const asked: Request[] = [];
  const ask: Ask = async (request) => {
    asked.push(request);
    const found = answers.find(([key]) => request.path.includes(key));
    if (found === undefined) throw new Error(`no recording for ${request.path}`);
    return typeof found[1] === "string" ? readGhOutput(found[1], "") : found[1];
  };
  return { ask, asked };
}

const everyList = (): [string, string][] => [
  ["/issues/comments", onePage(recorded("comments"))],
  ["/pulls/comments", recorded("review")],
  ["/issues?", onePage(recorded("issues"))],
  ["/pulls?", onePage(recorded("pulls"))],
  ["/milestones", onePage(recorded("ms"))],
];

/** Every list answers "not modified", as the remote does for a tag when nothing changed. */
const nothingChanged = (): [string, string][] => [["repos/", recorded("not-modified")]];

const item = (remoteId: string, url: string, at = "2026-11-26T00:00:00Z") => ({ remote: REMOTE, remoteId, remoteUpdatedAt: at, gone: false, url, author: "octocat", createdAt: at });

function changes(overrides: Partial<Changes> = {}): Changes {
  return {
    milestones: [{ ...item("M1", "https://github.com/trustmybot/tmb/milestone/1"), number: 1, title: "Level 1", description: "", state: "open" }],
    issues: [
      {
        ...item("I1", "https://github.com/trustmybot/tmb/issues/1"),
        number: 1,
        title: "Mirror the remote",
        body: "bring it in",
        state: "open",
        stateReason: null,
        type: "Feature",
        labels: ["type/feature"],
        assignees: ["octocat"],
        milestoneRemoteId: "M1",
      },
    ],
    comments: [
      { ...item("C1", "https://github.com/trustmybot/tmb/issues/1#issuecomment-1"), body: "first words", on: { kind: "issue", number: 1 }, review: false },
      { ...item("C2", "https://github.com/trustmybot/tmb/pull/2#issuecomment-2"), body: "on a pull request", on: { kind: "pull_request", number: 2 }, review: false },
    ],
    pullRequests: [
      {
        ...item("P2", "https://github.com/trustmybot/tmb/pull/2"),
        number: 2,
        title: "Mirror",
        body: "",
        state: "open",
        draft: false,
        headCommit: "abc1234",
        baseRemote: REMOTE,
        headRemote: REMOTE,
        baseBranch: "dev",
        headBranch: "feat/mirror",
        labels: [],
        assignees: [],
        milestoneRemoteId: null,
      },
    ],
    ...overrides,
  };
}

describe("folding the remote into the record", () => {
  test("each item comes in once, as an event by tmb's syncer naming the account that wrote it", () => {
    const count = withStore((store) => new Folder(store, ".").fold(changes()));
    expect(count).toEqual({ created: 4, updated: 0, skipped: 1 });
    withStore((store) => {
      const [summary] = store.listIssues();
      const issue = store.getIssue(summary!.id)!;
      expect(issue).toMatchObject({ title: "Mirror the remote", milestone: "Level 1", labels: ["type/feature"], remoteUrl: "https://github.com/trustmybot/tmb/issues/1", remoteGoneAt: null });
      expect(store.history(issue.id).map((event) => event.actor)).toEqual([{ kind: "tmb", source: "syncer", remote: "octocat" }]);
      const [comment] = store.listDiscussions(issue.id);
      expect(comment).toMatchObject({ kind: "comment", body: "first words", remoteAuthor: "octocat" });
      expect(store.search("words").map((hit) => hit.id)).toEqual([comment!.id]);
    });
  });

  test("folding the same answer again writes no event", () => {
    withStore((store) => new Folder(store, ".").fold(changes()));
    const before = eventCount();
    const count = withStore((store) => new Folder(store, ".").fold(changes()));
    expect(count).toEqual({ created: 0, updated: 0, skipped: 1 });
    expect(eventCount()).toBe(before);
  });

  test("a change on the remote writes only what changed, found by the remote's id after a move", () => {
    withStore((store) => new Folder(store, ".").fold(changes()));
    const moved = changes();
    moved.issues[0] = { ...moved.issues[0]!, title: "Renamed", state: "closed", stateReason: "completed", remote: "github.com/trustmybot/other", url: "https://github.com/trustmybot/other/issues/9", remoteUpdatedAt: "2026-11-27T00:00:00Z" };
    moved.comments[0] = { ...moved.comments[0]!, body: "edited words" };
    const count = withStore((store) => new Folder(store, ".").fold(moved));
    expect(count.updated).toBe(2);
    withStore((store) => {
      const [summary] = store.listIssues();
      expect(store.listIssues()).toHaveLength(1);
      const events = store.history(summary!.id);
      expect(events.at(-1)!.data).toEqual({
        title: "Renamed",
        state: "closed",
        state_reason: "completed",
        remote_url: "https://github.com/trustmybot/other/issues/9",
        remote: "github.com/trustmybot/other",
        remote_updated_at: "2026-11-27T00:00:00Z",
      });
      expect(events.at(-1)!.actor).toEqual({ kind: "tmb", source: "syncer" });
      expect(store.listDiscussions(summary!.id)[0]!.body).toBe("edited words");
    });
  });

  test("the planner is told of the syncer's changes as changes made outside its chat", () => {
    expect(withStore((store) => takeOutsideChanges(store))).toBe("");
    withStore((store) => new Folder(store, ".").fold(changes()));
    const told = withStore((store) => takeOutsideChanges(store));
    expect(told).toContain(OUTSIDE_CHANGES_HEADING);
    expect(told).toContain('"Mirror the remote": recorded, by the remote, through tmb\'s syncer');
    expect(told).toContain('comment added: "first words"');
    const closed = changes();
    closed.issues[0] = { ...closed.issues[0]!, state: "closed", remoteUpdatedAt: "2026-11-27T00:00:00Z" };
    withStore((store) => new Folder(store, ".").fold(closed));
    expect(withStore((store) => takeOutsideChanges(store))).toContain('"Mirror the remote": closed, by the remote');
    expect(withStore((store) => takeOutsideChanges(store))).toBe("");
  });

  test("a local issue, a note and a decision are never touched", () => {
    const local = withStore((store) => {
      const id = store.createIssue({ kind: "human" }, { title: "Mirror the remote", body: "mine" });
      store.appendDiscussion({ kind: "human" }, { issueId: id, kind: "decision", body: "keep it local" });
      return id;
    });
    withStore((store) => new Folder(store, ".").fold(changes()));
    withStore((store) => {
      expect(store.history(local)).toHaveLength(1);
      expect(store.listDiscussions(local).map((one) => one.kind)).toEqual(["decision"]);
      expect(() => store.mirror.updateMirrored({ kind: "tmb", source: "syncer" }, "issue", local, { title: "x" })).toThrow(/local/);
      const decision = store.listDiscussions(local)[0]!;
      expect(() => store.mirror.updateMirrored({ kind: "tmb", source: "syncer" }, "discussion", decision.id, { body: "x" })).toThrow(/local/);
    });
  });

  test("a blank title still makes an issue, and a blank comment is skipped", () => {
    const blank = changes();
    blank.issues[0] = { ...blank.issues[0]!, title: "  " };
    blank.comments[0] = { ...blank.comments[0]!, body: "" };
    withStore((store) => new Folder(store, ".").fold(blank));
    withStore((store) => {
      expect(store.listIssues()[0]!.title).toBe(UNTITLED);
      expect(store.listDiscussions(store.listIssues()[0]!.id)).toEqual([]);
    });
  });

  test("tmb's own pull request is linked to the feature branch that opened it and names no author", () => {
    withStore((store) => {
      const featureId = store.createFeature({ kind: "agent", role: "planner", host: "h" }, { name: "feat/mirror", baseBranch: "dev", baseCommit: "abc1234" });
      store.updateFeature({ kind: "agent", role: "planner", host: "h" }, featureId, { prUrl: "https://github.com/trustmybot/tmb/pull/2" });
      new Folder(store, ".").fold(changes());
      const row = store.mirror.findMirrored("pull_request", "P2")!;
      expect(row).toMatchObject({ feature_id: featureId, task_id: null, author: null, state: "open", draft: 0 });
    });
  });
});

describe("polling the remote", () => {
  test("the recorded answers come in, and a second poll with nothing changed writes no event", async () => {
    const first = recordedAsk(everyList());
    const [outcome] = await syncProject(dir, { askFor: () => first.ask, force: true });
    expect(outcome).toMatchObject({ ok: true, remote: REMOTE, fullPass: true });
    withStore((store) => {
      expect(store.listIssues().map((issue) => issue.title)).toEqual([expect.stringContaining("mirror docs"), expect.stringContaining("hardcode")]);
      expect(store.mirror.findMirrored("milestone", "MI_kwDOVzoTK84BLK3l")).toMatchObject({ title: "v1.x", state: "open" });
      expect(store.mirror.findMirrored("pull_request", "PR_kwDOVzoTK88AAAABQ3OThw")).toMatchObject({ url: "https://github.com/trustmybot/tmb/pull/299", author: "Zax-TMB" });
      expect(store.mirror.syncRows(REMOTE).every((row) => row.syncedAt !== null && row.claimedBy === null && row.lastError === null)).toBe(true);
    });
    const before = eventCount();
    const second = recordedAsk(nothingChanged());
    const [again] = await syncProject(dir, { askFor: () => second.ask, force: true });
    expect(again).toMatchObject({ ok: true, changed: false, count: { created: 0, updated: 0 } });
    expect(second.asked.every((request) => request.tag !== undefined && request.tag !== null)).toBe(true);
    expect(eventCount()).toBe(before);
  });

  test("the floor holds a second poll back unless it is forced", async () => {
    const first = recordedAsk(everyList());
    await syncProject(dir, { askFor: () => first.ask, force: true });
    const second = recordedAsk(nothingChanged());
    const [held] = await syncProject(dir, { askFor: () => second.ask });
    expect(held).toMatchObject({ ok: false, cannot: "held" });
    expect(second.asked).toEqual([]);
  });

  test("another poll's live claim holds this one back, forced or not", async () => {
    withStore((store) => store.mirror.claim(REMOTE, ["issues"], "other@host", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), false));
    const asked = recordedAsk(everyList());
    const [held] = await syncProject(dir, { askFor: () => asked.ask, force: true });
    expect(held).toMatchObject({ ok: false, cannot: "held", why: expect.stringContaining("claimed") });
    expect(asked.asked).toEqual([]);
  });

  test("issue sync off: the syncer does nothing", async () => {
    withStore((store) => writeSetting(store, { kind: "human" }, "issue_sync", "off"));
    const asked = recordedAsk(everyList());
    const [outcome] = await syncProject(dir, { askFor: () => asked.ask, force: true });
    expect(outcome).toMatchObject({ ok: false, cannot: "off" });
    expect(asked.asked).toEqual([]);
    withStore((store) => expect(store.listIssues()).toEqual([]));
  });

  test("no gh, or an origin that is not on GitHub, leaves the record as it is and says why", async () => {
    const noClient: Ask = async () => ({ sent: false, why: "no_client", said: "gh is not installed" });
    const [outcome] = await syncProject(dir, { askFor: () => noClient, force: true });
    expect(outcome).toMatchObject({ ok: false, cannot: "no_client" });
    withStore((store) => {
      expect(store.listIssues()).toEqual([]);
      expect(store.mirror.syncRows(REMOTE)[0]!.lastError).toStartWith("no_client");
    });
    spawnSync("git", ["-C", dir, "remote", "set-url", "origin", "/somewhere/local"]);
    const [local] = await syncProject(dir, { askFor: () => noClient, force: true });
    expect(local).toMatchObject({ ok: false, cannot: "not_github" });
  });

  test("after a whole read, a held issue the remote no longer has is marked gone, never deleted", async () => {
    const first = recordedAsk(everyList());
    await syncProject(dir, { askFor: () => first.ask, force: true });
    // A week on, the full pass reads everything again; issue 306 is gone from the remote.
    const issues = onePage(recorded("issues"));
    const only304 = issues.replace(/,\s*\{\s*"url": "https:\/\/api\.github\.com\/repos\/trustmybot\/tmb\/issues\/306"[\s\S]*\]\s*$/, "\n]\n");
    const later = recordedAsk([["/issues/306", recorded("not-found")], ["/issues?", only304], ...everyList()]);
    const week = new Date(Date.now() + 8 * 24 * 60 * 60_000);
    const [outcome] = await syncProject(dir, { askFor: () => later.ask, force: true, now: () => week });
    expect(outcome).toMatchObject({ ok: true, fullPass: true });
    withStore((store) => {
      const gone = store.listIssues().map((summary) => store.getIssue(summary.id)!).filter((issue) => issue.remoteGoneAt !== null);
      expect(gone.map((issue) => issue.remoteUrl)).toEqual(["https://github.com/trustmybot/tmb/issues/306"]);
      expect(store.listIssues()).toHaveLength(2);
    });
  });
});

describe("when the syncer runs", () => {
  test("the planner's reads of the issues tell the syncer, other calls do not, and a slow poll holds a read up only briefly", async () => {
    const told: string[] = [];
    let finish: () => void = () => {};
    const session = new ToolSession(dir, "host-a", false, undefined, undefined, undefined, (projectDir) => {
      told.push(projectDir);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    try {
      const started = Date.now();
      const listed = await session.call("issue_list", {});
      expect(listed.isError).toBeFalsy();
      expect(Date.now() - started).toBeLessThan(RECORD_READ_WAIT_MS + 1_000);
      await session.call("issue_create", { title: "local" });
      await session.call("search", { query: "local" });
      expect(told).toEqual([dir, dir]);
    } finally {
      finish();
      session.close();
    }
  });

  test("a list or search answered while the poll still runs says so in one plain line, and only then", async () => {
    let finish: () => void = () => {};
    const slow = new ToolSession(dir, "host-a", false, undefined, undefined, undefined, () => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const quick = new ToolSession(dir, "host-a", false, undefined, undefined, undefined, () => Promise.resolve());
    try {
      const listed = await slow.call("issue_list", {});
      expect(listed.content).toEqual([
        { type: "text", text: JSON.stringify({ issues: [], total: 0 }) },
        { type: "text", text: SYNC_RUNNING_NOTE },
      ]);
      expect((await slow.call("search", { query: "anything" })).content).toContainEqual({ type: "text", text: SYNC_RUNNING_NOTE });
      expect(SYNC_RUNNING_NOTE).not.toContain("\n");
      finish();
      expect((await quick.call("issue_list", {})).content).toHaveLength(1);
      expect((await quick.call("search", { query: "anything" })).content).toHaveLength(1);
    } finally {
      finish();
      slow.close();
      quick.close();
    }
  });

  test("a failing listener never fails the read", async () => {
    const session = new ToolSession(dir, "host-a", false, undefined, undefined, undefined, () => Promise.reject(new Error("offline")));
    try {
      expect((await session.call("issue_list", {})).isError).toBeFalsy();
    } finally {
      session.close();
    }
  });
});
