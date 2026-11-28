// The Human closes a mirrored issue on the dashboard: the remote takes it first, or the close is
// refused with the reason and the record is unchanged. The remote here is a stand-in: no network.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Dashboard, startDashboard } from "../../../src/dashboard/index.ts";
import { openProjectStore, type RemoteIssueAnswer, type RemoteIssueWriter } from "../../../src/engine/index.ts";
import type { Actor } from "../../../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const SYNCER: Actor = { kind: "tmb", source: "syncer" };
let project: string;
let dashboard: Dashboard | undefined;
let issueId: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-dashboard-mirror-")));
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  issueId = opened.store.mirror.createMirrored(SYNCER, "issue", {
    title: "Mirrored",
    body: "",
    remote: "github.com/o/r",
    remote_id: "I1",
    remote_url: "https://github.com/o/r/issues/1",
  });
  opened.store.close();
});

afterEach(async () => {
  await dashboard?.stop();
  dashboard = undefined;
  rmSync(project, { recursive: true, force: true });
});

async function close(answer: RemoteIssueAnswer): Promise<{ status: number; body: any; sent: unknown[] }> {
  const sent: unknown[] = [];
  const remoteIssues: RemoteIssueWriter = async (target, edit) => (sent.push({ target, edit }), answer);
  dashboard = startDashboard({ projectDir: project, port: 0, remoteIssues });
  const api = (route: string, init?: RequestInit) => fetch(new URL(`api/${route}`, dashboard!.url), init);
  const token = ((await (await api("token")).json()) as any).token as string;
  const issue = ((await (await api(`issues/${issueId}`)).json()) as any).issue;
  const res = await api(`issues/${issueId}/close`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tmb-token": token },
    body: JSON.stringify({ updated_at: issue.updated_at }),
  });
  return { status: res.status, body: await res.json(), sent };
}

function recorded(): { state: string; actor: Actor; events: number } {
  const opened = openProjectStore(project, { create: false });
  if (!opened.ok) throw opened.error;
  try {
    const events = opened.store.history(issueId);
    return { state: opened.store.getIssue(issueId)!.state, actor: events.at(-1)!.actor, events: events.length };
  } finally {
    opened.store.close();
  }
}

test("a close the remote took is recorded as the Human's", async () => {
  const answer: RemoteIssueAnswer = {
    ok: true,
    issue: { title: "Mirrored", body: "", state: "closed", stateReason: "completed", milestoneRemoteId: null, remoteUpdatedAt: "2026-11-28T00:00:00Z" },
  };
  const { status, sent } = await close(answer);
  expect(status).toBe(200);
  expect(sent).toEqual([{ target: { remote: "github.com/o/r", url: "https://github.com/o/r/issues/1" }, edit: { state: "closed" } }]);
  expect(recorded()).toMatchObject({ state: "closed", actor: { kind: "human" }, events: 2 });
});

test("a close the remote did not take is refused with the reason, and the record is unchanged", async () => {
  const { status, body } = await close({ ok: false, why: "GitHub could not be reached; check the network and try again" });
  expect(status).not.toBe(200);
  expect(body.message).toContain("GitHub could not be reached");
  expect(recorded()).toMatchObject({ state: "open", events: 1 });
});
