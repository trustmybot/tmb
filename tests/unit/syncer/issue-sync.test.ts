// How much of the remote's issues comes in: the open ones, all, or none, on a made-up remote that
// answers as GitHub does, two items a page. No network, no `gh`.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectStore, type Store, writeSetting } from "../../../src/engine/index.ts";
import { type Ask, type Request, syncProject } from "../../../src/syncer/index.ts";
import { readGhOutput } from "../../../src/syncer/transport.ts";

setDefaultTimeout(30_000);

const REMOTE = "github.com/trustmybot/tmb";
const EMPTY = 'HTTP/2.0 200 OK\r\nEtag: "empty"\r\n\r\n[]';
const PER_PAGE = 2;

type RawIssue = { node_id: string; number: number; title: string; state: "open" | "closed"; updated_at: string };

/** A remote holding `issues`; every other list is empty. Lists and conditional answers as GitHub gives them. */
function fakeRemote(issues: RawIssue[]): { ask: Ask; asked: Request[] } {
  const asked: Request[] = [];
  const raw = (issue: RawIssue) => ({ ...issue, body: "", created_at: "2026-11-01T00:00:00Z", html_url: `https://github.com/trustmybot/tmb/issues/${issue.number}`, user: { login: "octocat" }, labels: [], assignees: [] });
  const ask: Ask = async (request) => {
    asked.push(request);
    const one = /\/issues\/(\d+)$/.exec(request.path);
    if (one !== null) {
      const found = issues.find((issue) => issue.number === Number(one[1]));
      return readGhOutput(found === undefined ? "HTTP/2.0 404 Not Found\r\n\r\n{}" : `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(raw(found))}`, "");
    }
    if (!request.path.includes("/issues?")) return readGhOutput(request.tag === '"empty"' ? "HTTP/2.0 304 Not Modified\r\n\r\n" : EMPTY, "");
    const url = new URL(`https://api.github.com/${request.path}`);
    const state = url.searchParams.get("state");
    const since = url.searchParams.get("since");
    const page = Number(url.searchParams.get("page") ?? "1");
    const listed = issues
      .filter((issue) => (state === "all" || issue.state === state) && (since === null || issue.updated_at >= since))
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
    if (url.searchParams.get("direction") === "desc") listed.reverse();
    const tag = `"${state}-${listed.map((issue) => `${issue.number}@${issue.updated_at}`).join(",")}"`;
    if (page === 1 && request.tag === tag) return readGhOutput("HTTP/2.0 304 Not Modified\r\n\r\n", "");
    url.searchParams.set("page", String(page + 1));
    const link = page * PER_PAGE < listed.length ? `Link: <${url.toString()}>; rel="next"\r\n` : "";
    return readGhOutput(`HTTP/2.0 200 OK\r\nEtag: ${tag}\r\n${link}\r\n${JSON.stringify(listed.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(raw))}`, "");
  };
  return { ask, asked };
}

const issue = (number: number, state: "open" | "closed", day: number): RawIssue => ({ node_id: `I_${number}`, number, title: `issue ${number}`, state, updated_at: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z` });

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmb-issue-sync-"));
  spawnSync("git", ["init", "-q", dir]);
  spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/trustmybot/tmb.git"]);
  const opened = openProjectStore(dir, { create: true });
  if (!opened.ok) throw opened.error;
  opened.store.close();
  // A day back, so the ids made under it never run ahead of the real clock for the tests after this file.
  clock = Date.now() - 24 * 60 * 60_000;
  setSystemTime(new Date(clock));
});

afterEach(() => {
  setSystemTime();
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

/** The record's mirrored issues, by number, with their state. */
const held = (): Record<number, string> =>
  Object.fromEntries(withStore((store) => store.listIssues().map((row) => [Number(row.title.replace("issue ", "")), row.state])));

/** The Human's answer, a minute after the last poll. */
function choose(mode: "open" | "all" | "off"): void {
  clock += 60_000;
  setSystemTime(new Date(clock));
  withStore((store) => writeSetting(store, { kind: "human" }, "issue_sync", mode));
}

/** One poll a floor after the last, as the session start or the planner's read starts it. */
async function poll(ask: Ask, pageLimit?: number) {
  clock += 3 * 60_000;
  setSystemTime(new Date(clock));
  const [outcome] = await syncProject(dir, { askFor: () => ask, pageLimit });
  return outcome!;
}

describe("only the open issues", () => {
  test("unset reads as open: the import asks for the open ones, and a later close of one comes in", async () => {
    const issues = [issue(1, "open", 1), issue(2, "closed", 2), issue(3, "open", 3)];
    const remote = fakeRemote(issues);
    expect(await poll(remote.ask)).toMatchObject({ ok: true });
    expect(remote.asked.find((request) => request.path.includes("/issues?"))!.path).toContain("state=open");
    expect(held()).toEqual({ 1: "open", 3: "open" });

    // Issue 1 closes, and the never-held closed issue 2 changes: the read sees both, and copies the close only.
    issues[0] = issue(1, "closed", 10);
    issues[1] = issue(2, "closed", 11);
    remote.asked.length = 0;
    expect(await poll(remote.ask)).toMatchObject({ ok: true, count: { updated: 1, created: 0 } });
    expect(remote.asked.find((request) => request.path.includes("/issues?"))!.path).toContain("state=all");
    expect(held()).toEqual({ 1: "closed", 3: "open" });
  });

  test("choosing all brings the closed ones in at the next poll, and choosing open again removes nothing", async () => {
    const issues = [issue(1, "open", 1), issue(2, "closed", 2), issue(4, "closed", 4)];
    const remote = fakeRemote(issues);
    await poll(remote.ask);
    expect(held()).toEqual({ 1: "open" });

    choose("all");
    expect(await poll(remote.ask)).toMatchObject({ ok: true, fullPass: true });
    expect(held()).toEqual({ 1: "open", 2: "closed", 4: "closed" });

    choose("open");
    expect(await poll(remote.ask)).toMatchObject({ ok: true, fullPass: false });
    expect(held()).toEqual({ 1: "open", 2: "closed", 4: "closed" });
  });

  test("a weekly full pass of the open ones asks after a held open issue it no longer lists, and never after a held closed one", async () => {
    const issues = [issue(1, "open", 1), issue(2, "open", 2), issue(3, "closed", 3)];
    const remote = fakeRemote(issues);
    choose("all");
    await poll(remote.ask);
    choose("open");
    expect(held()).toEqual({ 1: "open", 2: "open", 3: "closed" });

    // Issue 2 closes, and the change is older than the kept time, so only a full pass can find it.
    issues[1] = { ...issue(2, "closed", 2) };
    withStore((store) => {
      for (const row of store.mirror.syncRows(REMOTE)) store.mirror.putSyncRow({ ...row, fullPassAt: new Date(clock - 8 * 24 * 60 * 60_000).toISOString() });
    });
    remote.asked.length = 0;
    expect(await poll(remote.ask)).toMatchObject({ ok: true, fullPass: true });
    expect(remote.asked.map((request) => request.path).filter((path) => /\/issues\/\d+$/.test(path))).toEqual(["repos/trustmybot/tmb/issues/2"]);
    expect(held()).toEqual({ 1: "open", 2: "closed", 3: "closed" });
  });
});

describe("all issues", () => {
  test("a first import of many pages is bounded per poll and carries on where it stopped", async () => {
    const issues = [1, 2, 3, 4, 5, 6, 7].map((number) => issue(number, number % 2 === 0 ? "closed" : "open", number));
    const remote = fakeRemote(issues);
    choose("all");

    const asks = () => remote.asked.filter((request) => request.path.includes("/issues?")).length;
    const polls: { asks: number; held: number }[] = [];
    let outcome = await poll(remote.ask, 2);
    polls.push({ asks: asks(), held: Object.keys(held()).length });
    while (outcome.ok && outcome.incomplete.includes("issues") && polls.length < 10) {
      remote.asked.length = 0;
      outcome = await poll(remote.ask, 2);
      polls.push({ asks: asks(), held: Object.keys(held()).length });
    }
    expect(outcome).toMatchObject({ ok: true, incomplete: [] });
    expect(polls.length).toBeGreaterThan(1);
    for (const one of polls) expect(one.asks).toBeLessThanOrEqual(2);
    expect(polls[0]!.held).toBeLessThan(7);
    for (let i = 1; i < polls.length; i++) expect(polls[i]!.held).toBeGreaterThan(polls[i - 1]!.held);
    expect(Object.keys(held()).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(withStore((store) => store.mirror.syncRows(REMOTE).find((row) => row.list === "issues")!.since)).toBe("2026-11-07T00:00:00Z");
  });
});
