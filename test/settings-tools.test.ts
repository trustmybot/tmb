// settings_get and settings_set: the planner reads the project's settings with what tmb detects,
// and applies the ones it recommends; each change is an audit entry by the planner.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HandlerError, settingsGet, settingsSet } from "../src/engine/handlers/index.ts";
import { openProjectStore, readSettings } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const PLANNER: Actor = { kind: "agent", role: "planner", host: "test" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "test" };

let project: string;
let store: Store;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "tmb-settings-"));
  writeFileSync(path.join(project, "Cargo.toml"), "");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

const context = () => ({ projectDir: project });

function refusal(run: () => unknown): HandlerError {
  try {
    run();
  } catch (error) {
    if (error instanceof HandlerError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("settings_get", () => {
  test("names the empty settings and what tmb detects in the project", () => {
    const view = settingsGet(store, PLANNER, {}, context());
    expect(view.empty).toEqual(["base_branch", "review_mode", "checks"]);
    expect(view.detected.checks).toEqual(["cargo test"]);
    expect(view.detected.review_modes).toEqual(["agile", "truest"]);
  });
});

describe("settings_set", () => {
  test("applies the planner's settings, records each change by the planner, and records nothing for a value unchanged", () => {
    const set = settingsSet(store, PLANNER, { base_branch: "main", review_mode: "agile", checks: ["cargo test"] }, context());
    expect(set.changed).toEqual(["base_branch", "review_mode", "checks"]);
    expect(set.empty).toEqual([]);
    expect(readSettings(store)).toMatchObject({ base_branch: "main", review_mode: "agile", checks: ["cargo test"] });
    const audit = store.listAudit().filter((entry) => entry.what.startsWith("setting:"));
    expect(audit.map((entry) => entry.createdBy)).toEqual(Array(3).fill(PLANNER));

    const again = settingsSet(store, PLANNER, { review_mode: "truest", base_branch: "main" }, context());
    expect(again.changed).toEqual(["review_mode"]);
    expect(settingsSet(store, PLANNER, { checks: [] }, context()).settings.checks).toEqual([]);
  });

  test("refuses another role, an empty request and a value tmb does not know, writing nothing", () => {
    expect(refusal(() => settingsSet(store, WORKER, { base_branch: "main" }, context())).message).toBe("settings_set is for the planner, not the worker");
    expect(refusal(() => settingsSet(store, PLANNER, {}, context())).message).toContain("needs at least one of base_branch, review_mode, checks");
    expect(refusal(() => settingsSet(store, PLANNER, { base_branch: "main", review_mode: "strict" }, context())).code).toBe("invalid_input");
    expect(refusal(() => settingsSet(store, PLANNER, { checks: ["bun test", " "] }, context())).code).toBe("invalid_input");
    expect(readSettings(store).base_branch).toBeNull();
  });
});
