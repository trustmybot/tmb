export type HandlerErrorCode = "invalid_input" | "not_found";

/** A refused request: the message says what was wrong and what is allowed. */
export class HandlerError extends Error {
  override name = "HandlerError";
  constructor(
    readonly code: HandlerErrorCode,
    message: string,
  ) {
    super(message);
  }
}
