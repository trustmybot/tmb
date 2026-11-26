// The project's settings: stored as audit entries in the record, the newest in force.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSettings, SettingError, settingLines, validateSetting, writeSetting } from "../src/engine/index.ts";
import { type Actor, openStore, type Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

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
    expect(readSettings(store)).toEqual({ host: null, host_roles: null, base_branch: null, review_mode: null, checks: null, graph_links: null, repos: null });
  });

  test("each set is one audit entry by the actor, and the current value is the newest", () => {
    expect(writeSetting(store, HUMAN, "base_branch", "main")).toBe(true);
    expect(writeSetting(store, HUMAN, "checks", ["bun run lint", "bun test"])).toBe(true);
    expect(writeSetting(store, HUMAN, "base_branch", "develop")).toBe(true);

    expect(readSettings(store)).toEqual({ host: null, host_roles: null, base_branch: "develop", review_mode: null, checks: ["bun run lint", "bun test"], graph_links: null, repos: null });
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
  test("takes truest, and refuses a mode that does not exist, recording nothing for it", () => {
    expect(writeSetting(store, HUMAN, "review_mode", "truest")).toBe(true);
    expect(readSettings(store).review_mode).toBe("truest");
    expect(() => writeSetting(store, HUMAN, "review_mode", "strict")).toThrow(new SettingError('review mode must be agile or truest, got "strict"'));
    expect(store.listAudit()).toHaveLength(1);
  });

  test("refuses an unknown review mode", () => {
    expect(() => validateSetting("review_mode", "fast")).toThrow(/review mode must be agile or truest, got "fast"/);
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
    expect(settingLines({ host: "host-a", host_roles: { "host-a": "planner", "host-b": "reviewer" }, base_branch: "main", review_mode: "agile", checks: ["bun run lint", "go test ./..."], graph_links: null, repos: null })).toEqual([
      "host: host-a",
      "host roles: host-a planner, host-b reviewer",
      "base branch: main",
      "review mode: agile",
      'checks: "bun run lint", "go test ./..."',
      "graph links: (not set)",
    ]);
    expect(settingLines({ host: null, host_roles: null, base_branch: null, review_mode: null, checks: [], graph_links: null, repos: null })).toEqual([
      "host: (not set)",
      "host roles: (not set)",
      "base branch: (not set)",
      "review mode: (not set)",
      "checks: (none)",
      "graph links: (not set)",
    ]);
  });
});
