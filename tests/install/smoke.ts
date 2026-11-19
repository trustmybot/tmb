// Install smoke test: runs the published installer of a channel into a throwaway home, then
// checks the installed binary end to end. Never touches the real home. One driver for every
// OS: install.sh under sh on macOS and Linux, install.ps1 under PowerShell on Windows.
//   bun tests/install/smoke.ts [channel] [expected-version]
// channel defaults to TMB_CHANNEL, then dev; with an expected version (or TMB_EXPECTED_VERSION),
// `tmb --version` must report it. The rc channel needs the expected version, to find that
// release's installer.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Channel, CHANNELS, programName } from "../../src/program.ts";
import { IS_WINDOWS, pathOf, run, runToFile, tempDir, withEnv } from "../lib/driver.ts";

const channel = process.argv[2] || process.env.TMB_CHANNEL || "dev";
const expectedVersion = process.argv[3] || process.env.TMB_EXPECTED_VERSION || "";
const releasesUrl = "https://github.com/trustmybot/tmb-releases";
const installerName = IS_WINDOWS ? "install.ps1" : "install.sh";
let installerUrl: string;
if (channel === "stable") installerUrl = `${releasesUrl}/releases/latest/download/${installerName}`;
else if (channel === "rc") {
  if (!expectedVersion) {
    console.log("FAIL the rc channel needs an expected version");
    process.exit(1);
  }
  installerUrl = `${releasesUrl}/releases/download/v${expectedVersion}/${installerName}`;
} else installerUrl = `${releasesUrl}/releases/download/${channel}/${installerName}`;

let failures = 0;
const pass = (message: string) => console.log(`PASS ${message}`);
const fail = (message: string) => {
  console.log(`FAIL ${message}`);
  failures++;
};
const showLog = (file: string) => {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").replace(/\r?\n$/, "").split(/\r?\n/)) console.log(`  | ${line}`);
};

const work = tempDir("tmb-smoke");
const home = path.join(work, "home");
const project = path.join(work, "project");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
// Each channel installs under its own name: tmb, tmb-rc or tmb-dev.
const name = CHANNELS.includes(channel as Channel) ? programName(channel as Channel) : "tmb";
const tmb = path.join(home, ".local", "bin", IS_WINDOWS ? `${name}.exe` : name);
const where = IS_WINDOWS ? `%USERPROFILE%\\.local\\bin\\${name}.exe` : `$HOME/.local/bin/${name}`;

// Every run sees the throwaway home: HOME, and on Windows the USERPROFILE and LOCALAPPDATA the
// installer and tmb read. ZDOTDIR would point zsh's profile outside it.
const homeEnv = withEnv({
  HOME: home,
  ZDOTDIR: undefined,
  ...(IS_WINDOWS ? { USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local") } : {}),
});

/** The steps in order; returning early skips the later ones but still reaches the summary. */
async function smoke(): Promise<void> {
  // Downloaded to a file and run from there, so a download failure is told apart from an install failure.
  const installer = path.join(work, installerName);
  try {
    const response = await fetch(installerUrl);
    if (!response.ok) throw new Error(`answered ${response.status}`);
    writeFileSync(installer, Buffer.from(await response.arrayBuffer()));
    pass(`download installer from ${installerUrl}`);
  } catch (error) {
    fail(`download installer from ${installerUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // TMB_NO_MODIFY_PATH keeps the installer away from shell profiles and the user Path in the registry.
  const installLog = path.join(work, "install.log");
  const installEnv = withEnv({ TMB_CHANNEL: channel, TMB_NO_MODIFY_PATH: "1" }, homeEnv);
  // On Windows a child PowerShell, because the installer ends with `exit` on failure.
  const shell = IS_WINDOWS ? (Bun.which("pwsh") ?? "powershell") : "sh";
  const shellArgs = IS_WINDOWS ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer] : [installer];
  const installStatus = runToFile(shell, shellArgs, installLog, { cwd: work, env: installEnv });
  if (installStatus === 0 && existsSync(tmb)) {
    pass(`installer put tmb at ${where}`);
  } else {
    showLog(installLog);
    fail(`installer put tmb at ${where} (exit ${installStatus})`);
    return;
  }

  const version = run(tmb, ["--version"], { env: homeEnv });
  const versionLine = version.output.trim();
  const installedVersion = versionLine.split(/\s+/)[1];
  if (version.status !== 0) fail(`tmb --version exited ${version.status}: ${versionLine}`);
  else if (expectedVersion && installedVersion !== expectedVersion) fail(`tmb --version: expected ${expectedVersion}, got '${versionLine}'`);
  else if (!versionLine.includes(`on the ${channel} channel`)) fail(`${name} --version names the ${channel} channel: '${versionLine}'`);
  else pass(`tmb --version: ${versionLine}`);

  // Setup needs an installed host, and a clean machine has none: a copy of tmb named claude
  // stands in, since setup only needs `claude --version` to answer.
  const fakeHost = path.join(work, "fake-host");
  mkdirSync(fakeHost, { recursive: true });
  copyFileSync(tmb, path.join(fakeHost, IS_WINDOWS ? "claude.exe" : "claude"));
  const setupLog = path.join(work, "setup.log");
  const gitInit = run("git", ["init", "-q"], { cwd: project, env: homeEnv });
  const setupStatus =
    gitInit.status === 0 ? runToFile(tmb, ["setup"], setupLog, { cwd: project, env: withEnv({ PATH: `${fakeHost}${path.delimiter}${pathOf(homeEnv)}` }, homeEnv) }) : -1;
  const settings = path.join(project, ".claude", "settings.local.json");
  if (setupStatus === 0 && existsSync(settings) && readFileSync(settings, "utf8").includes("hook session-start")) {
    pass("tmb setup wired the SessionStart hook in a fresh git repo");
  } else {
    if (gitInit.status !== 0) console.log(`  | git init: ${gitInit.output.trim()}`);
    showLog(setupLog);
    fail("tmb setup wired the SessionStart hook in a fresh git repo");
  }

  const hook = run(tmb, ["hook", "session-start"], { cwd: project, env: homeEnv, input: "{}" });
  let problem = "";
  try {
    const answer = JSON.parse(hook.stdout).hookSpecificOutput;
    if (answer?.hookEventName !== "SessionStart") problem = `hookEventName is ${JSON.stringify(answer?.hookEventName)}, not SessionStart`;
    else if (!String(answer.additionalContext ?? "").includes("You are bro")) problem = 'additionalContext lacks "You are bro"';
  } catch (error) {
    problem = `output is not the hook JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (problem) {
    for (const line of hook.stderr.split(/\r?\n/).filter(Boolean)) console.log(`  | ${line}`);
    fail(`tmb hook session-start: ${problem}`);
  } else {
    pass("tmb hook session-start answers as bro");
  }
}

try {
  await smoke();
} catch (error) {
  fail(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
}
if (failures === 0) {
  console.log("install smoke: all checks passed");
  process.exit(0);
}
console.error(`install smoke: ${failures} check(s) failed`);
process.exit(1);
