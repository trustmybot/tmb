// Loaded before every test file (bunfig.toml): each tmb the tests run, in this process or as a
// child, keeps its machine-wide state (the updater's, the feedback setting, the last error) in a
// folder of its own, never in the person's real state folder. A test that names its own state
// folder still does. The feedback program is off for them too, so a fresh state folder does not
// add the first run's notice or question to every session start; the feedback tests give their
// own environment.
//
// The folder is removed by a global afterAll, which bun runs once after the last test file. bun
// test does not fire process "exit" handlers, so an exit handler alone left every folder behind.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.env.TMB_STATE_DIR === undefined) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "tmb-test-state-"));
  process.env.TMB_STATE_DIR = stateDir;
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
}
process.env.TMB_NO_FEEDBACK ??= "1";
