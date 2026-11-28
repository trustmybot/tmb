// The lists of values the record's columns take. The schema checks only shape, so these lists are
// checked by the engine on each write, and a new kind, role or state is a code change, never a
// reshaped table (trustmybot/tmb#404). docs/contributing/ENUMS.md lists every one.

export const ISSUE_STATES = ["open", "closed"] as const;
/** A note and a decision are local; a comment is mirrored from the remote. */
export const DISCUSSION_KINDS = ["note", "decision", "comment"] as const;
/** A milestone on the remote is open or closed. */
export const MILESTONE_STATES = ["open", "closed"] as const;
/** A pull request on the remote: open, merged, or closed without a merge. */
export const PULL_REQUEST_STATES = ["open", "merged", "closed"] as const;
export const REVIEW_TARGET_KINDS = ["commit", "branch"] as const;
export const GUARD_DECISIONS = ["allow", "deny"] as const;
/** What a review mark is for, and what the remote is told (trustmybot/tmb#408). */
export const MARK_KINDS = ["pass", "fail", "waiver"] as const;
export const MARK_STATES = ["success", "failure"] as const;
/** What a project did to one of a role's actions. */
export const ROLE_CHANGE_KINDS = ["grant", "revoke"] as const;
/** Whether a role the project created is in use or was deleted. */
export const ROLE_STATES = ["active", "deleted"] as const;

export class ValueError extends Error {
  override name = "ValueError";
}

/** Refuses a value that is not on its list; `what` names the column for the message. */
export function assertOneOf(what: string, list: readonly string[], value: unknown): void {
  if (typeof value !== "string" || !list.includes(value)) throw new ValueError(`${what} must be one of ${list.join(", ")}, got ${JSON.stringify(value)}`);
}
