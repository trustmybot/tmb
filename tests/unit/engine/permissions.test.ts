// One permission table, one check, default deny (docs/architecture/PERMISSIONS.md).
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

  test("the Human holds a narrow set: the fixed steps, managing roles, the review mode and the waivers", () => {
    for (const action of [...FIXED_HUMAN_ACTIONS, "permissions.manage", "settings.review-mode", "feature.waive", "task.waive"] as const) expect(mayTake(HUMAN, action)).toBe(true);
    for (const action of ["issue.create", "issue.update", "issue.note", "feature.start", "feature.update", "feature.drop", "feature.pr", "task.start", "task.close", "task.drop", "task.pr", "review.record", "role.create"] as const) {
      expect(mayTake(HUMAN, action)).toBe(false);
    }
  });

  test("the planner creates, changes and deletes roles, and closes any task, by default", () => {
    for (const action of ["role.create", "role.delete", "permissions.manage", "task.close"] as const) expect(mayTake(agent("planner"), action)).toBe(true);
    expect(mayTake(agent("worker"), "role.create")).toBe(false);
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

  test("a role is granted actions only once it is created", () => {
    expect(refusal(() => OPERATIONS.role_change.run(store, HUMAN, { for_role: "designer", action: "task.close", change: "grant" }, context())).message).toContain(
      "there is no role designer; create it first with role_create",
    );
    expect(store.listRoleChanges()).toEqual([]);
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

  test("only a role holding permissions.manage changes one; the Human may take it from the planner", () => {
    const planner = agent("planner");
    OPERATIONS.role_change.run(store, planner, { for_role: "worker", action: "task.drop", change: "grant" }, context());
    expect(store.listRoleChanges().at(-1)).toMatchObject({ role: "worker", createdBy: planner });
    expect(refusal(() => OPERATIONS.role_change.run(store, agent("worker"), { for_role: "worker", action: "task.pr", change: "grant" }, context())).message).toContain("(permissions.manage)");
    OPERATIONS.role_change.run(store, HUMAN, { for_role: "planner", action: "permissions.manage", change: "revoke" }, context());
    expect(refusal(() => OPERATIONS.role_change.run(store, planner, { for_role: "worker", action: "task.pr", change: "grant" }, context())).message).toContain("(permissions.manage)");
  });

  test("the planner does not grant to its own role, nor an action it does not hold; the Human grants either", () => {
    const planner = agent("planner");
    expect(refusal(() => OPERATIONS.role_change.run(store, planner, { for_role: "planner", action: "review.record", change: "grant" }, context())).message).toContain(
      "an agent does not grant actions to its own role",
    );
    expect(refusal(() => OPERATIONS.role_change.run(store, planner, { for_role: "worker", action: "review.record", change: "grant" }, context())).message).toContain("review.record");
    expect(store.listRoleChanges()).toEqual([]);
    OPERATIONS.role_change.run(store, HUMAN, { for_role: "planner", action: "review.record", change: "grant" }, context());
    expect(mayTake(planner, "review.record", store.listRoleChanges())).toBe(true);
  });
});

describe("roles a project creates", () => {
  let scratch: string;
  let store: Store;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "tmb-created-roles-"));
    const opened = openProjectStore(scratch, { create: true });
    if (!opened.ok) throw opened.error;
    store = opened.store;
  });
  afterEach(() => {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const context = () => ({ projectDir: scratch });
  const planner = agent("planner");
  const designer = { name: "designer", purpose: "Draws the screens a task needs", prompt: "You are the designer.", actions: ["task.close"] };
  const refused = (name: "role_create" | "role_delete" | "role_change", input: unknown, actor: Actor = planner): string => {
    try {
      OPERATIONS[name].run(store, actor, input, context());
    } catch (error) {
      if (error instanceof HandlerError) return error.message;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  test("the planner creates a role with its prompt and actions; its agent's calls are judged by them; the record names the planner", () => {
    const created = OPERATIONS.role_create.run(store, planner, designer, context());
    expect(created.role).toMatchObject({ role: "designer", purpose: designer.purpose, actions: ["task.close", "record.read", "graph.read"], granted: ["task.close"] });
    expect(store.listRoles()).toMatchObject([{ name: "designer", prompt: "You are the designer.", createdBy: planner }]);
    expect(store.listRoleChanges()).toMatchObject([{ role: "designer", action: "task.close", change: "grant", createdBy: planner }]);
    expect(OPERATIONS.role_list.run(store, HUMAN, {}, context()).map((view) => view.role)).toEqual(["human", "planner", "worker", "reviewer", "designer"]);
    // The one check: granted task.close is taken, task.start is refused.
    expect(() => requirePermission(agent("designer"), "task.close", store.listRoleChanges())).not.toThrow();
    expect(() => requirePermission(agent("designer"), "task.start", store.listRoleChanges())).toThrow("the designer may not");
  });

  test("a role with no row reads only", () => {
    expect(mayTake(agent("stranger"), "record.read", store.listRoleChanges())).toBe(true);
    expect(mayTake(agent("stranger"), "task.close", store.listRoleChanges())).toBe(false);
  });

  test("a bad name, a name tmb keeps, a name in use, a fixed step or an action the planner lacks is refused, writing nothing", () => {
    expect(refused("role_create", { ...designer, name: "Designer" })).toContain("lowercase");
    for (const name of ["planner", "worker", "reviewer", "human", "bro", "main-agent", "unnamed-agent"]) expect(refused("role_create", { ...designer, name })).toContain("is a name tmb keeps");
    expect(refused("role_create", { ...designer, purpose: " " })).toContain("purpose");
    expect(refused("role_create", { ...designer, actions: ["project.purge"] })).toContain("is the Human's alone");
    expect(refused("role_create", { ...designer, actions: ["review.record"] })).toContain("review.record");
    expect(refused("role_create", designer, agent("worker"))).toContain("(role.create)");
    expect(store.listRoles()).toEqual([]);
    expect(store.listRoleChanges()).toEqual([]);
    OPERATIONS.role_create.run(store, planner, designer, context());
    expect(refused("role_create", designer)).toContain("already exists");
  });

  test("the planner changes a created role's actions later, and deletes it; a role made again under its name starts with none", () => {
    OPERATIONS.role_create.run(store, planner, designer, context());
    OPERATIONS.role_change.run(store, planner, { for_role: "designer", action: "issue.note", change: "grant" }, context());
    expect(OPERATIONS.role_delete.run(store, planner, { name: "designer" }, context())).toMatchObject({ name: "designer", revoked: ["task.close", "issue.note"] });
    expect(store.listRoles()).toEqual([]);
    expect(mayTake(agent("designer"), "task.close", store.listRoleChanges())).toBe(false);
    expect(refused("role_delete", { name: "designer" })).toContain("there is no role designer");
    const again = OPERATIONS.role_create.run(store, planner, { ...designer, actions: [] }, context());
    expect(again.role).toMatchObject({ actions: ["record.read", "graph.read"], granted: [] });
  });

  test("a role tmb ships is not deleted", () => {
    for (const name of ["planner", "worker", "reviewer"]) expect(refused("role_delete", { name })).toContain("is a role tmb ships");
    expect(refused("role_delete", { name: "human" })).toContain("tmb ships");
  });

});
