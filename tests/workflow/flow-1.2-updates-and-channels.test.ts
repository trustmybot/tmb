// Flow 1.2, Updates and channels (docs/flows/FLOWS.md): this file is its scenario test.
// Each channel's install updates itself from a release repo laid out like trustmybot/tmb-releases,
// served locally, and never in the middle of a session or a task.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { programOf } from "../../src/engine/program.ts";
import { assetName, channelOf, compareVersions, isCompiledEntry, Updater, updaterOptions } from "../../src/cli/updater.ts";
import { buildTmb, cleanup, installedVersion, openTask, prepareInstall, runUpdate, type Scenario, updatesItself } from "../install/update-scenario.ts";
import { projectDbPath } from "../../src/engine/project.ts";
import { SCHEMA_VERSION } from "../../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const CHANNELS = {
  dev: { old: "0.1.0-dev.1", next: "0.1.0-dev.2" },
  rc: { old: "0.1.0-rc.1", next: "0.1.0-rc.2" },
  stable: { old: "0.1.0", next: "0.1.1" },
} as const;

let scratch: string;
const scenarios: Scenario[] = [];

/** An install for one test, removed after all of them. */
function install(version: string, env: Record<string, string>): Scenario {
  const scenario = prepareInstall(builds.get(version)!, env);
  scenarios.push(scenario);
  return scenario;
}
let server: ReturnType<typeof Bun.serve>;
const builds = new Map<string, string>();

/** A release as the release repo serves it: the platform file, its checksums and the version. */
function releaseFile(version: string, name: string): Response {
  const binary = builds.get(version)!;
  if (name === "VERSION") return new Response(`${version}\n`);
  if (name === "SHA256SUMS") {
    const sum = createHash("sha256").update(readFileSync(binary)).digest("hex");
    return new Response(`${sum}  ${assetName()}\n`);
  }
  if (name === assetName()) return new Response(Bun.file(binary));
  return new Response("not found", { status: 404 });
}

beforeAll(() => {
  // .native expands Windows 8.3 short names (RUNNER~1), so expected paths match the long form tmb prints.
  scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tmb-update-builds-")));
  for (const { old, next } of Object.values(CHANNELS)) {
    for (const version of [old, next]) {
      const file = path.join(scratch, version, process.platform === "win32" ? "tmb.exe" : "tmb");
      buildTmb(version, file);
      builds.set(version, file);
    }
  }
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      // The public API lists every release; rc reads its newest rc tag from it.
      if (url.pathname === "/api/releases") {
        return Response.json([
          { tag_name: "dev", prerelease: true, draft: false },
          { tag_name: `v${CHANNELS.stable.next}`, prerelease: false, draft: false },
          { tag_name: "v0.1.0-rc.3", prerelease: true, draft: true },
          { tag_name: `v${CHANNELS.rc.next}`, prerelease: true, draft: false },
          { tag_name: `v${CHANNELS.rc.old}`, prerelease: true, draft: false },
        ]);
      }
      // A dev release whose count restarted: older by semantic order than the dev build installed.
      let match = /^\/restarted\/releases\/download\/dev\/([^/]+)$/.exec(url.pathname);
      if (match) return releaseFile(CHANNELS.dev.old, match[1]!);
      match = /^\/releases\/download\/dev\/([^/]+)$/.exec(url.pathname);
      if (match) return releaseFile(CHANNELS.dev.next, match[1]!);
      match = /^\/releases\/latest\/download\/([^/]+)$/.exec(url.pathname);
      if (match) return releaseFile(CHANNELS.stable.next, match[1]!);
      match = /^\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (match && builds.has(match[1]!)) return releaseFile(match[1]!, match[2]!);
      return new Response("not found", { status: 404 });
    },
  });
}, 600_000);

afterAll(async () => {
  server?.stop(true);
  for (const scenario of scenarios) await cleanup(scenario);
  rmSync(scratch, { recursive: true, force: true });
});

function releaseEnv(): Record<string, string> {
  return { TMB_RELEASES_URL: `http://127.0.0.1:${server.port}`, TMB_RELEASES_API: `http://127.0.0.1:${server.port}/api` };
}

describe("an install updates itself", () => {
  for (const [channel, { old, next }] of Object.entries(CHANNELS)) {
    test(`on the ${channel} channel, at once, while a running session keeps its build until it is free (trustmybot/tmb#159)`, async () => {
      const scenario = install(old, releaseEnv());
      {
        const steps: string[] = [];
        await updatesItself(scenario, next, (line) => steps.push(line));
        expect(steps).toHaveLength(8);
        expect(installedVersion(scenario)).toBe(next);
      }
    }, 120_000);
  }
});

describe("versions and channels", () => {
  test("a version's stamp names its channel", () => {
    expect(["0.1.0-dev.3.gh12", "0.1.0-rc.2", "0.1.0"].map(channelOf)).toEqual(["dev", "rc", "stable"]);
  });

  test("versions order as semantic versions, a release after its prereleases", () => {
    const sorted = ["0.1.1", "0.1.0-rc.10", "0.1.0", "0.1.0-rc.2", "0.1.0-dev.4", "0.0.9"].sort(compareVersions);
    expect(sorted).toEqual(["0.0.9", "0.1.0-dev.4", "0.1.0-rc.2", "0.1.0-rc.10", "0.1.0", "0.1.1"]);
  });

  test("a compiled build knows it is compiled on every OS (trustmybot/tmb#57)", () => {
    // Bun.main as a compiled build reports it on macOS/Linux and on Windows, where it uses forward slashes.
    for (const main of ["/$bunfs/root/tmb", "B:/~BUN/root/tmb.exe", "B:\\~BUN\\root\\tmb.exe"]) expect(isCompiledEntry(main)).toBe(true);
    for (const main of ["/repo/src/cli.ts", "C:\\repo\\src\\cli.ts", "D:/a/tmb/src/cli.ts"]) expect(isCompiledEntry(main)).toBe(false);
  });
});

describe("tmb update", () => {
  test("on dev, takes the rolling build even when its count restarted after a stable tag", async () => {
    // The installed build has a higher count than the dev release; the dev release is still the one to follow.
    const newer = install(CHANNELS.dev.next, { ...releaseEnv(), TMB_RELEASES_URL: `http://127.0.0.1:${server.port}/restarted` });
    const updated = await runUpdate(newer);
    expect(updated.output).toContain(`Updated tmb from ${CHANNELS.dev.next} to ${CHANNELS.dev.old}`);
    expect(installedVersion(newer)).toBe(CHANNELS.dev.old);
  }, 60_000);

  test("with --check reports the newer build and leaves the install alone", async () => {
    const scenario = install(CHANNELS.dev.old, releaseEnv());
    const checked = await runUpdate(scenario, "--check");
    expect(checked.status).toBe(0);
    expect(checked.output).toContain(CHANNELS.dev.next);
    expect(installedVersion(scenario)).toBe(CHANNELS.dev.old);
  }, 60_000);

  test("a build kept before a reinstall of another version is never swapped in", async () => {
    const scenario = install(CHANNELS.dev.old, releaseEnv());
    expect((await runUpdate(scenario, "--check")).status).toBe(0);
    const updaterFor = (version: string) =>
      new Updater({ version, target: scenario.installed, stateDir: scenario.stateDir, releasesUrl: "http://127.0.0.1:9", releasesApi: "http://127.0.0.1:9", enabled: true });
    expect(updaterFor(CHANNELS.dev.old).staged()?.version).toBe(CHANNELS.dev.next);
    // The Human reinstalled and now runs a later dev build: the build kept by the old one would take it back.
    const reinstalled = updaterFor("0.1.0-dev.3");
    expect(reinstalled.staged()).toBeNull();
    expect(reinstalled.apply()).toEqual({ outcome: "none" });
  }, 60_000);

  test("with no task open and no session running, applies at once", async () => {
    const scenario = install(CHANNELS.stable.old, releaseEnv());
    const updated = await runUpdate(scenario);
    expect(updated).toMatchObject({ status: 0 });
    expect(updated.output).toContain(`Updated tmb from ${CHANNELS.stable.old} to ${CHANNELS.stable.next}`);
    expect(installedVersion(scenario)).toBe(CHANNELS.stable.next);
  }, 60_000);

  test("a record a newer tmb reshaped never holds the update back (trustmybot/tmb#173)", async () => {
    const scenario = install(CHANNELS.dev.old, releaseEnv());
    // A session served the project, then a newer tmb reshaped its record and left a task open there.
    const updater = new Updater({ ...updaterOptions(CHANNELS.dev.old, false, scenario.env), target: scenario.installed });
    updater.startSession(scenario.project, 1_000_000_000);
    openTask(scenario);
    const db = new Database(projectDbPath(scenario.project));
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const updated = await runUpdate(scenario);
    expect(updated).toMatchObject({ status: 0 });
    expect(updated.output).toContain(`Updated tmb from ${CHANNELS.dev.old} to ${CHANNELS.dev.next}`);
    expect(installedVersion(scenario)).toBe(CHANNELS.dev.next);
  }, 60_000);

  test("with no network, keeps the version it has", async () => {
    const scenario = install(CHANNELS.dev.old, { TMB_RELEASES_URL: "http://127.0.0.1:9", TMB_RELEASES_API: "http://127.0.0.1:9" });
    const updated = await runUpdate(scenario);
    expect(updated.status).toBe(1);
    expect(updated.output).toContain("could not reach the dev channel");
    expect(installedVersion(scenario)).toBe(CHANNELS.dev.old);
  }, 60_000);

  test("refuses a download whose checksum does not match", async () => {
    const bad = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const name = new URL(request.url).pathname.split("/").pop();
        if (name === "VERSION") return new Response(`${CHANNELS.dev.next}\n`);
        if (name === "SHA256SUMS") return new Response(`${"0".repeat(64)}  ${assetName()}\n`);
        return new Response("not tmb");
      },
    });
    try {
      const scenario = install(CHANNELS.dev.old, { TMB_RELEASES_URL: `http://127.0.0.1:${bad.port}` });
      const updated = await runUpdate(scenario);
      expect(updated.status).toBe(1);
      expect(updated.output).toContain("checksum mismatch");
      expect(installedVersion(scenario)).toBe(CHANNELS.dev.old);
    } finally {
      bad.stop(true);
    }
  }, 60_000);

  test("with TMB_NO_UPDATE=1 does nothing", async () => {
    const scenario = install(CHANNELS.dev.old, { ...releaseEnv(), TMB_NO_UPDATE: "1" });
    const updated = await runUpdate(scenario);
    expect(updated.output).toContain("Updates are turned off");
    expect(installedVersion(scenario)).toBe(CHANNELS.dev.old);
  }, 60_000);
});

const EXE = process.platform === "win32" ? ".exe" : "";

/** Several tmb programs installed side by side in one throwaway home, each from a build. */
function sideBySide(programs: Record<string, string>, extraEnv: Record<string, string> = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(scratch, "side-by-side-")));
  const bin = path.join(root, "home", ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const files: Record<string, string> = {};
  for (const [name, version] of Object.entries(programs)) {
    files[name] = path.join(bin, `${name}${EXE}`);
    copyFileSync(builds.get(version)!, files[name]);
  }
  const stateRoot = path.join(root, "state");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), XDG_STATE_HOME: stateRoot, LOCALAPPDATA: stateRoot, ...extraEnv };
  for (const name of ["TMB_NO_UPDATE", "TMB_UPDATE_FILE", "TMB_STATE_DIR"]) delete env[name];
  const run = async (name: string, ...args: string[]) => {
    const child = Bun.spawn([files[name]!, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { status, output: `${stdout}${stderr}`.trim() };
  };
  const version = async (name: string) => (await run(name, "--version")).output.split(/\s+/)[1];
  const bytes = (name: string) => createHash("sha256").update(readFileSync(files[name]!)).digest("hex");
  return { root, bin, files, env, stateRoot, run, version, bytes };
}

describe("programs side by side (trustmybot/tmb#89)", () => {
  test("a program's name says what it follows; plain tmb follows its version's channel", () => {
    expect(programOf(`/b/tmb${EXE}`, "1.0.0")).toEqual({ name: "tmb", channel: "stable" });
    expect(programOf(`/b/tmb-rc${EXE}`, "1.0.0-rc.2")).toEqual({ name: "tmb-rc", channel: "rc" });
    expect(programOf(`/b/tmb-dev${EXE}`, "1.0.0-dev.7")).toEqual({ name: "tmb-dev", channel: "dev" });
    expect(programOf("/b/tmb-1.0.0", "1.0.0")).toEqual({ name: "tmb-1.0.0", channel: null });
    expect(programOf("/b/tmb-1.0.0-rc.2.exe", "1.0.0-rc.2")).toEqual({ name: "tmb-1.0.0-rc.2", channel: null });
    // A dev build installed as tmb before the names were split keeps following dev.
    expect(programOf("/b/tmb", "1.0.0-dev.7")).toEqual({ name: "tmb", channel: "dev" });
    // A build installed under another channel's name follows that name.
    expect(programOf("/b/tmb-rc", "1.0.0-dev.7").channel).toBe("rc");
    expect(programOf(null, "1.0.0-dev.7")).toEqual({ name: "tmb", channel: "dev" });
  });

  test("each program keeps its machine-wide state in a folder of its own name", () => {
    const env = { HOME: "/h", XDG_STATE_HOME: "/s", LOCALAPPDATA: "/s", TMB_UPDATE_FILE: `/b/tmb-dev${EXE}` };
    expect(updaterOptions("1.0.0-dev.1", true, env).stateDir).toBe(path.join("/s", "tmb-dev"));
    expect(updaterOptions("1.0.0", true, { ...env, TMB_UPDATE_FILE: `/b/tmb${EXE}` }).stateDir).toBe(path.join("/s", "tmb"));
    const pinned = new Updater(updaterOptions("1.0.0", true, { ...env, TMB_UPDATE_FILE: "/b/tmb-1.0.0" }));
    expect(pinned.pinned).toBe(true);
    expect(pinned.active).toBe(false);
  });

  test("tmb, tmb-rc, tmb-dev and a pinned tmb each report their own channel and update only themselves", async () => {
    const side = sideBySide({ tmb: CHANNELS.stable.old, "tmb-rc": CHANNELS.rc.old, "tmb-dev": CHANNELS.dev.old, "tmb-0.1.0": CHANNELS.stable.old }, releaseEnv());
    expect((await side.run("tmb", "--version")).output).toContain("on the stable channel");
    expect((await side.run("tmb-rc", "--version")).output).toContain("on the rc channel");
    expect((await side.run("tmb-dev", "--version")).output).toContain("on the dev channel");
    expect((await side.run("tmb-0.1.0", "--version")).output).toContain("pinned");

    const before = Object.fromEntries(Object.keys(side.files).map((name) => [name, side.bytes(name)]));
    const dev = await side.run("tmb-dev", "update");
    expect(dev.output).toContain(`Updated tmb-dev from ${CHANNELS.dev.old} to ${CHANNELS.dev.next}`);
    expect(await side.version("tmb-dev")).toBe(CHANNELS.dev.next);
    for (const name of ["tmb", "tmb-rc", "tmb-0.1.0"]) expect(side.bytes(name)).toBe(before[name]!);
    expect(readdirSync(side.stateRoot)).toEqual(["tmb-dev"]);

    expect((await side.run("tmb-rc", "update")).output).toContain(`Updated tmb-rc from ${CHANNELS.rc.old} to ${CHANNELS.rc.next}`);
    expect((await side.run("tmb", "update")).output).toContain(`Updated tmb from ${CHANNELS.stable.old} to ${CHANNELS.stable.next}`);
    expect([await side.version("tmb"), await side.version("tmb-rc"), await side.version("tmb-dev")]).toEqual([CHANNELS.stable.next, CHANNELS.rc.next, CHANNELS.dev.next]);
    expect(readdirSync(side.stateRoot).sort()).toEqual(["tmb", "tmb-dev", "tmb-rc"]);

    const pinned = await side.run("tmb-0.1.0", "update");
    expect(pinned.output).toContain("tmb-0.1.0 is pinned to 0.1.0 and never updates itself");
    expect(side.bytes("tmb-0.1.0")).toBe(before["tmb-0.1.0"]!);
  }, 240_000);

  test("a project initialised by one program is called through that name, and moves only by another's init", async () => {
    const side = sideBySide({ tmb: CHANNELS.stable.old, "tmb-dev": CHANNELS.dev.old }, { TMB_NO_UPDATE: "1" });
    // init needs an installed host, and a clean machine has none: a copy of tmb named claude stands in.
    const fakeHost = path.join(side.root, "fake-host");
    mkdirSync(fakeHost, { recursive: true });
    copyFileSync(side.files.tmb!, path.join(fakeHost, `claude${EXE}`));
    // Windows names the variable Path, and a plain copy of process.env keeps that case: read it through process.env and drop the copy.
    for (const key of Object.keys(side.env)) if (key.toUpperCase() === "PATH") delete side.env[key];
    side.env.PATH = `${fakeHost}${path.delimiter}${process.env.PATH ?? ""}`;
    const project = path.join(side.root, "project");
    mkdirSync(project, { recursive: true });
    expect(spawnSync("git", ["init", "-q"], { cwd: project }).status).toBe(0);
    const init = (name: string) => spawnSync(side.files[name]!, ["init", "--host", "claude-code"], { cwd: project, env: side.env, encoding: "utf8", timeout: 120_000 });

    const first = init("tmb-dev");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`This project runs tmb-dev: its hooks and tool server call ${side.files["tmb-dev"]}`);
    const mcp = JSON.parse(readFileSync(path.join(project, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.tmb.command).toBe(side.files["tmb-dev"]);
    expect(readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8")).toContain(JSON.stringify(side.files["tmb-dev"]).slice(1, -1));
    expect(readFileSync(path.join(project, ".git", "hooks", "pre-push"), "utf8")).toContain(`tmb-dev${EXE}`);

    // Running the same program's init again neither moves nor re-records the tie.
    expect(init("tmb-dev").stdout).not.toContain("This project runs");

    const moved = init("tmb");
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain(`Moved this project from tmb-dev ${CHANNELS.dev.old} to tmb ${CHANNELS.stable.old}.`);
    expect(JSON.parse(readFileSync(path.join(project, ".mcp.json"), "utf8")).mcpServers.tmb.command).toBe(side.files.tmb);
    expect(existsSync(path.join(project, ".tmb", "trajectory.db"))).toBe(true);
  }, 240_000);
});
