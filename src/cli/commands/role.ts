// `tmb role`: list each role's actions in this project, and grant or revoke one.
import type { RoleChangeResult, RoleView } from "../../engine/index.ts";
import { parseWithJson } from "../arguments.ts";
import { listed, UsageError } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest } from "./record.ts";

/** One role's line: its actions, a granted one marked +, a revoked one listed after a -. */
function roleLine(view: RoleView): string {
  const actions = view.actions.map((action) => (view.granted.includes(action) ? `+${action}` : action));
  const revoked = view.revoked.map((action) => `-${action}`);
  const changed = view.granted.length + view.revoked.length > 0 ? "  (changed)" : "";
  return `${view.role}${changed}\n  ${[...actions, ...revoked].join(" ")}`;
}

export class RoleCommand extends RecordCommand {
  readonly name = "role";
  readonly summary = "List, grant and revoke each role's actions";
  readonly listing = listed("Project");
  override readonly actions = ["list", "grant", "revoke"] as const;

  usage(): string {
    return `  tmb role list             List each role's actions in this project; a role the project
                            changed is marked, a granted action with + and a revoked one with -
  tmb role grant <role> <action>
                            Let a role take an action (the Human only, on a terminal)
  tmb role revoke <role> <action>
                            Take an action away from a role (the Human only, on a terminal)
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const [action, ...rest] = args;
    switch (action) {
      case "list": {
        const { values, positionals } = parseWithJson(rest, {});
        if (positionals.length > 0) throw new UsageError("role list takes no arguments");
        return { operation: "role_list", input: {}, json: values.json === true, format: (views: RoleView[]) => views.map(roleLine).join("\n") };
      }
      case "grant":
      case "revoke": {
        const { values, positionals } = parseWithJson(rest, {});
        const [role, name, ...extra] = positionals;
        if (role === undefined || name === undefined || extra.length > 0) throw new UsageError(`role ${action} needs a role and one action`);
        const format = (result: RoleChangeResult) =>
          result.changed
            ? `${action === "grant" ? "Granted" : "Revoked"} ${name} ${action === "grant" ? "to" : "from"} ${role}.\n${roleLine(result.role)}`
            : `${role} ${action === "grant" ? "already holds" : "does not hold"} ${name}; nothing was recorded.\n${roleLine(result.role)}`;
        return { operation: "role_change", input: { for_role: role, action: name, change: action }, json: values.json === true, format };
      }
      default:
        throw this.actionError(action);
    }
  }
}
