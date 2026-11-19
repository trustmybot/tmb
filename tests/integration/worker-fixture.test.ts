// The worker agent run's fixture project: its own tests fail as shipped, so the run proves a
// fix, and pass once add returns the sum.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURE = path.resolve(import.meta.dir, "../agent-run/fixtures/math");

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-worker-fixture-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function bunTest(project: string) {
  const result = spawnSync(process.execPath, ["test"], { cwd: project, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("the math fixture", () => {
  test("fails its tests as shipped and passes once add returns a + b", () => {
    const project = path.join(scratch, "math");
    cpSync(FIXTURE, project, { recursive: true });

    const shipped = bunTest(project);
    expect(shipped.status).not.toBe(0);
    expect(shipped.output).toContain("add returns the sum of its two numbers");

    writeFileSync(path.join(project, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    const fixed = bunTest(project);
    expect(fixed.output).toContain("1 pass");
    expect(fixed.status).toBe(0);
  });
});
