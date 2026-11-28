// The dashboard's reads of a page's data tell the syncer first and wait for its poll only briefly:
// a slow or failing poll never holds up or fails the page. The open page's own check for new data
// starts a poll that is due and never waits; what never comes from the remote tells no one.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphReads } from "../../../src/dashboard/graph-reads.ts";
import type { RouteRequest } from "../../../src/dashboard/http.ts";
import type { PullRequestRefresher } from "../../../src/dashboard/pull-requests.ts";
import { RecordQueries } from "../../../src/dashboard/queries.ts";
import { RequestGuard } from "../../../src/dashboard/request-guard.ts";
import { DashboardRoutes } from "../../../src/dashboard/routes.ts";
import { type Actor, openProjectStore, projectDbPath, RECORD_READ_WAIT_MS, type RecordReadListener, type Store } from "../../../src/engine/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const PORT = 7477;
let project: string;
let store: Store;
let db: Database;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-dashboard-remote-")));
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  db = new Database(projectDbPath(project), { readonly: true });
});

afterEach(() => {
  db.close();
  store.close();
  rmSync(project, { recursive: true, force: true });
});

/** The dashboard's routes over the record, with `onRecordRead` as the command line would hand it; `get` reads one. */
function routesWith(onRecordRead?: RecordReadListener) {
  const guard = new RequestGuard();
  guard.listenOn(PORT);
  const none = { refresh: () => undefined, route: () => () => new Response(null) };
  const routes = new DashboardRoutes(store, HUMAN, new RecordQueries(db), guard, none as unknown as GraphReads, none as unknown as PullRequestRefresher, { projectDir: project }, onRecordRead);
  const table = routes.table(null) as unknown as Record<string, (req: RouteRequest) => Response | Promise<Response>>;
  return async (route: string) => {
    const req = Object.assign(new Request(`http://127.0.0.1:${PORT}${route}`, { headers: { host: `127.0.0.1:${PORT}` } }), { params: {} });
    return await table[route]!(req);
  };
}

test("a read of a page's data tells the syncer first, and reads what its poll brought in", async () => {
  const told: string[] = [];
  const get = routesWith(async (projectDir) => {
    told.push(projectDir);
    store.createIssue({ kind: "agent", role: "planner", host: "host-a" }, { title: "From the remote" });
  });
  const issues = (await (await get("/api/issues")).json()) as { title: string }[];
  expect(told).toEqual([project]);
  expect(issues.map((issue) => issue.title)).toEqual(["From the remote"]);
  for (const route of ["/api/summary", "/api/tasks", "/api/features", "/api/runs", "/api/audit"]) expect((await get(route)).status).toBe(200);
  expect(told).toHaveLength(6);
});

test("a slow poll holds a page's data up only briefly, and the page's check for new data not at all", async () => {
  let told = 0;
  let finish: () => void = () => {};
  const get = routesWith(() => {
    told += 1;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  try {
    const started = Date.now();
    expect((await get("/api/issues")).status).toBe(200);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(RECORD_READ_WAIT_MS - 100);
    expect(waited).toBeLessThan(RECORD_READ_WAIT_MS + 1_000);
    const checked = Date.now();
    expect((await get("/api/version")).status).toBe(200);
    expect(Date.now() - checked).toBeLessThan(RECORD_READ_WAIT_MS / 2);
    expect(told).toBe(2);
  } finally {
    finish();
  }
});

test("a poll that fails, or a listener that throws, never fails the page", async () => {
  const rejected = routesWith(() => Promise.reject(new Error("offline")));
  expect((await rejected("/api/issues")).status).toBe(200);
  expect((await rejected("/api/version")).status).toBe(200);
  const thrown = routesWith(() => {
    throw new Error("no syncer");
  });
  expect((await thrown("/api/issues")).status).toBe(200);
  expect((await thrown("/api/version")).status).toBe(200);
});

test("the page's token tells no one, and with no listener every read answers from the record", async () => {
  let told = 0;
  const get = routesWith(() => void (told += 1));
  expect((await get("/api/token")).status).toBe(200);
  expect(told).toBe(0);
  const alone = routesWith();
  expect((await alone("/api/issues")).status).toBe(200);
  expect((await alone("/api/version")).status).toBe(200);
});
