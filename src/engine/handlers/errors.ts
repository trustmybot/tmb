/** invalid_input: the request is malformed. not_found: it names no record. refused: the record's state does not allow it. */
export type HandlerErrorCode = "invalid_input" | "not_found" | "refused";

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
