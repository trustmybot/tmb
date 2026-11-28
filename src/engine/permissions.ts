// Who may take each action: one list of actions, each role's default actions, one check, default
// deny (docs/architecture/PERMISSIONS.md). A role is a name, not a closed list: the Human
// is the command line, an agent's role comes with its tool call, and a role the project created is
// a row in the record. A project's grants and revokes, kept in the record, change the defaults; a
// role that is neither shipped nor created gets only what every role may do. To add an action, add
// it to ACTIONS and to the roles that take it.
import { HandlerError } from "./handlers/errors.ts";
import { runningName } from "./program.ts";
import type { Actor } from "./store/index.ts";

/** Every action, by resource, with what it does in a few words for a message. */
export const ACTIONS = {
  "tmb.uninstall": "remove the tmb program from this machine",
  "project.remove": "remove tmb's wiring from this project, keeping its record",
  "project.purge": "remove tmb's wiring from this project and delete its record for good, so its trajectory cannot be recovered",
  "permissions.manage": "grant or revoke a role's actions",
  "role.create": "create a role, with its prompt and its actions",
  "role.delete": "delete a role the project created",
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

/** The Human's own steps: the command line runs each only on a terminal, after the Human types yes. */
const HUMAN_STEPS: readonly Action[] = [...FIXED_HUMAN_ACTIONS, "permissions.manage", "settings.review-mode", "feature.waive", "task.waive"];

/**
 * What the Human and the planner decide together, so both hold it: issues, feature branches,
 * settings, roles, feedback and the waivers. The Human takes these through the dashboard or by
 * asking the planner; holding one is not a command.
 */
const SHARED_WITH_PLANNER: readonly Action[] = [
  "issue.create",
  "issue.update",
  "issue.note",
  "feature.start",
  "feature.update",
  "feature.drop",
  "feature.pr",
  "feature.waive",
  "task.waive",
  "settings.set",
  "settings.review-mode",
  "role.create",
  "role.delete",
  "permissions.manage",
  "feedback.send",
];

/**
 * What runs between the planner and its agents: tasks, review verdicts and the code graph's
 * knowledge. The Human holds none of these, and none is granted to the Human: an edit there would
 * change work under an agent that does not know of it, so the Human asks the planner instead.
 */
const PLANNER_AND_AGENTS: readonly Action[] = ["task.start", "task.close", "task.drop", "task.pr", "graph.write"];

/** The actions tmb gives each role it ships, on top of what every role may do. */
export const DEFAULT_ROLES: Readonly<Record<RoleName, readonly Action[]>> = {
  [HUMAN_ROLE]: [...FIXED_HUMAN_ACTIONS, ...SHARED_WITH_PLANNER],
  // The planner closes any task, as a recovery: the close records its reason as a note on the task's issue.
  planner: [...SHARED_WITH_PLANNER, ...PLANNER_AND_AGENTS],
  worker: ["task.close"],
  reviewer: ["review.record"],
};

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
  return new Set([...EVERY_ROLE, ...own]);
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

/** True for a well-formed role name: lowercase letters, digits and -, starting with a letter. */
export function isRoleName(name: string): boolean {
  return ROLE_NAME.test(name);
}

/** True for a role tmb ships: the Human, planner, worker or reviewer. */
export function isShippedRole(role: RoleName): boolean {
  return Object.hasOwn(DEFAULT_ROLES, role);
}

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

/**
 * Why an agent may not make this grant, or null when it may. No agent grants an action to its own
 * role, and none grants an action its own role does not hold, so no agent raises its own reach,
 * even through a role it created: the Human does that with the command line.
 */
export function agentGrantRefusal(actor: Actor, role: RoleName, action: Action, changes: readonly RoleActionChange[]): string | null {
  const own = roleOf(actor);
  if (actor.kind !== "agent" || own === null) return null;
  if (own === role) return `an agent does not grant actions to its own role; the Human grants ${action} to the ${role} with \`${runningName()} role grant ${role} ${action}\``;
  if (!effectiveActions(own, changes).has(action)) return `the ${own} does not hold ${action}, so it does not grant it; the Human grants it with \`${runningName()} role grant ${role} ${action}\``;
  return null;
}

/** True for one of the Human's steps the command line runs only on a terminal after a typed yes. */
export function isHumanStep(action: Action): boolean {
  return HUMAN_STEPS.includes(action);
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
