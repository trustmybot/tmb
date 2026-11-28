// Each role's actions in this project, and the Human's grants and revokes of them
// (docs/architecture/ROLES.md, "Permissions"). A change is a row in the record naming who made it.
import { ACTIONS, type Action, DEFAULT_ROLES, defaultActions, effectiveActions, isAction, roleChangeRefusal } from "../permissions.ts";
import type { Actor, RoleChange, Store } from "../store/index.ts";
import type { OperationContext } from "./common.ts";
import { HandlerError } from "./errors.ts";
import { type InputSchema, validateInput } from "./input.ts";

/** One role's actions: what it may take now, and which of them differ from tmb's defaults. */
export type RoleView = { role: string; actions: Action[]; granted: Action[]; revoked: Action[] };

export const roleListSchema: InputSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

/** Every role tmb ships and every role the project changed, each with its actions now. */
export function roleList(store: Store, _actor: Actor, input: unknown, _context?: OperationContext): RoleView[] {
  validateInput("role_list", roleListSchema, input);
  const changes = store.listRoleChanges();
  const roles = [...new Set([...Object.keys(DEFAULT_ROLES), ...changes.map((change) => change.role)])];
  return roles.map((role) => viewOf(role, changes));
}

function viewOf(role: string, changes: readonly RoleChange[]): RoleView {
  const defaults = defaultActions(role);
  const now = effectiveActions(role, changes);
  const order = (Object.keys(ACTIONS) as Action[]).filter((action) => now.has(action) || defaults.has(action));
  return {
    role,
    actions: order.filter((action) => now.has(action)),
    granted: order.filter((action) => now.has(action) && !defaults.has(action)),
    revoked: order.filter((action) => !now.has(action) && defaults.has(action)),
  };
}

export const roleChangeSchema: InputSchema = {
  type: "object",
  properties: {
    for_role: { type: "string", description: "The role whose actions change, as worker or a role the project added." },
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
  const refusal = roleChangeRefusal(given.for_role, given.action, given.change);
  if (refusal !== null) throw new HandlerError("refused", refusal);
  const changes = store.listRoleChanges();
  const holds = effectiveActions(given.for_role, changes).has(given.action as Action);
  if (isAction(given.action) && holds === (given.change === "grant")) {
    return { id: "", changed: false, role: viewOf(given.for_role, changes) };
  }
  const id = store.recordRoleChange(actor, { role: given.for_role, action: given.action, change: given.change });
  return { id, changed: true, role: viewOf(given.for_role, store.listRoleChanges()) };
}
