// Who a push is recorded as: the agent a push tmb runs names, or the Human (trustmybot/tmb#134).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { PUSH_ACTOR_ENV, pushActorEnv, pushActorFrom } from "../../../src/engine/push-actor.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

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
    expect(pushActorFrom({ [PUSH_ACTOR_ENV]: JSON.stringify({ kind: "agent", role: "Boss!", host: "x" }) })).toEqual({ kind: "human" });
    expect(pushActorFrom({ [PUSH_ACTOR_ENV]: JSON.stringify({ kind: "agent", role: "worker" }) })).toEqual({ kind: "human" });
    // Only tmb's own code writes as tmb; a hook that names it is refused (trustmybot/tmb#404).
    expect(pushActorFrom({ [PUSH_ACTOR_ENV]: JSON.stringify({ kind: "tmb", source: "syncer" }) })).toEqual({ kind: "human" });
  });
});
