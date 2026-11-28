// The dashboard API's answers: JSON in, JSON out, and each error as a status and a code the page reads.
import { HandlerError } from "../engine/index.ts";
import { MAX_BODY_BYTES } from "./constants.ts";

export type Json = Record<string, unknown>;

/** A route's request, with the path parameters Bun matched. */
export type RouteRequest = Request & { params: Record<string, string> };

const HANDLER_STATUS = { invalid_input: 400, not_found: 404, refused: 409 } as const;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function fail(status: number, error: string, message: string, extra: Json = {}): Response {
  return json({ error, message, ...extra }, status);
}

/** The error as the page reads it; one the dashboard did not expect is logged and told as an internal error. */
export function failure(error: unknown): Response {
  if (error instanceof HttpError) return fail(error.status, error.code, error.message);
  if (error instanceof HandlerError) return fail(HANDLER_STATUS[error.code], error.code, error.message);
  console.error(`tmb dashboard: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return fail(500, "internal_error", "the dashboard hit an error; its terminal has the details");
}

export async function readJson(req: Request): Promise<Json> {
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
export function pick(body: Json, keys: readonly string[]): Json {
  return Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

/** A query parameter of the request's URL, or null. */
export function param(req: Request, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}
