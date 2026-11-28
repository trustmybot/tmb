// The dashboard door: a local web server over the project's record. The pages are read from a
// read-only connection; the Human's changes to an issue go through the engine's own operations,
// acting as the Human, so every rule holds here as it does for an agent or the command line.
// It listens on the loopback address only and answers the API only to its own host name.
import { Database } from "bun:sqlite";
import page from "./web/index.html";
import { type Actor, openProjectStore, projectDbPath, type PullRequestReader, type RecordReadListener, type RemoteIssueWriter, type Store } from "../engine/index.ts";
import { BUSY_TIMEOUT_MS, DEFAULT_PORT, HOST, MAX_BODY_BYTES } from "./constants.ts";
import { GraphReads } from "./graph-reads.ts";
import { fail } from "./http.ts";
import { PullRequestRefresher } from "./pull-requests.ts";
import { RecordQueries } from "./queries.ts";
import { RequestGuard } from "./request-guard.ts";
import { DashboardRoutes } from "./routes.ts";

export { DEFAULT_PORT, PULL_REQUEST_READ_INTERVAL_MS } from "./constants.ts";

const HUMAN: Actor = { kind: "human" };

export type Dashboard = { url: string; port: number; stop(): Promise<void> };

/**
 * Serves the dashboard for the project at `projectDir` until stop() is called. Refuses a
 * project with no record, or one this build cannot read, the same way the other doors do.
 * `remoteIssues` writes the Human's change to a mirrored issue on its remote; without it, such a change is refused.
 * `onRecordRead` is told before a page's data is read, so a poll of the remote may refresh the record first.
 */
export function startDashboard(options: {
  projectDir: string;
  port?: number;
  readPullRequest?: PullRequestReader;
  remoteIssues?: RemoteIssueWriter;
  onRecordRead?: RecordReadListener;
}): Dashboard {
  const opened = openProjectStore(options.projectDir, { create: false });
  if (!opened.ok) throw opened.error;
  const store: Store = opened.store;
  const db = new Database(projectDbPath(options.projectDir), { readonly: true });
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const guard = new RequestGuard();
  const routes = new DashboardRoutes(
    store,
    HUMAN,
    new RecordQueries(db),
    guard,
    new GraphReads(options.projectDir, store, guard),
    new PullRequestRefresher(store, HUMAN, options.projectDir, options.readPullRequest),
    { projectDir: options.projectDir, remoteIssues: options.remoteIssues },
    options.onRecordRead,
  );

  const server = Bun.serve({
    hostname: HOST,
    port: options.port ?? DEFAULT_PORT,
    development: false,
    maxRequestBodySize: MAX_BODY_BYTES,
    routes: routes.table(page),
    fetch(req) {
      const path = new URL(req.url).pathname;
      return path.startsWith("/api/") ? fail(404, "not_found", `no API at ${path}`) : new Response("Not found", { status: 404 });
    },
  });
  guard.listenOn(server.port!);

  return {
    url: `http://${HOST}:${server.port}/`,
    port: server.port!,
    async stop() {
      await server.stop(true);
      db.close();
      store.close();
    },
  };
}
