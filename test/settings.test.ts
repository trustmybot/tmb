// The project's settings: stored as audit entries in the record, the newest in force.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSettings, SettingError, settingLines, validateSetting, writeSetting } from "../src/engine/index.ts";
import { type Actor, openStore, type Store } from "../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tmb-settings-"));
  const opened = openStore(path.join(dir, "tmb.db"), { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("settings in the record", () => {
  test("start unset", () => {
    expect(readSettings(store)).toEqual({ host: null, host_roles: null, base_branch: null, review_mode: null, checks: null });
  });

  test("each set is one audit entry by the actor, and the current value is the newest", () => {
    expect(writeSetting(store, HUMAN, "base_branch", "main")).toBe(true);
    expect(writeSetting(store, HUMAN, "checks", ["bun run lint", "bun test"])).toBe(true);
    expect(writeSetting(store, HUMAN, "base_branch", "develop")).toBe(true);

    expect(readSettings(store)).toEqual({ host: null, host_roles: null, base_branch: "develop", review_mode: null, checks: ["bun run lint", "bun test"] });
    const audit = store.listAudit();
    expect(audit).toHaveLength(3);
    expect(audit.every((entry) => entry.createdBy.kind === "human")).toBe(true);
    expect(audit.map((entry) => entry.detail)).toEqual(['"main"', '["bun run lint","bun test"]', '"develop"']);
  });

  test("a value equal to the current one records nothing", () => {
    writeSetting(store, HUMAN, "host", "host-a");
    writeSetting(store, HUMAN, "checks", ["pytest"]);
    expect(writeSetting(store, HUMAN, "host", "host-a")).toBe(false);
    expect(writeSetting(store, HUMAN, "host", "  host-a  ")).toBe(false);
    expect(writeSetting(store, HUMAN, "checks", ["pytest"])).toBe(false);
    expect(store.listAudit()).toHaveLength(2);
  });

  test("an empty list of checks is a value, set back to after a non-empty one", () => {
    writeSetting(store, HUMAN, "checks", ["pytest"]);
    expect(writeSetting(store, HUMAN, "checks", [])).toBe(true);
    expect(readSettings(store).checks).toEqual([]);
  });

  test("the store keeps them across a rebuild of the projections", () => {
    writeSetting(store, HUMAN, "review_mode", "agile");
    store.rebuildProjections();
    expect(readSettings(store).review_mode).toBe("agile");
  });
});

describe("validation", () => {
  test("refuses truest with the level it arrives at, and records nothing", () => {
    expect(() => writeSetting(store, HUMAN, "review_mode", "truest")).toThrow(
      new SettingError("review mode truest arrives at level 10; only agile is available now"),
    );
    expect(store.listAudit()).toHaveLength(0);
  });

  test("refuses an unknown review mode", () => {
    expect(() => validateSetting("review_mode", "fast")).toThrow(/review mode must be agile, got "fast"/);
  });

  test("refuses an empty base branch or host, and trims the text it keeps", () => {
    expect(() => validateSetting("base_branch", "  ")).toThrow(SettingError);
    expect(() => validateSetting("host", "")).toThrow(SettingError);
    expect(() => validateSetting("base_branch", 3)).toThrow(SettingError);
    expect(validateSetting("base_branch", " main ")).toBe("main");
  });

  test("refuses checks that are not a list of non-empty commands", () => {
    expect(() => validateSetting("checks", "bun test")).toThrow(/checks must be a list/);
    expect(() => validateSetting("checks", ["bun test", " "])).toThrow(/each check must be a non-empty text/);
    expect(() => validateSetting("checks", [1])).toThrow(SettingError);
    expect(validateSetting("checks", [" bun test "])).toEqual(["bun test"]);
  });

  test("refuses an unknown setting", () => {
    expect(() => validateSetting("colour" as never, "red")).toThrow(/unknown setting "colour"/);
  });
});

describe("settingLines", () => {
  test("shows one line per setting, quoting each check and naming what is unset", () => {
    expect(settingLines({ host: "host-a", host_roles: { "host-a": "planner", "host-b": "reviewer" }, base_branch: "main", review_mode: "agile", checks: ["bun run lint", "go test ./..."] })).toEqual([
      "host: host-a",
      "host roles: host-a planner, host-b reviewer",
      "base branch: main",
      "review mode: agile",
      'checks: "bun run lint", "go test ./..."',
    ]);
    expect(settingLines({ host: null, host_roles: null, base_branch: null, review_mode: null, checks: [] })).toEqual([
      "host: (not set)",
      "host roles: (not set)",
      "base branch: (not set)",
      "review mode: (not set)",
      "checks: (none)",
    ]);
  });
});
