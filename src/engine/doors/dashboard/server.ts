// The dashboard door: a local web server over the project's record. The pages are read from a
// read-only connection; the Human's changes to an issue go through the engine's own operations,
// acting as the Human, so every rule holds here as it does for an agent or the command line.
// It listens on the loopback address only and answers the API only to its own host name.
import { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import page from "../../../../dashboard/web/index.html";
import { openView } from "../../graph/fresh.ts";
import { HandlerError, OPERATIONS } from "../../handlers/index.ts";
import { openProjectStore, projectDbPath } from "../../project.ts";
import { workingRepos, workspaceRepos } from "../../repos.ts";
import type { Actor, Store } from "../../store/index.ts";
import * as graph from "./code-graph.ts";
import * as q from "./queries.ts";

export const DEFAULT_PORT = 7477;
const HOST = "127.0.0.1";
const TOKEN_HEADER = "x-tmb-token";
const MAX_BODY_BYTES = 1024 * 1024;
const HUMAN: Actor = { kind: "human" };

export type Dashboard = { url: string; port: number; stop(): Promise<void> };

type Json = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function fail(status: number, error: string, message: string, extra: Json = {}): Response {
  return json({ error, message, ...extra }, status);
}

const HANDLER_STATUS = { invalid_input: 400, not_found: 404, refused: 409 } as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: Request): Promise<Json> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "send the body as application/json");
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "the body is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "the body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_input", "the body must be a JSON object");
  return body as Json;
}

/** The fields of `body` named in `keys`, left out when absent. */
function pick(body: Json, keys: readonly string[]): Json {
  return Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

/**
 * Serves the dashboard for the project at `projectDir` until stop() is called. Refuses a
 * project with no record, or one this build cannot read, the same way the other doors do.
 */
export function startDashboard(options: { projectDir: string; port?: number }): Dashboard {
  const opened = openProjectStore(options.projectDir, { create: false });
  if (!opened.ok) throw opened.error;
  const store: Store = opened.store;
  const db = new Database(projectDbPath(options.projectDir), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  const token = randomBytes(32).toString("hex");
  let allowedHosts: Set<string> = new Set();
  let graphQueue: Promise<void> = Promise.resolve();

  /** Refuses a request whose Host is not this server's own, so a page on another site cannot reach the API through DNS rebinding. */
  function checkHost(req: Request): void {
    if (!allowedHosts.has((req.headers.get("host") ?? "").toLowerCase())) throw new HttpError(403, "forbidden_host", "the dashboard answers only on its own address");
  }

  function checkToken(req: Request): void {
    const given = Buffer.from(req.headers.get(TOKEN_HEADER) ?? "");
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(403, "forbidden", "a change needs the token this dashboard page was given");
    }
  }

  function read(handler: (req: Request & { params: Record<string, string> }) => unknown) {
    return (req: Request & { params: Record<string, string> }) => {
      try {
        checkHost(req);
        const body = handler(req);
        return body === null ? fail(404, "not_found", "no such record") : json(body);
      } catch (error) {
        return failure(error);
      }
    };
  }

  /**
   * A read of the code graph at the base branch, brought forward first as every graph read is.
   * The page never sees a task's own changes. In a workspace, `repo` names whose graph; the page
   * shows the list of repos first, so it always names one when there are several.
   */
  function graphRead(handler: (db: Database, layer: string, req: Request & { params: Record<string, string> }) => unknown) {
    return async (req: Request & { params: Record<string, string> }) => {
      // One graph read at a time: two that both find the base moved on would both rebuild it.
      const turn = graphQueue;
      let done = () => {};
      graphQueue = new Promise<void>((resolve) => (done = resolve));
      await turn;
      try {
        checkHost(req);
        const repo = new URL(req.url).searchParams.get("repo") || undefined;
        const view = await openView(options.projectDir, store, { repo });
        try {
          const body = view.db.transaction(() => handler(view.db, view.layer, req)).deferred();
          return body === null ? fail(404, "not_found", "no such path or function in the code graph") : json({ ...(body as Json), commit: view.freshness.commit, baseBranch: view.freshness.baseBranch });
        } finally {
          view.db.close();
        }
      } catch (error) {
        return failure(error);
      } finally {
        done();
      }
    };
  }

  /**
   * A change to an issue, run through the engine's operation. With `fresh`, the request must
   * carry the `updated_at` it read and is refused when the issue moved on since.
   */
  function write(change: (id: string, body: Json) => unknown, options: { fresh: boolean }) {
    return async (req: Request & { params: Record<string, string> }) => {
      try {
        checkHost(req);
        checkToken(req);
        const body = await readJson(req);
        const id = req.params.id!;
        const issue = store.getIssue(id);
        if (!issue) throw new HandlerError("not_found", `no issue ${id} in the record`);
        if (options.fresh && typeof body.updated_at !== "string") {
          throw new HttpError(400, "invalid_input", "send the issue's updated_at as the page read it");
        }
        if (options.fresh && body.updated_at !== issue.updatedAt) {
          throw new HttpError(409, "stale", "the issue changed since this page read it; reload to see the change");
        }
        return json(change(id, body));
      } catch (error) {
        return failure(error);
      }
    };
  }

  const routes = {
    "/": page,
    "/api/token": read(() => ({ token })),
    "/api/version": read(() => ({ data_version: q.dataVersion(db) })),
    "/api/summary": read(() => q.summary(db)),
    "/api/issues": read(() => q.issues(db)),
    "/api/issues/:id": read((req) => q.issueDetail(db, req.params.id!)),
    "/api/tasks": read(() => q.tasks(db)),
    "/api/tasks/:id": read((req) => q.taskDetail(db, req.params.id!)),
    "/api/features": read(() => q.features(db)),
    "/api/runs": read((req) => q.runs(db, q.clampLimit(new URL(req.url).searchParams.get("limit")))),
    "/api/checks": read((req) => q.checkRuns(db, q.clampLimit(new URL(req.url).searchParams.get("limit")))),
    "/api/guard-decisions": read((req) => q.guardDecisions(db, q.clampLimit(new URL(req.url).searchParams.get("limit")))),
    "/api/audit": read((req) => q.audit(db, q.clampLimit(new URL(req.url).searchParams.get("limit")))),
    // The repos whose graphs the Code page can show: none in a project of one repo, which opens
    // straight on its graph.
    "/api/graph/repos": read(() => {
      const repos = workspaceRepos(store);
      return { repos: repos === null ? [] : workingRepos(repos) };
    }),
    "/api/graph/tree": graphRead((db, layer, req) => graph.tree(db, layer, new URL(req.url).searchParams.get("path") ?? ".")),
    "/api/graph/file": graphRead((db, layer, req) => graph.file(db, layer, new URL(req.url).searchParams.get("path") ?? "")),
    "/api/graph/function/:id": graphRead((db, layer, req) => (/^\d+$/.test(req.params.id!) ? graph.functionView(db, layer, Number(req.params.id)) : null)),
    "/api/graph/search": graphRead((db, layer, req) => ({ hits: graph.search(db, layer, new URL(req.url).searchParams.get("q") ?? "") })),
    "/api/issues/:id/edit": {
      POST: write((id, body) => OPERATIONS.issue_update.run(store, HUMAN, { id, ...pick(body, ["title", "body", "milestone"]) }), { fresh: true }),
    },
    "/api/issues/:id/comment": {
      POST: write((id, body) => OPERATIONS.discussion_append.run(store, HUMAN, { issue_id: id, kind: body.kind ?? "note", body: body.body }), { fresh: false }),
    },
    "/api/issues/:id/close": { POST: write((id) => OPERATIONS.issue_update.run(store, HUMAN, { id, state: "closed" }), { fresh: true }) },
    "/api/issues/:id/reopen": { POST: write((id) => OPERATIONS.issue_update.run(store, HUMAN, { id, state: "open" }), { fresh: true }) },
  };

  const server = Bun.serve({
    hostname: HOST,
    port: options.port ?? DEFAULT_PORT,
    development: false,
    maxRequestBodySize: MAX_BODY_BYTES,
    routes,
    fetch(req) {
      const path = new URL(req.url).pathname;
      return path.startsWith("/api/") ? fail(404, "not_found", `no API at ${path}`) : new Response("Not found", { status: 404 });
    },
  });
  allowedHosts = new Set([`${HOST}:${server.port}`, `localhost:${server.port}`]);

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

function failure(error: unknown): Response {
  if (error instanceof HttpError) return fail(error.status, error.code, error.message);
  if (error instanceof HandlerError) return fail(HANDLER_STATUS[error.code], error.code, error.message);
  console.error(`tmb dashboard: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return fail(500, "internal_error", "the dashboard hit an error; its terminal has the details");
}
