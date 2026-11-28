// The dashboard's API, path by path. Pages are read from the read-only connection; the Human's
// changes to an issue go through the engine's own operations, acting as the Human.
import { type Actor, HandlerError, OPERATIONS, type Store, workingRepos, workspaceRepos } from "../engine/index.ts";
import type { GraphReads } from "./graph-reads.ts";
import { fail, failure, HttpError, type Json, json, param, pick, readJson, type RouteRequest } from "./http.ts";
import type { PullRequestRefresher } from "./pull-requests.ts";
import { clampLimit, type RecordQueries } from "./queries.ts";
import type { RequestGuard } from "./request-guard.ts";

type Handler = (req: RouteRequest) => Response | Promise<Response>;

/** What a change to an issue needs: with `fresh`, the request must carry the `updated_at` it read. */
type WriteOptions = { readonly fresh: boolean };

export class DashboardRoutes {
  constructor(
    private readonly store: Store,
    private readonly actor: Actor,
    private readonly queries: RecordQueries,
    private readonly guard: RequestGuard,
    private readonly graph: GraphReads,
    private readonly pullRequests: PullRequestRefresher,
  ) {}

  /** Every route, with `page` served at the root. */
  table<Page>(page: Page) {
    const q = this.queries;
    const refreshed = <T>(read: () => T) => (this.pullRequests.refresh(), read());
    const limit = (req: Request) => clampLimit(param(req, "limit"));
    const update = OPERATIONS.issue_update;
    return {
      "/": page,
      "/api/token": this.read(() => ({ token: this.guard.token })),
      "/api/version": this.read(() => ({ data_version: q.dataVersion() })),
      "/api/summary": this.read(() => q.summary()),
      "/api/issues": this.read(() => q.issues()),
      "/api/issues/:id": this.read((req) => q.issueDetail(req.params.id!)),
      "/api/tasks": this.read(() => refreshed(() => q.tasks())),
      "/api/tasks/:id": this.read((req) => refreshed(() => q.taskDetail(req.params.id!))),
      "/api/features": this.read(() => refreshed(() => q.features())),
      "/api/runs": this.read((req) => q.runs(limit(req))),
      "/api/checks": this.read((req) => q.checkRuns(limit(req))),
      "/api/guard-decisions": this.read((req) => q.guardDecisions(limit(req))),
      "/api/audit": this.read((req) => q.audit(limit(req))),
      // The repos whose graphs the Code page can show: none in a project of one repo, which opens
      // straight on its graph.
      "/api/graph/repos": this.read(() => {
        const repos = workspaceRepos(this.store);
        return { repos: repos === null ? [] : workingRepos(repos) };
      }),
      "/api/graph/tree": this.graph.route((graph, req) => graph.tree(param(req, "path") ?? ".")),
      "/api/graph/file": this.graph.route((graph, req) => graph.file(param(req, "path") ?? "")),
      "/api/graph/function/:id": this.graph.route((graph, req) => (/^\d+$/.test(req.params.id!) ? graph.functionView(Number(req.params.id)) : null)),
      "/api/graph/search": this.graph.route((graph, req) => ({ hits: graph.search(param(req, "q") ?? "") })),
      "/api/issues/:id/edit": {
        POST: this.write((id, body) => update.run(this.store, this.actor, { id, ...pick(body, ["title", "body", "milestone"]) }), { fresh: true }),
      },
      "/api/issues/:id/comment": {
        POST: this.write((id, body) => OPERATIONS.discussion_append.run(this.store, this.actor, { issue_id: id, kind: body.kind ?? "note", body: body.body }), { fresh: false }),
      },
      "/api/issues/:id/close": { POST: this.write((id) => update.run(this.store, this.actor, { id, state: "closed" }), { fresh: true }) },
      "/api/issues/:id/reopen": { POST: this.write((id) => update.run(this.store, this.actor, { id, state: "open" }), { fresh: true }) },
    };
  }

  /** A read of the record; null is a 404. */
  private read(handler: (req: RouteRequest) => unknown): Handler {
    return (req) => {
      try {
        this.guard.checkHost(req);
        const body = handler(req);
        return body === null ? fail(404, "not_found", "no such record") : json(body);
      } catch (error) {
        return failure(error);
      }
    };
  }

  /** A change to an issue, run through the engine's operation; refused when the issue moved on since the page read it. */
  private write(change: (id: string, body: Json) => unknown, options: WriteOptions): Handler {
    return async (req) => {
      try {
        this.guard.checkHost(req);
        this.guard.checkToken(req);
        const body = await readJson(req);
        const id = req.params.id!;
        const issue = this.store.getIssue(id);
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
}
