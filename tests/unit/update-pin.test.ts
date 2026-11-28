// An update applies at once; a running session pins its project to the build it started with
// (trustmybot/tmb#159). These cover the updater's own bookkeeping; the update scenario test
// covers the whole story with real builds.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { adapter as claudeCode } from "../../src/adapters/claude-code/index.ts";
import { Updater } from "../../src/cli/commands/update.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let scratch: string;
let alive: ReturnType<typeof spawn> | undefined;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-pin-")));
});

afterEach(() => {
  alive?.kill();
  alive = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

function updater(version: string): Updater {
  const target = path.join(scratch, "bin", "tmb-dev");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `build ${version}`);
  return new Updater({ version, target, stateDir: path.join(scratch, "state"), releasesUrl: "http://127.0.0.1:9", releasesApi: "http://127.0.0.1:9", enabled: true });
}

/** A process that stays alive, standing in for a session's tool server. */
function liveProcess(): number {
  alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return alive.pid!;
}

describe("a running session pins its project (trustmybot/tmb#159)", () => {
  test("a session on another build pins its project; a session on this build, or one that ended, does not", async () => {
    const project = path.join(scratch, "a");
    const old = updater("0.1.0-dev.1");
    const pid = liveProcess();
    old.startSession(project, pid);
    expect(old.pinOf(project)).toBeNull();
    const installed = updater("0.1.0-dev.2");
    expect(installed.pinOf(project)).toBe("0.1.0-dev.1");
    expect(installed.pinOf(path.join(scratch, "b"))).toBeNull();
    // Once the session moves to the installed build, the project is free.
    installed.updateSession(pid, { build: "0.1.0-dev.2" });
    expect(installed.pinOf(project)).toBeNull();
    // A session that ended without saying so pins nothing.
    installed.updateSession(pid, { build: "0.1.0-dev.1" });
    const exited = new Promise((resolve) => alive!.once("exit", resolve));
    alive!.kill("SIGKILL");
    await exited;
    expect(installed.pinOf(project)).toBeNull();
  });

  test("a kept build lives under the program's own name, by version, and says whether a session uses it", () => {
    const installed = updater("0.1.0-dev.2");
    const kept = installed.keptFile("0.1.0-dev.1");
    expect(path.basename(kept).replace(/\.exe$/, "")).toBe("tmb-dev");
    expect(path.basename(path.dirname(kept))).toBe("0.1.0-dev.1");
    mkdirSync(path.dirname(kept), { recursive: true });
    writeFileSync(kept, "old build");
    expect(installed.keptBuilds().map(({ version, dir, bytes, usedBy }) => ({ version, dir, bytes, used: usedBy.length }))).toEqual([{ version: "0.1.0-dev.1", dir: path.dirname(kept), bytes: 9, used: 0 }]);
    installed.startSession(path.join(scratch, "a"), liveProcess(), { build: "0.1.0-dev.1" });
    expect(installed.keptBuilds()[0]!.usedBy.length).toBe(1);
  });

  test("tmb update names each session still on an old build, and why", () => {
    const installed = updater("0.1.0-dev.2");
    const pid = liveProcess();
    installed.startSession(path.join(scratch, "a"), pid, { build: "0.1.0-dev.1" });
    expect(installed.waiting("0.1.0-dev.2").map((entry) => entry.reason)).toEqual(["it moves at its next tool call"]);
    installed.updateSession(pid, { moveError: "no answer to initialize within 30s" });
    expect(installed.waiting("0.1.0-dev.2").map((entry) => entry.reason)).toEqual(["it could not move: no answer to initialize within 30s"]);
    expect(installed.waiting("0.1.0-dev.1")).toEqual([]);
  });
});

describe("the session's title (trustmybot/tmb#159)", () => {
  test("Claude Code passes the title the Human gave the session at its start", () => {
    expect(claudeCode.sessionTitle!(JSON.stringify({ session_id: "x", session_title: "  release prep " }))).toBe("release prep");
    expect(claudeCode.sessionTitle!(JSON.stringify({ session_id: "x" }))).toBeNull();
    expect(claudeCode.sessionTitle!("not json")).toBeNull();
  });
});
