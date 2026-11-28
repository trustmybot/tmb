// Reads of the code graph at the base branch, brought forward first as every graph read is. The page
// never sees a task's own changes. In a workspace, `repo` names whose graph; the page shows the list
// of repos first, so it always names one when there are several.
import { openView, type Store } from "../engine/index.ts";
import { CodeGraphView } from "./code-graph.ts";
import { fail, failure, type Json, json, param, type RouteRequest } from "./http.ts";
import type { RequestGuard } from "./request-guard.ts";

export class GraphReads {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly projectDir: string,
    private readonly store: Store,
    private readonly guard: RequestGuard,
  ) {}

  /** A route that answers with `handler`'s read of the graph, with the commit and base branch it was read at. */
  route(handler: (graph: CodeGraphView, req: RouteRequest) => unknown): (req: RouteRequest) => Promise<Response> {
    return async (req) => {
      // One graph read at a time: two that both find the base moved on would both rebuild it.
      const turn = this.queue;
      let done = () => {};
      this.queue = new Promise<void>((resolve) => (done = resolve));
      await turn;
      try {
        this.guard.checkHost(req);
        const repo = param(req, "repo") || undefined;
        const view = await openView(this.projectDir, this.store, { repo });
        try {
          const body = view.db.transaction(() => handler(new CodeGraphView(view.db, view.layer), req)).deferred();
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
}
