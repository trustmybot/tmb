// Every bun test file sets its own default timeout. bun's 5 seconds fails tests that start tmb,
// git or a server whenever the machine is busy (trustmybot/tmb#196), and on bun 1.4 neither a
// preload nor bunfig.toml can raise it for the whole run: setDefaultTimeout holds only in the file
// that calls it. So each file calls it, and this test names any file that does not.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ROOT = path.join(import.meta.dir, "..", "..");

/** The repo's bun test files, as bun finds them, less the agent-run fixtures bunfig.toml ignores. */
function testFiles(): string[] {
  const files: string[] = [];
  for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: ROOT })) {
      if (file.startsWith("node_modules/") || file.includes("/node_modules/")) continue;
      if (file.startsWith("tests/agent-run/fixtures/")) continue;
      files.push(file);
    }
  }
  return files.sort();
}

describe("test timeouts", () => {
  test("every test file sets its default timeout to 30 seconds", () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(0);
    const missing = files.filter((file) => !/^setDefaultTimeout\(30_000\);$/m.test(readFileSync(path.join(ROOT, file), "utf8")));
    expect(missing).toEqual([]);
  });
});
