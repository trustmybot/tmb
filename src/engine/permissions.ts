// Who may take each action: one list of actions, each role's default actions, one check, default
// deny (docs/architecture/ROLES.md, "Permissions"). A role is a name, not a closed list: the Human
// is the command line, an agent's role comes with its tool call, and a role tmb does not ship gets
// only what every role may do. A project's grants and revokes, kept in the record, change the
// defaults. To add an action, add it to ACTIONS and to the roles that take it.
import { HandlerError } from "./handlers/errors.ts";
import type { Actor } from "./store/index.ts";

/** Every action, by resource, with what it does in a few words for a message. */
export const ACTIONS = {
  "tmb.uninstall": "remove the tmb program from this machine",
  "project.remove": "remove tmb's wiring from this project, keeping its record",
  "project.purge": "remove tmb's wiring from this project and delete its record for good, so its trajectory cannot be recovered",
  "permissions.manage": "grant or revoke a role's actions",
  "settings.review-mode": "set the review mode",
  "settings.set": "set the project's other settings",
  "issue.create": "record an issue",
  "issue.update": "change an issue",
  "issue.note": "add a note to an issue",
  "feature.start": "start a feature branch",
  "feature.update": "bring the base branch into a feature branch",
  "feature.drop": "drop a feature branch",
  "feature.pr": "open a feature branch's pull request",
  "feature.waive": "waive a feature branch's review",
  "task.start": "start a task",
  "task.close": "close a task",
  "task.drop": "drop a task",
  "task.pr": "open a task's pull request",
  "task.waive": "waive a task's review",
  "review.record": "record a review verdict",
  "graph.write": "record concepts and areas in the code graph",
  "feedback.send": "draft and send feedback to tmb",
  "record.read": "read the record",
  "graph.read": "read the code graph",
} as const;

export type Action = keyof typeof ACTIONS;

/** A role's name: one tmb ships (the Human, planner, worker, reviewer) or one a project adds. */
export type RoleName = string;

/** The Human: the caller the command line records. */
export const HUMAN_ROLE = "human";

/** What every role may do, a role with no row included. */
export const EVERY_ROLE: readonly Action[] = ["record.read", "graph.read"];

/**
 * The command-line steps with no tool: the Human's alone, and no role may be granted one.
 */
export const FIXED_HUMAN_ACTIONS: readonly Action[] = ["tmb.uninstall", "project.remove", "project.purge"];

/** The actions tmb gives each role it ships, on top of what every role may do. */
export const DEFAULT_ROLES: Readonly<Record<RoleName, readonly Action[]>> = {
  [HUMAN_ROLE]: [...FIXED_HUMAN_ACTIONS, "permissions.manage", "settings.review-mode", "feature.waive", "task.waive"],
  planner: [
    "settings.review-mode",
    "feature.waive",
    "task.waive",
    "settings.set",
    "issue.create",
    "issue.update",
    "issue.note",
    "feature.start",
    "feature.update",
    "feature.drop",
    "feature.pr",
    "task.start",
    "task.drop",
    "task.pr",
    "graph.write",
    "feedback.send",
    // A docs task, which the planner writes and closes itself.
    "task.close",
  ],
  worker: ["task.close"],
  reviewer: ["review.record"],
};

/**
 * Record actions the command line still runs for the Human outside the Human's defaults, as it did
 * before the table. Each stays until it is decided whether the Human keeps it.
 */
const COMMAND_LINE_CARRY_OVER: readonly Action[] = [
  "issue.create",
  "issue.update",
  "issue.note",
  "feature.start",
  "feature.update",
  "feature.drop",
  "feature.pr",
  "task.start",
  "task.close",
  "task.drop",
  "task.pr",
];

export function isAction(name: string): name is Action {
  return Object.hasOwn(ACTIONS, name);
}

/** The role an actor acts in, or null for tmb itself, which takes no action. */
export function roleOf(actor: Actor): RoleName | null {
  if (actor.kind === "human") return HUMAN_ROLE;
  return actor.kind === "agent" ? actor.role : null;
}

/** The actions `role` may take by default: tmb's defaults for a role it ships, plus what every role may do. */
export function defaultActions(role: RoleName): ReadonlySet<Action> {
  const own = Object.hasOwn(DEFAULT_ROLES, role) ? DEFAULT_ROLES[role]! : [];
  const carried = role === HUMAN_ROLE ? COMMAND_LINE_CARRY_OVER : [];
  return new Set([...EVERY_ROLE, ...own, ...carried]);
}

/** A project's grant or revoke of one action for one role, oldest first in a list. */
export type RoleActionChange = { role: RoleName; action: string; change: "grant" | "revoke" };

/** The actions `role` may take in a project: its defaults, plus its grants, minus its revokes; the newest change to an action wins. */
export function effectiveActions(role: RoleName, changes: readonly RoleActionChange[]): ReadonlySet<Action> {
  const actions = new Set(defaultActions(role));
  for (const { role: changed, action, change } of changes) {
    if (changed !== role || !isAction(action)) continue;
    if (change === "grant") actions.add(action);
    else actions.delete(action);
  }
  return actions;
}

/** True when `actor` may take `action` in a project with these `changes`; tmb itself takes none, and an action not in the list is denied. */
export function mayTake(actor: Actor, action: string, changes: readonly RoleActionChange[] = []): boolean {
  const role = roleOf(actor);
  if (role === null || !isAction(action)) return false;
  return effectiveActions(role, changes).has(action);
}

const ROLE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Why a project may not grant or revoke `action` for `role`, or null when it may. The Human's
 * fixed steps are never granted, what every role may do is never revoked, and the Human's own
 * actions are not changed.
 */
export function roleChangeRefusal(role: string, action: string, change: RoleActionChange["change"]): string | null {
  if (!ROLE_NAME.test(role)) return `a role is named in lowercase letters, digits and -, got ${JSON.stringify(role)}`;
  if (!isAction(action)) return `${JSON.stringify(action)} is no action; the actions are ${Object.keys(ACTIONS).join(", ")}`;
  if (role === HUMAN_ROLE) return "the Human's own actions are not granted or revoked";
  if ((FIXED_HUMAN_ACTIONS as readonly string[]).includes(action)) return `${action} is the Human's alone (to ${ACTIONS[action]}), so no role is granted it`;
  if (change === "revoke" && (EVERY_ROLE as readonly string[]).includes(action)) return `${action} is what every role may do, so it is not revoked`;
  return null;
}

/** True for one of the Human's steps the command line runs only on a terminal after a typed yes. */
export function isHumanStep(action: Action): boolean {
  return DEFAULT_ROLES[HUMAN_ROLE]!.includes(action);
}

function named(role: RoleName): string {
  return role === HUMAN_ROLE ? "the Human" : `the ${role}`;
}

/** Refuses `actor` unless its role may take `action` in a project with these `changes`. */
export function requirePermission(actor: Actor, action: Action, changes: readonly RoleActionChange[] = []): void {
  if (mayTake(actor, action, changes)) return;
  const role = roleOf(actor);
  throw new HandlerError("refused", `${role === null ? "tmb" : named(role)} may not ${ACTIONS[action]} (${action})`);
}
