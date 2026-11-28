// Each role's actions in this project, the roles the project creates, and the grants and revokes
// of their actions (docs/architecture/PERMISSIONS.md). A change is a row in the record
// naming who made it.
import { MAIN_AGENT, UNNAMED_AGENT } from "../decide.ts";
import { ACTIONS, type Action, agentGrantRefusal, DEFAULT_ROLES, defaultActions, effectiveActions, EVERY_ROLE, isAction, isRoleName, isShippedRole, roleChangeRefusal } from "../permissions.ts";
import type { Actor, ProjectRole, RoleChange, Store } from "../store/index.ts";
import type { OperationContext } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { type InputSchema, validateInput } from "./input.ts";

/** One role's actions: what it may take now, which of them differ from tmb's defaults, and what a created role is for. */
export type RoleView = { role: string; purpose: string | null; actions: Action[]; granted: Action[]; revoked: Action[] };

/**
 * Names no created role takes: the roles tmb ships, the planner's other name, and the names the
 * engine gives the host's main agent and an agent its host does not name.
 */
const EVERY_ROLE_SET: ReadonlySet<string> = new Set(EVERY_ROLE);

const RESERVED_NAMES: readonly string[] = [...Object.keys(DEFAULT_ROLES), "bro", MAIN_AGENT, UNNAMED_AGENT];

function createdRole(store: Store, name: string): ProjectRole | null {
  return store.listRoles().find((role) => role.name === name) ?? null;
}

/** True for a role tmb ships or one the project created and has not deleted. */
function isKnownRole(store: Store, role: string): boolean {
  return isShippedRole(role) || createdRole(store, role) !== null;
}

/**
 * The grants and revokes in force: those of the roles tmb ships and of the roles the project
 * created. Any other role holds only what every role may do.
 */
export function changesInForce(store: Store): RoleChange[] {
  const known = new Set([...Object.keys(DEFAULT_ROLES), ...store.listRoles().map((role) => role.name)]);
  return store.listRoleChanges().filter((change) => known.has(change.role));
}

export const roleListSchema: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

/** Every role tmb ships and every role the project created, each with its actions now. */
export function roleList(store: Store, _actor: Actor, input: unknown, _context?: OperationContext): RoleView[] {
  validateInput("role_list", roleListSchema, input);
  const changes = changesInForce(store);
  return [...Object.keys(DEFAULT_ROLES), ...store.listRoles().map((role) => role.name)].map((role) => viewOf(store, role, changes));
}

function viewOf(store: Store, role: string, changes: readonly RoleChange[]): RoleView {
  const defaults = defaultActions(role);
  const now = effectiveActions(role, changes);
  const order = (Object.keys(ACTIONS) as Action[]).filter((action) => now.has(action) || defaults.has(action));
  return {
    role,
    purpose: createdRole(store, role)?.purpose ?? null,
    actions: order.filter((action) => now.has(action)),
    granted: order.filter((action) => now.has(action) && !defaults.has(action)),
    revoked: order.filter((action) => !now.has(action) && defaults.has(action)),
  };
}

/** Refuses a grant or revoke the project may not make, or that `actor` may not make. */
function refuseChange(store: Store, actor: Actor, role: string, action: string, change: "grant" | "revoke", changes: readonly RoleChange[]): void {
  const refusal = roleChangeRefusal(role, action, change);
  if (refusal !== null) throw new HandlerError("refused", refusal);
  if (!isKnownRole(store, role)) throw new HandlerError("refused", `there is no role ${role}; create it first with role_create`);
  const agent = change === "grant" ? agentGrantRefusal(actor, role, action as Action, changes) : null;
  if (agent !== null) throw new HandlerError("refused", agent);
}

export const roleChangeSchema: InputSchema = {
  type: "object",
  properties: {
    for_role: { type: "string", description: "The role whose actions change, as worker or a role the project created." },
    action: { type: "string", description: "The action, as task.drop." },
    change: { type: "string", enum: ["grant", "revoke"], description: "grant adds the action to the role; revoke takes it away." },
  },
  required: ["for_role", "action", "change"],
  additionalProperties: false,
};

export type RoleChangeResult = { id: string; changed: boolean; role: RoleView };

/** Grants or revokes one action for one role, recording who did it; a change that changes nothing records nothing. */
export function roleChange(store: Store, actor: Actor, input: unknown, _context?: OperationContext): RoleChangeResult {
  const given = validateInput<{ for_role: string; action: string; change: "grant" | "revoke" }>("role_change", roleChangeSchema, input);
  const changes = changesInForce(store);
  refuseChange(store, actor, given.for_role, given.action, given.change, changes);
  const holds = effectiveActions(given.for_role, changes).has(given.action as Action);
  if (isAction(given.action) && holds === (given.change === "grant")) {
    return { id: "", changed: false, role: viewOf(store, given.for_role, changes) };
  }
  const id = store.recordRoleChange(actor, { role: given.for_role, action: given.action, change: given.change });
  return { id, changed: true, role: viewOf(store, given.for_role, changesInForce(store)) };
}

export const roleCreateSchema: InputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "The new role's name, in lowercase letters, digits and -, as designer. It is also its agent's name." },
    purpose: { type: "string", description: "What the role is for and when to start its agent, in one line." },
    prompt: { type: "string", description: "The role's prompt: who it is, what it does, its boundaries and how it reports." },
    actions: {
      type: "array",
      items: { type: "string" },
      description: "The actions the role may take beyond reading the record and the code graph, as task.close. Leave it empty for a role that only reads.",
    },
  },
  required: ["name", "purpose", "prompt", "actions"],
  additionalProperties: false,
};

export type RoleCreateResult = { id: string; role: RoleView };

/** Records a new role with its prompt, and grants it its actions, all at once; the record names who created it. */
export function roleCreate(store: Store, actor: Actor, input: unknown, _context?: OperationContext): RoleCreateResult {
  const given = validateInput<{ name: string; purpose: string; prompt: string; actions: string[] }>("role_create", roleCreateSchema, input);
  const { name } = given;
  if (!isRoleName(name)) throw new HandlerError("refused", `a role is named in lowercase letters, digits and -, got ${JSON.stringify(name)}`);
  if (RESERVED_NAMES.includes(name)) throw new HandlerError("refused", `${name} is a name tmb keeps for its own roles; pick another`);
  if (given.purpose.trim() === "") throw new HandlerError("invalid_input", "role_create needs the role's purpose");
  if (given.prompt.trim() === "") throw new HandlerError("invalid_input", "role_create needs the role's prompt");
  const actions = [...new Set(given.actions)];
  return store.transaction(() => {
    if (createdRole(store, name) !== null) throw new HandlerError("refused", `the role ${name} already exists; change its actions with role_change, or delete it with role_delete first`);
    const id = store.createRole(actor, { name, purpose: given.purpose.trim(), prompt: given.prompt });
    const changes = changesInForce(store);
    for (const action of actions) refuseChange(store, actor, name, action, "grant", changes);
    for (const action of actions.filter((action) => !EVERY_ROLE_SET.has(action))) store.recordRoleChange(actor, { role: name, action, change: "grant" });
    return { id, role: viewOf(store, name, changesInForce(store)) };
  });
}

export const roleDeleteSchema: InputSchema = {
  type: "object",
  properties: { name: { type: "string", description: "The name of a role the project created." } },
  required: ["name"],
  additionalProperties: false,
};

export type RoleDeleteResult = { id: string; name: string; revoked: Action[] };

/** Deletes a role the project created, and revokes every action it was granted, so a role made later under its name starts with none. */
export function roleDelete(store: Store, actor: Actor, input: unknown, _context?: OperationContext): RoleDeleteResult {
  const { name } = validateInput<{ name: string }>("role_delete", roleDeleteSchema, input);
  if (isShippedRole(name)) throw new HandlerError("refused", `${name} is a role tmb ships, so it is not deleted`);
  return store.transaction(() => {
    const role = createdRole(store, name);
    if (role === null) throw new HandlerError("not_found", `there is no role ${name} the project created`);
    const granted = [...effectiveActions(name, changesInForce(store))].filter((action) => !EVERY_ROLE_SET.has(action));
    for (const action of granted) store.recordRoleChange(actor, { role: name, action, change: "revoke" });
    store.deleteRole(actor, role.id);
    return { id: role.id, name, revoked: granted };
  });
}
