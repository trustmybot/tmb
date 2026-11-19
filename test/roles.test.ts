// The engine's subagent roles: what each may do, in host-neutral terms, and the prompt it is written with.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CAPABILITIES, SUBAGENT_ROLES } from "../src/engine/index.ts";
import { ROLES } from "../src/engine/store/index.ts";

const ROOT = path.resolve(import.meta.dir, "..");

function role(name: string) {
  const found = SUBAGENT_ROLES.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no ${name} role in the engine's list`);
  return found;
}

describe("subagent roles", () => {
  test("the list holds the worker and the reviewer, named as the record and the gate name them", () => {
    expect(SUBAGENT_ROLES.map((entry) => entry.name)).toEqual(["worker", "reviewer"]);
    for (const entry of SUBAGENT_ROLES) expect(ROLES as readonly string[]).toContain(entry.name);
  });

  test("the worker can read and edit files and run commands", () => {
    expect([...role("worker").capabilities].sort()).toEqual(["edit-files", "read-files", "run-commands"]);
  });

  test("the reviewer can read files and run commands but cannot edit files", () => {
    expect([...role("reviewer").capabilities].sort()).toEqual(["read-files", "run-commands"]);
    expect(role("reviewer").capabilities).not.toContain("edit-files");
  });

  test("each role uses only known capabilities, has a one-line description and its prompt from roles/", () => {
    for (const entry of SUBAGENT_ROLES) {
      for (const capability of entry.capabilities) expect(CAPABILITIES as readonly string[]).toContain(capability);
      expect(entry.description).not.toContain("\n");
      expect(entry.prompt).toBe(readFileSync(path.join(ROOT, "roles", `${entry.name}.md`), "utf8"));
    }
  });

  test("model and effort are left to the host", () => {
    for (const entry of SUBAGENT_ROLES) {
      expect(entry.model).toBeUndefined();
      expect(entry.effort).toBeUndefined();
    }
  });
});
