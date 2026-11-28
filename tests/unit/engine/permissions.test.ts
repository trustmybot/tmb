// One permission table, one check, default deny (docs/architecture/ROLES.md, "Permissions").
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { ACTIONS, DEFAULT_ROLES, FIXED_HUMAN_ACTIONS, HandlerError, mayTake, requirePermission } from "../../../src/engine/index.ts";
import { settingsSetActions } from "../../../src/engine/handlers/settings.ts";
import type { Actor } from "../../../src/engine/store/index.ts";

setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const agent = (role: string): Actor => ({ kind: "agent", role, host: "host-a" }) as Actor;

describe("the permission table", () => {
  test("every role may read the record and the code graph, a role tmb does not ship included", () => {
    for (const role of ["planner", "worker", "reviewer", "designer"]) {
      expect(mayTake(agent(role), "record.read")).toBe(true);
      expect(mayTake(agent(role), "graph.read")).toBe(true);
    }
    expect(mayTake(agent("designer"), "task.close")).toBe(false);
  });

  test("each shipped role takes its defaults and nothing more", () => {
    expect(mayTake(agent("worker"), "task.close")).toBe(true);
    expect(mayTake(agent("worker"), "task.start")).toBe(false);
    expect(mayTake(agent("reviewer"), "review.record")).toBe(true);
    expect(mayTake(agent("reviewer"), "task.waive")).toBe(false);
    expect(mayTake(agent("planner"), "task.waive")).toBe(true);
    expect(mayTake(agent("planner"), "settings.review-mode")).toBe(true);
    expect(mayTake(agent("planner"), "review.record")).toBe(false);
  });

  test("the fixed steps are the Human's alone; tmb itself and an unknown action are denied", () => {
    for (const action of FIXED_HUMAN_ACTIONS) {
      expect(mayTake(HUMAN, action)).toBe(true);
      for (const role of Object.keys(DEFAULT_ROLES).filter((role) => role !== "human")) expect(mayTake(agent(role), action)).toBe(false);
    }
    expect(mayTake({ kind: "tmb", source: "syncer" } as Actor, "record.read")).toBe(false);
    expect(mayTake(HUMAN, "task.anything")).toBe(false);
  });

  test("the command line keeps the Human's record commands", () => {
    for (const action of ["issue.create", "feature.start", "task.start", "task.close", "task.drop"] as const) expect(mayTake(HUMAN, action)).toBe(true);
    expect(mayTake(HUMAN, "review.record")).toBe(false);
  });

  test("a refusal names the role, what it may not do and the action", () => {
    try {
      requirePermission(agent("worker"), "task.waive");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(HandlerError);
      expect((error as HandlerError).message).toBe(`the worker may not ${ACTIONS["task.waive"]} (task.waive)`);
    }
  });

  test("settings_set asks for the review mode only when it sets one, in the project or a repo", () => {
    expect(settingsSetActions({ base_branch: "main" })).toEqual(["settings.set"]);
    expect(settingsSetActions({ review_mode: "agile" })).toEqual(["settings.review-mode"]);
    expect(new Set(settingsSetActions({ repos: { a: { base_branch: "dev", review_mode: "truest" } } }))).toEqual(new Set(["settings.set", "settings.review-mode"]));
  });
});
