// The lists of values the record's columns take. The schema checks only shape, so these lists are
// checked by the engine on each write, and a new kind, role or state is a code change, never a
// reshaped table (trustmybot/tmb#404). docs/contributing/ENUMS.md lists every one.

export const ISSUE_STATES = ["open", "closed"] as const;
export const DISCUSSION_KINDS = ["note", "decision"] as const;
export const REVIEW_TARGET_KINDS = ["commit", "branch"] as const;
export const GUARD_DECISIONS = ["allow", "deny"] as const;
/** What a review mark is for, and what the remote is told (trustmybot/tmb#408). */
export const MARK_KINDS = ["pass", "fail", "waiver"] as const;
export const MARK_STATES = ["success", "failure"] as const;
/** What a project did to one of a role's actions. */
export const ROLE_CHANGE_KINDS = ["grant", "revoke"] as const;

export class ValueError extends Error {
  override name = "ValueError";
}

/** Refuses a value that is not on its list; `what` names the column for the message. */
export function assertOneOf(what: string, list: readonly string[], value: unknown): void {
  if (typeof value !== "string" || !list.includes(value)) throw new ValueError(`${what} must be one of ${list.join(", ")}, got ${JSON.stringify(value)}`);
}
