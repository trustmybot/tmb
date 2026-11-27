// The syncer's reader, on recorded answers: no network, no `gh`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLOOR_MS, NOTHING_KEPT, readItem, readRemote } from "../src/syncer/index.ts";
import type { Answer, Ask, Kept, Request } from "../src/syncer/index.ts";
import { ghArgs, nextPage, readGhOutput, waitAsked } from "../src/syncer/transport.ts";

const recorded = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "syncer", `${name}.txt`), "utf8");
const REPO = { host: "github.com", owner: "trustmybot", name: "tmb" };
const NOW = new Date("2026-11-27T03:00:00Z");

/** Drops the `link` header, so a recorded page reads as the list's only page. */
const onePage = (raw: string): string => raw.replace(/^Link:.*\r\n/m, "");

/** Answers each request from the first recording whose key its path contains. */
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

describe("reading gh's output", () => {
  test("the status, headers and body of a good answer", () => {
    const answer = readGhOutput(recorded("ms"), "");
    expect(answer.sent && answer.status).toBe(200);
    expect(answer.sent && answer.headers["etag"]).toStartWith('W/"');
    expect(answer.sent && JSON.parse(answer.body)[0].title).toBe("v1.x");
    expect(answer.sent && nextPage(answer.headers)).toContain("page=2");
  });

  test("not modified is an answer, though gh exits non-zero on it", () => {
    const answer = readGhOutput(recorded("not-modified"), "gh: HTTP 304\n");
    expect(answer).toMatchObject({ sent: true, status: 304, body: "" });
  });

  test("no sign-in and no network are told apart from gh's words", () => {
    expect(readGhOutput("", "To get started with GitHub CLI, please run:  gh auth login\n")).toMatchObject({ sent: false, why: "no_sign_in" });
    expect(readGhOutput("", 'Get "https://api.github.com/repos/a/b": dial tcp: lookup api.github.com: no such host\n')).toMatchObject({ sent: false, why: "no_network" });
    expect(readGhOutput("", "something else\n")).toMatchObject({ sent: false, why: "failed" });
  });

  test("only GET is sent, with the kept tag", () => {
    expect(ghArgs({ host: "github.com", path: "repos/a/b/issues", tag: 'W/"x"' })).toEqual(["api", "--include", "--hostname", "github.com", "--method", "GET", "-H", 'If-None-Match: W/"x"', "repos/a/b/issues"]);
  });

  test("the wait the remote asks for", () => {
    const primary = readGhOutput(recorded("rate-limited-primary"), "") as Extract<Answer, { sent: true }>;
    expect(waitAsked(primary, NOW)).toBe(new Date(1795750000 * 1000).toISOString());
    const secondary = readGhOutput(recorded("rate-limited-secondary"), "") as Extract<Answer, { sent: true }>;
    expect(waitAsked(secondary, NOW)).toBe("2026-11-27T03:01:30.000Z");
    expect(waitAsked({ status: 403, headers: {}, body: '{"message":"secondary rate limit"}' }, NOW)).toBe("2026-11-27T03:01:00.000Z");
    expect(waitAsked({ status: 403, headers: {}, body: '{"message":"Resource not accessible"}' }, NOW)).toBeNull();
  });
});

describe("the first read", () => {
  test("returns every list as plain values, and what to keep", async () => {
    const { ask, asked } = recordedAsk(everyList());
    const answer = await readRemote({ repo: REPO, kept: NOTHING_KEPT, ask, now: NOW });
    if (!answer.ok) throw new Error(answer.why);
    expect(answer.remote).toBe("github.com/trustmybot/tmb");
    expect(answer.changed).toBe(true);
    expect(answer.requests).toBe(5);
    expect(asked.every((request) => !request.tag)).toBe(true);

    expect(answer.issues[0]).toMatchObject({
      remote: "github.com/trustmybot/tmb",
      remoteId: "I_kwDOVzoTK88AAAABil7YYQ",
      remoteUpdatedAt: "2026-11-26T00:10:05Z",
      gone: false,
      url: "https://github.com/trustmybot/tmb/issues/304",
      author: "Zax-TMB",
      number: 304,
      state: "open",
      stateReason: null,
      type: null,
      assignees: [],
      milestoneRemoteId: null,
    });
    expect(answer.issues[0]!.labels.length).toBeGreaterThan(0);
    expect(answer.comments[0]).toMatchObject({ remoteId: "IC_kwDOVzoTK88AAAABrBjBmA", on: { kind: "issue", number: 308 }, review: false, author: "Zax-TMB" });
    expect(answer.pullRequests[0]).toMatchObject({ number: 299, state: "open", draft: false, baseRemote: "github.com/trustmybot/tmb", headRemote: "github.com/trustmybot/tmb", baseBranch: "dev" });
    expect(answer.pullRequests[0]!.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(answer.milestones[0]).toMatchObject({ remoteId: "MI_kwDOVzoTK84BLK3l", title: "v1.x", state: "open" });

    expect(answer.keep.lists.issues).toEqual({ tag: 'W/"58187fc690cc1227bc9ffdfd1e2e3c066262cce95c6350fbadd8d7355dd7da36"', since: answer.issues.map((issue) => issue.remoteUpdatedAt).sort().at(-1)! });
    expect(answer.keep.lists.review_comments?.since).toBeNull();
    expect(answer.keep.notBefore).toBe(new Date(NOW.getTime() + FLOOR_MS).toISOString());
    expect(answer.keep.waitUntil).toBeNull();
  });

  test("a pull request in the issues list is left to the pull request list", async () => {
    const issues = onePage(recorded("issues")).replace('"number": 304,', '"number": 304, "pull_request": {"html_url": "x"},');
    const { ask } = recordedAsk([["/issues?", issues], ...everyList()]);
    const answer = await readRemote({ repo: REPO, kept: NOTHING_KEPT, ask, now: NOW });
    expect(answer.ok && answer.issues.map((issue) => issue.number)).not.toContain(304);
  });
});

describe("the next read", () => {
  const kept = async (): Promise<Kept> => {
    const first = await readRemote({ repo: REPO, kept: NOTHING_KEPT, ask: recordedAsk(everyList()).ask, now: NOW });
    return first.keep;
  };
  const later = new Date(NOW.getTime() + FLOOR_MS);

  test("inside the two-minute floor asks nothing; a forced read ignores the floor", async () => {
    const { ask, asked } = recordedAsk([["", recorded("not-modified")]]);
    const soon = new Date(NOW.getTime() + FLOOR_MS - 1);
    const answer = await readRemote({ repo: REPO, kept: await kept(), ask, now: soon });
    expect(answer).toMatchObject({ ok: false, cannot: "too_soon" });
    expect(asked).toHaveLength(0);
    expect((await readRemote({ repo: REPO, kept: await kept(), ask, now: soon, force: true })).ok).toBe(true);
  });

  test("an unchanged remote sends back each tag and costs nothing", async () => {
    const before = await kept();
    const { ask, asked } = recordedAsk([["", recorded("not-modified")]]);
    const answer = await readRemote({ repo: REPO, kept: before, ask, now: later });
    if (!answer.ok) throw new Error(answer.why);
    expect(asked).toHaveLength(5);
    expect(asked.every((request) => typeof request.tag === "string" && request.tag !== "")).toBe(true);
    expect(answer).toMatchObject({ changed: false, requests: 0, issues: [], comments: [], pullRequests: [], milestones: [] });
    expect(answer.keep.lists).toEqual(before.lists);
  });

  test("only items changed since the kept time come back", async () => {
    const before = await kept();
    before.lists.issues = { tag: "old", since: "2026-11-26T00:10:06Z" };
    const { ask } = recordedAsk([["/issues?", onePage(recorded("issues"))], ["", recorded("not-modified")]]);
    const answer = await readRemote({ repo: REPO, kept: before, ask, now: later });
    if (!answer.ok) throw new Error(answer.why);
    expect(answer.changed).toBe(true);
    expect(answer.requests).toBe(1);
    expect(answer.issues.map((issue) => issue.number)).not.toContain(304);
    expect(answer.issues.every((issue) => issue.remoteUpdatedAt >= "2026-11-26T00:10:06Z")).toBe(true);
  });

  test("more than one page of changes is read oldest first with the since-time, and resumes when cut short", async () => {
    const before = await kept();
    before.lists.issues = { tag: "old", since: "2026-11-01T00:00:00Z" };
    // The recorded first page keeps its link to a next page, and every item on it is newer than the kept time.
    const { ask, asked } = recordedAsk([["direction=asc", recorded("issues")], ["/issues?", recorded("issues")], ["", recorded("not-modified")]]);
    const answer = await readRemote({ repo: REPO, kept: before, ask, now: later, pageLimit: 2 });
    if (!answer.ok) throw new Error(answer.why);
    const resumed = asked.find((request) => request.path.includes("direction=asc"))!;
    expect(resumed.path).toContain("since=2026-11-01T00%3A00%3A00Z");
    expect(resumed.tag).toBeNull();
    expect(answer.incomplete).toEqual(["issues"]);
    expect(answer.keep.lists.issues!.tag).toBeNull();
    expect(answer.keep.lists.issues!.since! > "2026-11-01T00:00:00Z").toBe(true);
  });

  test("a pull request list cut short keeps its since-time, so no change is skipped", async () => {
    const { ask } = recordedAsk([["/pulls?", recorded("pulls")], ["/repositories/", recorded("pulls")], ...everyList()]);
    const answer = await readRemote({ repo: REPO, kept: NOTHING_KEPT, ask, now: NOW, pageLimit: 2 });
    if (!answer.ok) throw new Error(answer.why);
    expect(answer.incomplete).toEqual(["pull_requests"]);
    expect(answer.keep.lists.pull_requests).toEqual({ tag: null, since: null });
  });
});

describe("a remote that cannot be read", () => {
  const cases: [string, Parameters<typeof readRemote>[0]["repo"], string | Answer, object][] = [
    ["no GitHub origin", null, recorded("not-modified"), { cannot: "not_github" }],
    ["no sign-in", REPO, { sent: false, why: "no_sign_in", said: "gh auth login" }, { cannot: "no_sign_in" }],
    ["no network", REPO, { sent: false, why: "no_network", said: "no such host" }, { cannot: "no_network" }],
    ["a host that is not GitHub", { ...REPO, host: "gitlab.com" }, recorded("not-found"), { cannot: "not_github" }],
    ["a repository the sign-in cannot see", REPO, recorded("not-found"), { cannot: "failed" }],
    ["an answer that is no list", REPO, "HTTP/2.0 200 OK\r\n\r\n<html>", { cannot: "failed" }],
  ];
  for (const [name, repo, said, expected] of cases) {
    test(name, async () => {
      const before: Kept = { lists: { issues: { tag: "t", since: "2026-11-01T00:00:00Z" } }, notBefore: null, waitUntil: null };
      const answer = await readRemote({ repo, kept: before, ask: recordedAsk([["", said]]).ask, now: NOW });
      expect(answer).toMatchObject({ ok: false, ...expected });
      expect(answer.keep.lists).toEqual(before.lists);
    });
  }

  test("rate limited: the wait is kept, and no read runs before it, forced or not", async () => {
    const { ask, asked } = recordedAsk([["/issues?", recorded("rate-limited-secondary")], ...everyList()]);
    const answer = await readRemote({ repo: REPO, kept: NOTHING_KEPT, ask, now: NOW });
    expect(answer).toMatchObject({ ok: false, cannot: "rate_limited", keep: { waitUntil: "2026-11-27T03:01:30.000Z", lists: {} } });
    const sent = asked.length;
    const again = await readRemote({ repo: REPO, kept: answer.keep, ask, now: new Date("2026-11-27T03:01:00Z"), force: true });
    expect(again).toMatchObject({ ok: false, cannot: "too_soon" });
    expect(asked).toHaveLength(sent);
  });

  test("a failed ask never throws", async () => {
    const ask: Ask = async () => ({ sent: false, why: "failed", said: "boom" });
    expect(await readRemote({ repo: REPO, kept: NOTHING_KEPT, ask, now: NOW })).toMatchObject({ ok: false, cannot: "failed", why: "boom" });
  });
});

describe("one item asked for directly", () => {
  test("a deleted item is gone", async () => {
    const { ask, asked } = recordedAsk([["", recorded("not-found")]]);
    expect(await readItem({ repo: REPO, ask, kind: "issue", number: 304, now: NOW })).toEqual({ ok: true, gone: true });
    expect(asked[0]!.path).toBe("repos/trustmybot/tmb/issues/304");
  });

  test("an item that moved names the repository it is in now", async () => {
    const one = JSON.stringify({ ...JSON.parse(recorded("issues").split("\r\n\r\n")[1]!)[0], html_url: "https://github.com/trustmybot/other/issues/9" });
    const { ask } = recordedAsk([["", `HTTP/2.0 200 OK\r\n\r\n${one}`]]);
    const answer = await readItem({ repo: REPO, ask, kind: "issue", number: 304, now: NOW });
    expect(answer).toMatchObject({ ok: true, gone: false, item: { remote: "github.com/trustmybot/other", remoteId: "I_kwDOVzoTK88AAAABil7YYQ" } });
  });

  test("a rate limit is a typed answer with its wait", async () => {
    const { ask } = recordedAsk([["", recorded("rate-limited-primary")]]);
    expect(await readItem({ repo: REPO, ask, kind: "milestone", number: 12, now: NOW })).toMatchObject({ ok: false, cannot: "rate_limited", waitUntil: new Date(1795750000 * 1000).toISOString() });
  });
});
