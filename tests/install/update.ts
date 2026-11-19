// Install update test against the real release repo: an older tmb on the channel is
// installed into a throwaway HOME and must update itself to the channel's newest release,
// between sessions and never with a task open. Never touches the real HOME.
//   bun tests/install/update.ts <dev|rc|stable> [expected-version]
// With an expected version, the channel's newest release must be it. A channel with no
// release yet is skipped with a notice.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHANNELS, type Channel, Updater, updaterOptions } from "../../src/update.ts";
import { buildTmb, cleanup, prepareInstall, updatesItself } from "./update-scenario.ts";

/** A version on the channel older than any release on it. */
const OLD: Record<Channel, string> = { dev: "0.0.0-dev.0", rc: "0.0.0-rc.0", stable: "0.0.0" };

const channel = process.argv[2] as Channel;
const expectedArg = process.argv[3] || process.env.TMB_EXPECTED_VERSION || "";
if (!CHANNELS.includes(channel)) {
  console.error(`usage: bun tests/install/update.ts <${CHANNELS.join("|")}> [expected-version]`);
  process.exit(2);
}

const env = { ...(process.env as Record<string, string>) };
delete env.TMB_NO_UPDATE;
let latest: string;
try {
  latest = (await new Updater(updaterOptions(OLD[channel], false, env)).latest()).version;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!expectedArg && /no release yet|answered 404/.test(message)) {
    console.log(`SKIP the ${channel} channel has no release yet (${message})`);
    process.exit(0);
  }
  console.error(`FAIL could not read the ${channel} channel's newest release: ${message}`);
  process.exit(1);
}
if (expectedArg && latest !== expectedArg) {
  console.error(`FAIL the ${channel} channel's newest release is ${latest}, expected ${expectedArg}`);
  process.exit(1);
}

const builds = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-update-build-")));
const old = path.join(builds, process.platform === "win32" ? "tmb.exe" : "tmb");
let failed = false;
try {
  buildTmb(OLD[channel], old);
  const scenario = prepareInstall(old);
  try {
    await updatesItself(scenario, latest, (line) => console.log(`PASS ${line}`));
    console.log(`install update: the ${channel} install updated itself to ${latest}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    cleanup(scenario);
  }
} finally {
  rmSync(builds, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
