// Who made a record: the Human, an agent named by its role and the host it ran on, or tmb itself,
// named by the part of tmb that wrote it, for a write no person or agent made (trustmybot/tmb#404).

export const ROLES = ["planner", "worker", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const ACTOR_KINDS = ["human", "agent", "tmb"] as const;

/** The parts of tmb that write as tmb: the syncer, for what it learned from the remote, and an upgrade of the record. */
export const TMB_SOURCES = ["syncer", "upgrade"] as const;
export type TmbSource = (typeof TMB_SOURCES)[number];

export type Actor = { kind: "human" } | { kind: "agent"; role: Role; host: string } | { kind: "tmb"; source: TmbSource };

export class ActorError extends Error {
  override name = "ActorError";
}

/**
 * Refuses an actor that arrives from outside the engine, from a tool call or a hook, when it is
 * missing or malformed. Such an actor is never tmb: only the engine's own code writes as tmb.
 */
export function assertActor(actor: unknown): asserts actor is Actor {
  if (actor !== null && typeof actor === "object" && (actor as Record<string, unknown>).kind === "tmb") {
    throw new ActorError("only tmb's own code writes as tmb");
  }
  assertWriter(actor);
}

/** Refuses a write whose actor is missing or malformed; the store's own check, which lets tmb write. */
export function assertWriter(actor: unknown): asserts actor is Actor {
  if (actor === undefined || actor === null) throw new ActorError("a write needs an actor: the Human, or a role and a host");
  if (typeof actor !== "object") throw new ActorError(`actor must be an object, got ${typeof actor}`);
  const { kind, role, host, source } = actor as Record<string, unknown>;
  if (!ACTOR_KINDS.includes(kind as (typeof ACTOR_KINDS)[number])) throw new ActorError(`actor kind must be one of ${ACTOR_KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
  if (kind !== "tmb" && source !== undefined && source !== null) throw new ActorError("only tmb carries a source");
  if (kind === "human") {
    if ((role !== undefined && role !== null) || (host !== undefined && host !== null)) throw new ActorError("the Human carries no role or host");
    return;
  }
  if (kind === "tmb") {
    if ((role !== undefined && role !== null) || (host !== undefined && host !== null)) throw new ActorError("tmb carries no role or host");
    if (!TMB_SOURCES.includes(source as TmbSource)) throw new ActorError(`tmb's source must be one of ${TMB_SOURCES.join(", ")}, got ${JSON.stringify(source)}`);
    return;
  }
  if (!ROLES.includes(role as Role)) throw new ActorError(`agent role must be one of ${ROLES.join(", ")}, got ${JSON.stringify(role)}`);
  if (typeof host !== "string" || host.trim() === "") throw new ActorError("an agent actor needs a host");
}

export type ActorColumns = { actor_kind: string; actor_role: string | null; actor_host: string | null; actor_source: string | null };

export function actorColumns(actor: Actor): ActorColumns {
  if (actor.kind === "human") return { actor_kind: "human", actor_role: null, actor_host: null, actor_source: null };
  if (actor.kind === "tmb") return { actor_kind: "tmb", actor_role: null, actor_host: null, actor_source: actor.source };
  return { actor_kind: "agent", actor_role: actor.role, actor_host: actor.host, actor_source: null };
}

export function actorFromColumns(columns: ActorColumns): Actor {
  if (columns.actor_kind === "human") return { kind: "human" };
  if (columns.actor_kind === "tmb") return { kind: "tmb", source: columns.actor_source as TmbSource };
  return { kind: "agent", role: columns.actor_role as Role, host: columns.actor_host ?? "" };
}
