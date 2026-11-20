// Who a push is for. git's pre-push hook runs with no agent identity, so a push tmb makes on an
// agent's behalf (a task close's backup, a pull request's push) names that agent in the
// environment git passes on to the hook, and the push gate records the push as the agent's.
// A push with nothing named, one the Human types, stays the Human's (trustmybot/tmb#134).
import { type Actor, assertActor } from "./store/actor.ts";

export const PUSH_ACTOR_ENV = "TMB_PUSH_ACTOR";

const HUMAN: Actor = { kind: "human" };

/** The environment that names `actor` to the pre-push hook of a push tmb runs. */
export function pushActorEnv(actor: Actor): Record<string, string> {
  return { [PUSH_ACTOR_ENV]: JSON.stringify(actor) };
}

/** The actor a push names in `env`; the Human when it names none, or one that is not well formed. */
export function pushActorFrom(env: Record<string, string | undefined>): Actor {
  const named = env[PUSH_ACTOR_ENV];
  if (named === undefined || named === "") return HUMAN;
  try {
    const actor: unknown = JSON.parse(named);
    assertActor(actor);
    return actor;
  } catch {
    return HUMAN;
  }
}
