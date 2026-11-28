// The dashboard server's fixed values, in one place.

export const DEFAULT_PORT = 7477;
/** The loopback address: the dashboard never listens on another. */
export const HOST = "127.0.0.1";
/** The host names the API answers to, besides the address itself. */
export const LOCAL_HOST_NAME = "localhost";
/** The header a change carries the page's token in. */
export const TOKEN_HEADER = "x-tmb-token";
/** The token's size in random bytes. */
export const TOKEN_BYTES = 32;
export const MAX_BODY_BYTES = 1024 * 1024;
/** How long the read-only connection waits on a writer's lock before it gives up. */
export const BUSY_TIMEOUT_MS = 5000;
/** The dashboard asks GitHub about each open pull request at most this often (trustmybot/tmb#131). */
export const PULL_REQUEST_READ_INTERVAL_MS = 60_000;
