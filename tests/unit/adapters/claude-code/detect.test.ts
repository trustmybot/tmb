import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adapter } from "../../../../src/adapters/claude-code/index.ts";
import { detectProgram } from "../../../../src/adapters/common/detect.ts";
import { adapterById, DEFAULT_HOST_ID, HOST_ADAPTERS } from "../../../../src/adapters/index.ts";
import { TMB_EVENT_TYPES } from "../../../../src/engine/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let bin: string;

beforeEach(() => {
  bin = mkdtempSync(path.join(tmpdir(), "tmb-detect-"));
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

/** A fake `claude` on the search path that prints `output` and exits with `status`. */
function fakeClaude(output: string, status = 0): void {
  const file = path.join(bin, "claude");
  writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] || exit 9\necho '${output}'\nexit ${status}\n`);
  chmodSync(file, 0o755);
}

describe.skipIf(process.platform === "win32")("detect", () => {
  test("reports the version when claude runs", () => {
    fakeClaude("2.1.37 (Claude Code)");
    expect(adapter.detect(bin)).toEqual({ installed: true, version: "2.1.37" });
  });

  test("reports installed without a version when the output names none", () => {
    fakeClaude("unknown build");
    expect(adapter.detect(bin)).toEqual({ installed: true });
  });

  test("reports not installed when claude is absent, without throwing", () => {
    expect(adapter.detect(bin)).toEqual({ installed: false });
  });

  test("reports not installed when claude fails", () => {
    fakeClaude("broken", 1);
    expect(adapter.detect(bin)).toEqual({ installed: false });
  });

  test("reports installed without a version when claude does not answer in time (trustmybot/tmb#207)", () => {
    const file = path.join(bin, "claude");
    writeFileSync(file, "#!/bin/sh\nsleep 5\necho '2.1.37 (Claude Code)'\n");
    chmodSync(file, 0o755);
    expect(detectProgram("claude", bin, 200)).toEqual({ installed: true });
  });

  test("reports installed without a version when claude cannot be started (trustmybot/tmb#207)", () => {
    const file = path.join(bin, "claude");
    writeFileSync(file, "#!/no/such/interpreter\n");
    chmodSync(file, 0o755);
    expect(adapter.detect(bin)).toEqual({ installed: true });
  });
});

describe("limits", () => {
  test("Claude Code can deny a tool call, sets a model per role and raises every host event", () => {
    expect(adapter.limits).toEqual({ canDenyToolCall: true, modelPerRole: true, namesAgentOnToolCall: true, events: TMB_EVENT_TYPES });
  });
});

describe("registry", () => {
  test("lists the Claude Code adapter, which answers a hook that names no host", () => {
    expect(HOST_ADAPTERS).toContain(adapter);
    expect(DEFAULT_HOST_ID).toBe(adapter.id);
    expect(adapterById(adapter.id)).toBe(adapter);
  });

  test("names the hosts it knows when asked for one it does not", () => {
    expect(() => adapterById("no-such-host")).toThrow(/unknown host 'no-such-host'; tmb knows .*claude-code/);
  });
});
