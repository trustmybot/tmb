// Who a push is recorded as: the agent a push tmb runs names, or the Human (trustmybot/tmb#134).
import { describe, expect, test } from "bun:test";
import { PUSH_ACTOR_ENV, pushActorEnv, pushActorFrom } from "../src/engine/push-actor.ts";

describe("the push's actor", () => {
  test("a push tmb runs for an agent names it, and the hook reads it back", () => {
    const worker = { kind: "agent", role: "worker", host: "claude-code" } as const;
    expect(pushActorFrom(pushActorEnv(worker))).toEqual(worker);
    expect(pushActorFrom(pushActorEnv({ kind: "human" }))).toEqual({ kind: "human" });
  });

  test("a push that names nothing, or something malformed, is the Human's", () => {
    expect(pushActorFrom({})).toEqual({ kind: "human" });
    expect(pushActorFrom({ [PUSH_ACTOR_ENV]: "" })).toEqual({ kind: "human" });
    expect(pushActorFrom({ [PUSH_ACTOR_ENV]: "not json" })).toEqual({ kind: "human" });
    expect(pushActorFrom({ [PUSH_ACTOR_ENV]: JSON.stringify({ kind: "agent", role: "boss", host: "x" }) })).toEqual({ kind: "human" });
    expect(pushActorFrom({ [PUSH_ACTOR_ENV]: JSON.stringify({ kind: "agent", role: "worker" }) })).toEqual({ kind: "human" });
  });
});
