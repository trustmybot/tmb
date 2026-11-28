// The dashboard moves a feature whose pull request merged when a page reads the features or the
// tasks, as the Human, asking GitHub about each pull request at most once a minute (trustmybot/tmb#131).
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Dashboard, startDashboard } from "../../../src/dashboard/index.ts";
import { openProjectStore } from "../../../src/engine/index.ts";
import type { Actor } from "../../../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "host-a" };
const PR = "https://github.com/o/r/pull/7";
let project: string;
let dashboard: Dashboard | undefined;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-dashboard-pr-")));
});

afterEach(async () => {
  await dashboard?.stop();
  dashboard = undefined;
  rmSync(project, { recursive: true, force: true });
});

test("reads each open pull request at most once a minute, and records the merge as the Human", async () => {
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  const id = opened.store.createFeature(PLANNER, { name: "feat/x", baseBranch: "main", baseCommit: "0".repeat(40) });
  opened.store.updateFeature(PLANNER, id, { state: "pr_open", prUrl: PR });
  opened.store.close();

  let reads = 0;
  let answer: "OPEN" | "MERGED" = "OPEN";
  dashboard = startDashboard({ projectDir: project, port: 0, readPullRequest: () => (reads++, answer) });
  const get = async (route: string) => (await (await fetch(new URL(`api/${route}`, dashboard!.url))).json()) as any;

  expect((await get("features"))[0].state).toBe("pr_open");
  answer = "MERGED";
  expect((await get("features"))[0].state).toBe("pr_open");
  await get("tasks");
  expect(reads).toBe(1);

  await dashboard.stop();
  dashboard = startDashboard({ projectDir: project, port: 0, readPullRequest: () => (reads++, answer) });
  expect((await get("features"))[0].state).toBe("merged");
  expect(reads).toBe(2);

  const reopened = openProjectStore(project, { create: false });
  if (!reopened.ok) throw reopened.error;
  expect(reopened.store.history(id).at(-1)!.actor).toEqual(HUMAN);
  reopened.store.close();
});
