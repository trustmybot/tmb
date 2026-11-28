// Install channels test: tmb, tmb-rc and tmb-dev installed side by side into one throwaway
// home by the published installer, each reporting its own channel, looking for updates only
// on it and keeping its own state, so none ever swaps another (trustmybot/tmb#89). Never
// touches the real home. A channel with no release yet is skipped with a notice.
//   bun tests/install/channels.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Channel, CHANNELS, programName } from "../../src/engine/program.ts";
import { IS_WINDOWS, run, runToFile, tempDir, withEnv } from "../lib/driver.ts";

const releasesUrl = "https://github.com/trustmybot/tmb-releases";
const installerName = IS_WINDOWS ? "install.ps1" : "install.sh";
// One installer serves every channel; the dev release always carries the newest.
const installerUrl = `${releasesUrl}/releases/download/dev/${installerName}`;

let failures = 0;
const pass = (message: string) => console.log(`PASS ${message}`);
const fail = (message: string) => {
  console.log(`FAIL ${message}`);
  failures++;
};

const work = tempDir("tmb-channels");
const home = path.join(work, "home");
const stateRoot = path.join(work, "state");
mkdirSync(home, { recursive: true });
const bin = path.join(home, ".local", "bin");
const fileOf = (name: string) => path.join(bin, IS_WINDOWS ? `${name}.exe` : name);
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const homeEnv = withEnv({
  HOME: home,
  ZDOTDIR: undefined,
  XDG_STATE_HOME: stateRoot,
  TMB_STATE_DIR: undefined,
  TMB_NO_UPDATE: undefined,
  ...(IS_WINDOWS ? { USERPROFILE: home, LOCALAPPDATA: stateRoot } : {}),
});

async function channels(): Promise<void> {
  const installer = path.join(work, installerName);
  try {
    const response = await fetch(installerUrl);
    if (!response.ok) throw new Error(`answered ${response.status}`);
    writeFileSync(installer, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    fail(`download installer from ${installerUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const installed: Channel[] = [];
  for (const channel of CHANNELS) {
    const name = programName(channel);
    const log = path.join(work, `install-${channel}.log`);
    const shell = IS_WINDOWS ? (Bun.which("pwsh") ?? "powershell") : "sh";
    const args = IS_WINDOWS ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer] : [installer];
    const status = runToFile(shell, args, log, { cwd: work, env: withEnv({ TMB_CHANNEL: channel, TMB_NO_MODIFY_PATH: "1" }, homeEnv) });
    const output = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (status !== 0 && /has no release yet|404/.test(output)) {
      console.log(`SKIP the ${channel} channel has no release yet`);
      continue;
    }
    if (status !== 0 || !existsSync(fileOf(name))) {
      for (const line of output.split(/\r?\n/).filter(Boolean)) console.log(`  | ${line}`);
      fail(`the ${channel} installer put ${name} in ${bin} (exit ${status})`);
      continue;
    }
    pass(`the ${channel} installer put ${name} in ${bin}`);
    installed.push(channel);
  }

  for (const channel of installed) {
    const name = programName(channel);
    const version = run(fileOf(name), ["--version"], { env: homeEnv });
    if (version.status === 0 && version.output.includes(`on the ${channel} channel`)) pass(`${name} --version: ${version.output.trim()}`);
    else fail(`${name} --version names the ${channel} channel: '${version.output.trim()}'`);
  }

  // Each looks for an update on its own channel only, in its own state folder, and leaves the others' files alone.
  for (const channel of installed) {
    const name = programName(channel);
    const others = installed.filter((other) => other !== channel).map((other) => fileOf(programName(other)));
    const before = others.map(sha);
    const check = run(fileOf(name), ["update", "--check"], { env: homeEnv });
    const states = existsSync(stateRoot) ? readdirSync(stateRoot) : [];
    if (check.status === 0 && check.output.includes(`the ${channel} channel`) && states.includes(name)) pass(`${name} update --check looked on the ${channel} channel only`);
    else fail(`${name} update --check looked on the ${channel} channel, in its own state (exit ${check.status}): '${check.output.trim()}', state ${states.join(", ")}`);
    if (others.every((file, i) => sha(file) === before[i])) pass(`${name} left the other programs alone`);
    else fail(`${name} changed another program's file`);
  }
  const expected = installed.map((channel) => programName(channel)).sort();
  const states = existsSync(stateRoot) ? readdirSync(stateRoot).sort() : [];
  if (JSON.stringify(states) === JSON.stringify(expected)) pass(`each program keeps its own state: ${states.join(", ")}`);
  else fail(`each program keeps its own state: expected ${expected.join(", ")}, found ${states.join(", ")}`);
}

try {
  await channels();
} catch (error) {
  fail(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
}
if (failures === 0) {
  console.log("install channels: all checks passed");
  process.exit(0);
}
console.error(`install channels: ${failures} check(s) failed`);
process.exit(1);
