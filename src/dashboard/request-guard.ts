// Who may use the API: only a page on this server's own address, and for a change only the page
// that was given this server's token.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { HOST, LOCAL_HOST_NAME, TOKEN_BYTES, TOKEN_HEADER } from "./constants.ts";
import { HttpError } from "./http.ts";

export class RequestGuard {
  /** The token the page reads once and sends with each change. */
  readonly token = randomBytes(TOKEN_BYTES).toString("hex");
  private allowedHosts: ReadonlySet<string> = new Set();

  /** Answers on the port the server got, by address or by local host name. */
  listenOn(port: number): void {
    this.allowedHosts = new Set([`${HOST}:${port}`, `${LOCAL_HOST_NAME}:${port}`]);
  }

  /** Refuses a request whose Host is not this server's own, so a page on another site cannot reach the API through DNS rebinding. */
  checkHost(req: Request): void {
    if (!this.allowedHosts.has((req.headers.get("host") ?? "").toLowerCase())) throw new HttpError(403, "forbidden_host", "the dashboard answers only on its own address");
  }

  checkToken(req: Request): void {
    const given = Buffer.from(req.headers.get(TOKEN_HEADER) ?? "");
    const expected = Buffer.from(this.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(403, "forbidden", "a change needs the token this dashboard page was given");
    }
  }
}
