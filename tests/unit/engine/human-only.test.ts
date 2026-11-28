// Steps only the Human may take (trustmybot/tmb#179): which commands they are.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { humanOnlyStep } from "../../../src/engine/human-only.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

describe("humanOnlyStep", () => {
  test("both waivers, setting the review mode, a role change, tmb remove and tmb purge are the Human's; tmb update and the rest are not", () => {
    expect(humanOnlyStep(["feature", "waive", "feat/a", "--reason", "x"])?.command).toBe("tmb feature waive");
    expect(humanOnlyStep(["task", "waive", "T-1", "--reason", "x"])?.command).toBe("tmb task waive");
    expect(humanOnlyStep(["onboard", "--review-mode", "agile", "--yes"])?.command).toBe("tmb onboard --review-mode");
    expect(humanOnlyStep(["onboard", "--review-mode=truest"])?.command).toBe("tmb onboard --review-mode");
    expect(humanOnlyStep(["remove"])?.command).toBe("tmb remove");
    expect(humanOnlyStep(["remove", "--host", "claude-code"])?.command).toBe("tmb remove");
    expect(humanOnlyStep(["purge", "web"])?.command).toBe("tmb purge");
    expect(humanOnlyStep(["role", "grant", "worker", "task.drop"])?.action).toBe("permissions.manage");
    expect(humanOnlyStep(["role", "revoke", "planner", "task.waive"])?.command).toBe("tmb role revoke");
    for (const args of [["update"], ["role", "list"], ["onboard", "--yes"], ["onboard", "--base", "main"], ["task", "close", "T-1"], ["feature", "pr", "feat/a"], ["init"], []]) {
      expect(humanOnlyStep(args)).toBeNull();
    }
  });
});
