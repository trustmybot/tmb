// Each channel's install updates itself from a release repo laid out like trustmybot/tmb-releases,
// served locally, and never in the middle of a session or a task.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetName, channelOf, compareVersions, Updater } from "../../src/update.ts";
import { buildTmb, cleanup, installedVersion, prepareInstall, runUpdate, type Scenario, updatesItself } from "../install/update-scenario.ts";

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
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-update-builds-")));
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

afterAll(() => {
  server?.stop(true);
  for (const scenario of scenarios) cleanup(scenario);
  rmSync(scratch, { recursive: true, force: true });
});

function releaseEnv(): Record<string, string> {
  return { TMB_RELEASES_URL: `http://127.0.0.1:${server.port}`, TMB_RELEASES_API: `http://127.0.0.1:${server.port}/api` };
}

describe("an install updates itself", () => {
  for (const [channel, { old, next }] of Object.entries(CHANNELS)) {
    test(`on the ${channel} channel, between sessions and never with a task open`, async () => {
      const scenario = install(old, releaseEnv());
      {
        const steps: string[] = [];
        await updatesItself(scenario, next, (line) => steps.push(line));
        expect(steps).toHaveLength(6);
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
