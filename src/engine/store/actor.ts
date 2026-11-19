// Who made a record: the Human, or an agent named by its role and the host it ran on.

export const ROLES = ["planner", "worker", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export type Actor = { kind: "human" } | { kind: "agent"; role: Role; host: string };

export class ActorError extends Error {
  override name = "ActorError";
}

/** Refuses a write whose actor is missing or malformed; actors arrive from outside the engine. */
export function assertActor(actor: unknown): asserts actor is Actor {
  if (actor === undefined || actor === null) throw new ActorError("a write needs an actor: the Human, or a role and a host");
  if (typeof actor !== "object") throw new ActorError(`actor must be an object, got ${typeof actor}`);
  const { kind, role, host } = actor as Record<string, unknown>;
  if (kind === "human") {
    if ((role !== undefined && role !== null) || (host !== undefined && host !== null)) throw new ActorError("the Human carries no role or host");
    return;
  }
  if (kind !== "agent") throw new ActorError(`actor kind must be human or agent, got ${JSON.stringify(kind)}`);
  if (!ROLES.includes(role as Role)) throw new ActorError(`agent role must be one of ${ROLES.join(", ")}, got ${JSON.stringify(role)}`);
  if (typeof host !== "string" || host.trim() === "") throw new ActorError("an agent actor needs a host");
}

export type ActorColumns = { actor_kind: string; actor_role: string | null; actor_host: string | null };

export function actorColumns(actor: Actor): ActorColumns {
  return actor.kind === "human"
    ? { actor_kind: "human", actor_role: null, actor_host: null }
    : { actor_kind: "agent", actor_role: actor.role, actor_host: actor.host };
}

export function actorFromColumns(columns: ActorColumns): Actor {
  return columns.actor_kind === "human"
    ? { kind: "human" }
    : { kind: "agent", role: columns.actor_role as Role, host: columns.actor_host ?? "" };
}
