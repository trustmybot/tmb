// Every role's prompt fits its budget: a host shows a hook's text whole only up to its cap, and the
// planner's role reaches its session as such a text, so a longer role is cut (trustmybot/tmb#295).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ROLES_DIR = path.resolve(import.meta.dir, "../../roles");
/** The budget per text, below the 10,000 characters Claude Code shows of a hook's text. */
const ROLE_BUDGET = 8_000;

describe("role size", () => {
  const roles = readdirSync(ROLES_DIR).filter((name) => name.endsWith(".md"));

  test("the check sees every role", () => {
    expect(roles).toEqual(expect.arrayContaining(["planner.md", "reviewer.md", "worker.md"]));
  });

  test(`every role file is at most ${ROLE_BUDGET} characters`, () => {
    const over = roles
      .map((name) => ({ name, length: readFileSync(path.join(ROLES_DIR, name), "utf8").length }))
      .filter((role) => role.length > ROLE_BUDGET)
      .map((role) => `roles/${role.name}: ${role.length} characters`);
    expect(over).toEqual([]);
  });
});
