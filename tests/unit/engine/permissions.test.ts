// One permission table, one check, default deny (docs/architecture/ROLES.md, "Permissions").
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACTIONS, DEFAULT_ROLES, FIXED_HUMAN_ACTIONS, HandlerError, mayTake, OPERATIONS, openProjectStore, requirePermission } from "../../../src/engine/index.ts";
import { settingsSetActions } from "../../../src/engine/handlers/settings.ts";
import type { Actor, Store } from "../../../src/engine/store/index.ts";

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

describe("a project's grants and revokes", () => {
  let scratch: string;
  let store: Store;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "tmb-roles-"));
    const opened = openProjectStore(scratch, { create: true });
    if (!opened.ok) throw opened.error;
    store = opened.store;
  });
  afterEach(() => {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const context = () => ({ projectDir: scratch });
  const refusal = (call: () => unknown): HandlerError => {
    try {
      call();
    } catch (error) {
      if (error instanceof HandlerError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  test("the Human grants the worker task.drop: the worker may drop, the record names the Human, and the list marks it", () => {
    const result = OPERATIONS.role_change.run(store, HUMAN, { for_role: "worker", action: "task.drop", change: "grant" }, context());
    expect(result).toMatchObject({ changed: true, role: { role: "worker", granted: ["task.drop"], revoked: [] } });
    expect(store.listRoleChanges()).toMatchObject([{ role: "worker", action: "task.drop", change: "grant", createdBy: HUMAN }]);
    expect(mayTake(agent("worker"), "task.drop", store.listRoleChanges())).toBe(true);
    // A grant that changes nothing records nothing.
    expect(OPERATIONS.role_change.run(store, HUMAN, { for_role: "worker", action: "task.drop", change: "grant" }, context()).changed).toBe(false);
    expect(store.listRoleChanges()).toHaveLength(1);
  });

  test("revoking the planner's waive refuses its waive through the tool; granting it back restores the default", () => {
    OPERATIONS.role_change.run(store, HUMAN, { for_role: "planner", action: "task.waive", change: "revoke" }, context());
    const refused = refusal(() => OPERATIONS.task_waive.run(store, agent("planner"), { id: "01KA0000000000000000000000", reason: "x" }, context()));
    expect(refused.message).toBe(`the planner may not ${ACTIONS["task.waive"]} (task.waive)`);
    expect(OPERATIONS.role_list.run(store, HUMAN, {}, context()).find((view) => view.role === "planner")?.revoked).toEqual(["task.waive"]);
    OPERATIONS.role_change.run(store, HUMAN, { for_role: "planner", action: "task.waive", change: "grant" }, context());
    expect(OPERATIONS.role_list.run(store, HUMAN, {}, context()).find((view) => view.role === "planner")).toMatchObject({ granted: [], revoked: [] });
  });

  test("a designer role gets read and close; it is listed once changed", () => {
    OPERATIONS.role_change.run(store, HUMAN, { for_role: "designer", action: "task.close", change: "grant" }, context());
    expect(OPERATIONS.role_list.run(store, HUMAN, {}, context()).find((view) => view.role === "designer")?.actions).toEqual(["task.close", "record.read", "graph.read"]);
  });

  test("the fixed steps, what every role may do, the Human's own actions and an unknown action are refused, writing nothing", () => {
    const change = (for_role: string, action: string, kind = "grant") => refusal(() => OPERATIONS.role_change.run(store, HUMAN, { for_role, action, change: kind }, context())).message;
    expect(change("planner", "project.purge")).toContain("is the Human's alone");
    expect(change("planner", "tmb.uninstall")).toContain("is the Human's alone");
    expect(change("worker", "record.read", "revoke")).toContain("every role may do");
    expect(change("human", "task.waive", "revoke")).toContain("the Human's own actions");
    expect(change("worker", "task.anything")).toContain("is no action");
    expect(change("Worker", "task.drop")).toContain("lowercase");
    expect(store.listRoleChanges()).toEqual([]);
  });

  test("only a role holding permissions.manage changes one; the Human may grant it to the planner", () => {
    const planner = agent("planner");
    expect(refusal(() => OPERATIONS.role_change.run(store, planner, { for_role: "worker", action: "task.drop", change: "grant" }, context())).message).toContain("(permissions.manage)");
    OPERATIONS.role_change.run(store, HUMAN, { for_role: "planner", action: "permissions.manage", change: "grant" }, context());
    OPERATIONS.role_change.run(store, planner, { for_role: "worker", action: "task.drop", change: "grant" }, context());
    expect(store.listRoleChanges().at(-1)).toMatchObject({ role: "worker", createdBy: planner });
  });
});
