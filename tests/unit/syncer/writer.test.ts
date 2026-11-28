// A change to a mirrored issue goes to its remote first, then into the record, on made-up answers in
// the shape `gh api --include` prints: no network, no `gh`, nothing written to any real repository.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandlerError, OPERATIONS, openProjectStore, type RemoteIssueWriter, type Store, takeOutsideChanges } from "../../../src/engine/index.ts";
import { ToolSession } from "../../../src/engine/tool-server.ts";
import { type Answer, type Ask, type Change, type Changes, Folder, type Send, writeIssue } from "../../../src/syncer/index.ts";
import { ghSendArgs, readGhOutput } from "../../../src/syncer/transport.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const REMOTE = "github.com/trustmybot/tmb";
const URL1 = "https://github.com/trustmybot/tmb/issues/1";
const HUMAN = { kind: "human" } as const;
const PLANNER = { kind: "agent", role: "planner", host: "claude-code" } as const;

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmb-write-"));
  const opened = openProjectStore(dir, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** What `gh api --include` prints for one answer. */
const printed = (status: number, body: unknown, headers: Record<string, string> = {}): Answer =>
  readGhOutput(
    `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n${Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("")}\r\n${JSON.stringify(body)}`,
    "",
  );

/** GitHub's issue as an answer gives it. */
function rawIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: "I1",
    number: 1,
    html_url: URL1,
    title: "Mirror the remote",
    body: "bring it in",
    state: "open",
    state_reason: null,
    labels: [],
    assignees: [],
    milestone: { node_id: "M1", number: 1 },
    user: { login: "octocat" },
    created_at: "2026-11-26T00:00:00Z",
    updated_at: "2026-11-27T00:00:00Z",
    ...over,
  };
}

const item = (remoteId: string, url: string, at = "2026-11-26T00:00:00Z") => ({ remote: REMOTE, remoteId, remoteUpdatedAt: at, gone: false, url, author: "octocat", createdAt: at });

/** The remote as the syncer last read it: issue 1 in milestone "Level 1", with milestone "Level 2" also open. */
function remoteNow(issue: Partial<Changes["issues"][number]> = {}): Changes {
  return {
    milestones: [
      { ...item("M1", "https://github.com/trustmybot/tmb/milestone/1"), number: 1, title: "Level 1", description: "", state: "open" },
      { ...item("M2", "https://github.com/trustmybot/tmb/milestone/2"), number: 2, title: "Level 2", description: "", state: "open" },
    ],
    issues: [
      {
        ...item("I1", URL1),
        number: 1,
        title: "Mirror the remote",
        body: "bring it in",
        state: "open",
        stateReason: null,
        type: null,
        labels: [],
        assignees: [],
        milestoneRemoteId: "M1",
        ...issue,
      },
    ],
    comments: [],
    pullRequests: [],
  };
}

function mirrored(): string {
  new Folder(store, ".").fold(remoteNow());
  return store.listIssues()[0]!.id;
}

/** A remote that takes every change and answers with the issue as it is after it; it records what it was sent. */
function takingRemote(): { send: Send; ask: Ask; sent: Change[]; asked: string[] } {
  const sent: Change[] = [];
  const asked: string[] = [];
  let issue = rawIssue();
  const send: Send = async (change) => {
    sent.push(change);
    const fields = change.fields as Record<string, unknown>;
    issue = { ...issue, ...fields, updated_at: "2026-11-28T00:00:00Z" };
    if (fields.state === "closed") issue.state_reason = "completed";
    if (fields.state === "open") issue.state_reason = "reopened";
    if ("milestone" in fields) issue.milestone = fields.milestone === null ? null : { node_id: `M${fields.milestone}`, number: fields.milestone };
    return printed(200, issue);
  };
  const ask: Ask = async (request) => {
    asked.push(request.path);
    return printed(200, [
      { node_id: "M1", number: 1, title: "Level 1" },
      { node_id: "M2", number: 2, title: "Level 2" },
    ]);
  };
  return { send, ask, sent, asked };
}

const writerOf = (remote: { send: Send; ask: Ask }): RemoteIssueWriter => (target, edit) => writeIssue({ ask: remote.ask, send: remote.send, target, edit, now: new Date("2026-11-28T00:00:00Z") });

const update = (actor: typeof HUMAN | typeof PLANNER, input: Record<string, unknown>, remoteIssues?: RemoteIssueWriter) =>
  OPERATIONS.issue_update.run(store, actor, input, { projectDir: dir, remoteIssues });

async function refusal(call: Promise<unknown>): Promise<HandlerError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the change was made");
}

describe("a change to a mirrored issue", () => {
  test("the Human's close goes to the remote first, then is recorded as the Human's", async () => {
    const id = mirrored();
    const remote = takingRemote();
    const result = (await update(HUMAN, { id, state: "closed" }, writerOf(remote))) as { changed: string[] };
    expect(result.changed).toEqual(["state"]);
    expect(remote.sent).toEqual([{ host: "github.com", path: "repos/trustmybot/tmb/issues/1", method: "PATCH", fields: { state: "closed" } }]);
    expect(store.getIssue(id)!.state).toBe("closed");
    const last = store.history(id).at(-1)!;
    expect(last.actor).toEqual(HUMAN);
    expect(last.data).toEqual({ state: "closed", state_reason: "completed", remote_updated_at: "2026-11-28T00:00:00Z" });
  });

  test("the next poll finds the change already in the record and writes no event for it", async () => {
    const id = mirrored();
    await update(HUMAN, { id, state: "closed", title: "Mirror it", milestone: "Level 2" }, writerOf(takingRemote()));
    const events = store.history(id).length;
    const count = new Folder(store, ".").fold(
      remoteNow({ state: "closed", stateReason: "completed", title: "Mirror it", milestoneRemoteId: "M2", remoteUpdatedAt: "2026-11-28T00:00:00Z" }),
    );
    expect(count.updated).toBe(0);
    expect(store.history(id)).toHaveLength(events);
  });

  test("the planner's change takes the same path and names the planner", async () => {
    const id = mirrored();
    const remote = takingRemote();
    const session = new ToolSession(dir, "claude-code", false, undefined, undefined, undefined, undefined, writerOf(remote));
    try {
      const answer = await session.call("issue_update", { id, body: "a new body" });
      expect(answer.isError).toBeUndefined();
    } finally {
      session.close();
    }
    expect(remote.sent.map((change) => change.fields)).toEqual([{ body: "a new body" }]);
    expect(store.getIssue(id)!.body).toBe("a new body");
    expect(store.history(id).at(-1)!.actor).toEqual(PLANNER);
  });

  test("a milestone is sent by its number on the remote, found by its id, and recorded by its row", async () => {
    const id = mirrored();
    const remote = takingRemote();
    await update(HUMAN, { id, milestone: "Level 2" }, writerOf(remote));
    expect(remote.asked).toEqual(["repos/trustmybot/tmb/milestones?state=all&per_page=100"]);
    expect(remote.sent[0]!.fields).toEqual({ milestone: 2 });
    expect(store.getIssue(id)!.milestone).toBe("Level 2");
    takeOutsideChanges(store);
    await update(HUMAN, { id, milestone: "" }, writerOf(remote));
    expect(remote.sent[1]!.fields).toEqual({ milestone: null });
    expect(store.getIssue(id)!.milestone).toBeNull();
    expect(takeOutsideChanges(store)).toContain(": milestone removed, by the Human");
  });

  test("a milestone the record does not hold for that remote is refused before anything is sent", async () => {
    const id = mirrored();
    const remote = takingRemote();
    const refused = await refusal(update(HUMAN, { id, milestone: "Level 9" }, writerOf(remote)));
    expect(refused.message).toContain('no milestone named "Level 9"');
    expect(remote.sent).toEqual([]);
  });

  test("a change the remote does not take is refused, says why, and leaves the record unchanged", async () => {
    const id = mirrored();
    const before = store.history(id).length;
    const answers: [Answer, RegExp][] = [
      [{ sent: false, why: "no_client", said: "gh is not installed" }, /gh, GitHub's command line, is not installed/],
      [{ sent: false, why: "no_sign_in", said: "run gh auth login" }, /gh is not signed in to GitHub; run `gh auth login`/],
      [{ sent: false, why: "no_network", said: "dial tcp: no such host" }, /GitHub could not be reached/],
      [printed(403, { message: "Resource not accessible by integration" }), /no write access there/],
      [printed(404, { message: "Not Found" }), /deleted, or your account cannot see it/],
      [printed(410, { message: "This issue was deleted" }), /deleted on GitHub/],
      [printed(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795910400" }), /rate limit is reached; try again after 2026-/],
      [printed(422, { message: "Validation Failed" }), /GitHub refused the change: Validation Failed/],
    ];
    for (const [answer, why] of answers) {
      const send: Send = async () => answer;
      const refused = await refusal(update(HUMAN, { id, state: "closed" }, writerOf({ send, ask: takingRemote().ask })));
      expect(refused.code).toBe("refused");
      expect(refused.message).toMatch(why);
      expect(refused.message).toContain("The record is unchanged.");
    }
    expect(store.getIssue(id)!.state).toBe("open");
    expect(store.history(id)).toHaveLength(before);
  });

  test("with no way to the remote, or once the issue is gone from it, nothing is changed", async () => {
    const id = mirrored();
    expect((await refusal(update(HUMAN, { id, state: "closed" }))).message).toContain("cannot reach the remote");
    store.mirror.updateMirrored({ kind: "tmb", source: "syncer" }, "issue", id, { remote_gone_at: "2026-11-27T00:00:00Z" });
    const remote = takingRemote();
    expect((await refusal(update(HUMAN, { id, state: "closed" }, writerOf(remote)))).message).toContain("gone from the remote");
    expect(remote.sent).toEqual([]);
    expect(store.getIssue(id)!.state).toBe("open");
  });
});

describe("a local issue", () => {
  test("is recorded only: nothing is sent", async () => {
    const id = store.createIssue(HUMAN, { title: "Mine" });
    const remote = takingRemote();
    await update(HUMAN, { id, state: "closed", title: "Still mine" }, writerOf(remote));
    expect(remote.sent).toEqual([]);
    expect(store.getIssue(id)).toMatchObject({ state: "closed", title: "Still mine" });
  });

  test("a note or a decision on a mirrored issue stays local", async () => {
    const id = mirrored();
    const remote = takingRemote();
    const session = new ToolSession(dir, "claude-code", false, undefined, undefined, undefined, undefined, writerOf(remote));
    try {
      await session.call("discussion_append", { issue_id: id, kind: "decision", body: "keep it local" });
    } finally {
      session.close();
    }
    expect(remote.sent).toEqual([]);
    expect(store.listDiscussions(id).map((one) => one.kind)).toEqual(["decision"]);
  });
});

describe("the write through gh", () => {
  test("sends the fields as JSON on stdin with PATCH, never as flags", () => {
    expect(ghSendArgs({ host: "github.com", path: "repos/o/r/issues/1", method: "PATCH", fields: { title: "-f x=@/etc/passwd" } })).toEqual([
      "api",
      "--include",
      "--hostname",
      "github.com",
      "--method",
      "PATCH",
      "--input",
      "-",
      "repos/o/r/issues/1",
    ]);
  });
});
