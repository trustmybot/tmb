// The one place the syncer talks to the remote, through the user's own `gh`, as the engine's GitHub
// client does: tmb reads no token and holds no login. A poll only asks, with GET, so the reader
// cannot write; the one write is a change to a mirrored issue, sent apart from it.
import { execFile } from "node:child_process";

const GH_TIMEOUT_MS = 30_000;

export type Request = {
  host: string;
  /** A path under the API root, or a full URL the remote gave as the next page. */
  path: string;
  /** The tag kept from last time. With it the remote may answer "not modified". */
  tag?: string | null;
};

export type Answer =
  | { sent: true; status: number; headers: Record<string, string>; body: string }
  | { sent: false; why: "no_client" | "no_sign_in" | "no_network" | "failed"; said: string };

/** Asks the remote one thing. Tests pass their own, which answers from recordings. */
export type Ask = (request: Request) => Promise<Answer>;

export function ghArgs(request: Request): string[] {
  const args = ["api", "--include", "--hostname", request.host, "--method", "GET"];
  if (request.tag) args.push("-H", `If-None-Match: ${request.tag}`);
  args.push(request.path);
  return args;
}

export function askThroughGh(cwd: string): Ask {
  return (request) => runGh(cwd, ghArgs(request));
}

/** One change sent to the remote: the fields of one item, as JSON. */
export type Change = { host: string; path: string; method: "PATCH"; fields: Record<string, unknown> };

/** Sends one change to the remote. Tests pass their own, which answers from recordings. */
export type Send = (change: Change) => Promise<Answer>;

export function ghSendArgs(change: Change): string[] {
  return ["api", "--include", "--hostname", change.host, "--method", change.method, "--input", "-", change.path];
}

/** The fields go in on stdin as JSON, so no text is ever read as a flag, a file or a number. */
export function sendThroughGh(cwd: string): Send {
  return (change) => runGh(cwd, ghSendArgs(change), JSON.stringify(change.fields));
}

function runGh(cwd: string, args: string[], input?: string): Promise<Answer> {
  return new Promise((resolve) => {
    const child = execFile(
      "gh",
      args,
      { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (error, stdout, stderr) => {
        const code = error === null ? null : (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return resolve({ sent: false, why: "no_client", said: "gh is not installed" });
        if (error !== null && error.killed) return resolve({ sent: false, why: "no_network", said: "gh timed out" });
        resolve(readGhOutput(stdout, stderr));
      },
    );
    // A gh that is missing closes stdin at once; the answer comes from the callback either way.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

/**
 * Reads what `gh api --include` printed. gh exits non-zero for "not modified" and for every
 * refusal, but still prints the status line and headers, so the status is read from there.
 */
export function readGhOutput(stdout: string, stderr: string): Answer {
  const parsed = parseIncluded(stdout);
  if (parsed !== null) return { sent: true, ...parsed };
  const said = `${stderr}\n${stdout}`.replace(/\s+/g, " ").trim().slice(0, 500);
  if (/gh auth login|GH_TOKEN|authentication token|not logged in/i.test(said)) return { sent: false, why: "no_sign_in", said };
  if (/dial tcp|no such host|connection refused|connection reset|network is unreachable|i\/o timeout|timeout|TLS handshake|proxyconnect|error connecting|EOF$/i.test(said)) {
    return { sent: false, why: "no_network", said };
  }
  return { sent: false, why: "failed", said: said === "" ? "gh printed nothing" : said };
}

function parseIncluded(stdout: string): { status: number; headers: Record<string, string>; body: string } | null {
  const statusLine = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(stdout);
  if (statusLine === null) return null;
  const rest = stdout.slice(statusLine[0].length);
  // The headers end at the first blank line, which comes at once when there are none.
  const end = /^\r?\n|\r?\n\r?\n/.exec(rest);
  const head = end === null ? rest : rest.slice(0, end.index);
  const body = end === null ? "" : rest.slice(end.index + end[0].length);
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(statusLine[1]), headers, body };
}

/** The next page's address from a `link` header, or null on the last page. */
export function nextPage(headers: Record<string, string>): string | null {
  for (const part of (headers["link"] ?? "").split(",")) {
    const found = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (found !== null) return found[1]!;
  }
  return null;
}

/**
 * The time the remote asks the reader to wait until, or null when the answer is no rate limit.
 * GitHub's rule: `retry-after` seconds when given; else the reset time when nothing remains;
 * else at least one minute.
 */
export function waitAsked(answer: { status: number; headers: Record<string, string>; body: string }, now: Date): string | null {
  if (answer.status !== 403 && answer.status !== 429) return null;
  const retryAfter = Number(answer.headers["retry-after"]);
  if (answer.headers["retry-after"] !== undefined && Number.isFinite(retryAfter)) return new Date(now.getTime() + retryAfter * 1000).toISOString();
  if (answer.headers["x-ratelimit-remaining"] === "0") {
    const reset = Number(answer.headers["x-ratelimit-reset"]);
    if (Number.isFinite(reset) && reset > 0) return new Date(Math.max(reset * 1000, now.getTime())).toISOString();
    return new Date(now.getTime() + 60_000).toISOString();
  }
  if (answer.status === 429 || /rate limit/i.test(answer.body)) return new Date(now.getTime() + 60_000).toISOString();
  return null;
}
