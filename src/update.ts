// Pushed updates: an install follows the channel its version names, looks for a newer build
// there when a session starts, keeps a verified copy next to it, and swaps it in only when
// no tmb session is running and no task is open, so no session or task ever mixes versions.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { openProjectStore } from "./engine/project.ts";

export const CHANNELS = ["dev", "rc", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];

const DEFAULT_RELEASES_URL = "https://github.com/trustmybot/tmb-releases";
const DEFAULT_RELEASES_API = "https://api.github.com/repos/trustmybot/tmb-releases";
/** A session start looks for an update at most this often. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const RC_TAG = /^v(\d+\.\d+\.\d+-rc\.\d+)$/;
const IS_WINDOWS = process.platform === "win32";

/** The channel a version follows: its stamp names it. */
export function channelOf(version: string): Channel {
  if (/-dev\./.test(version)) return "dev";
  if (/-rc\./.test(version)) return "rc";
  return "stable";
}

type Parsed = { core: number[]; pre: (number | string)[] };

function parseVersion(version: string): Parsed | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  };
}

/** Semantic-version order: negative when a is older than b. A version that does not parse sorts oldest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!;
  // A release sorts after its prereleases.
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The release file for this machine, as the release repo names it. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  // Only an x64 Windows build is published; Windows on Arm runs it under emulation.
  const cpu = os === "windows" ? "x64" : arch;
  return `tmb-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

export type UpdaterOptions = {
  /** The version this tmb is. */
  version: string;
  /** The installed file an update replaces; null when tmb runs from source and never updates. */
  target: string | null;
  /** Where the updater keeps its state: the last check, the kept build and the session leases. */
  stateDir: string;
  releasesUrl: string;
  releasesApi: string;
  /** False when the Human turned updates off. */
  enabled: boolean;
};

/** The updater's settings from the environment, for the tmb that is running. */
export function updaterOptions(version: string, compiled: boolean, env: NodeJS.ProcessEnv = process.env): UpdaterOptions {
  const home = env.HOME || env.USERPROFILE || homedir();
  const stateRoot = IS_WINDOWS ? env.LOCALAPPDATA || path.join(home, "AppData", "Local") : env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return {
    version,
    // TMB_UPDATE_FILE names the file to update in place of the running executable, for a run from source.
    target: env.TMB_UPDATE_FILE || (compiled ? process.execPath : null),
    stateDir: env.TMB_STATE_DIR || path.join(stateRoot, "tmb"),
    releasesUrl: (env.TMB_RELEASES_URL || DEFAULT_RELEASES_URL).replace(/\/+$/, ""),
    releasesApi: (env.TMB_RELEASES_API || DEFAULT_RELEASES_API).replace(/\/+$/, ""),
    enabled: env.TMB_NO_UPDATE !== "1",
  };
}

type Staged = { version: string; channel: Channel; file: string; sha256: string };
export type Release = { version: string; base: string };

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  renameSync(temp, file);
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "tmb-updater", accept: "application/vnd.github+json, text/plain, */*" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

export class Updater {
  constructor(readonly options: UpdaterOptions) {}

  get channel(): Channel {
    return channelOf(this.options.version);
  }

  private file(name: string): string {
    return path.join(this.options.stateDir, name);
  }

  private get leaseDir(): string {
    return this.file("sessions");
  }

  /** False when this tmb cannot update itself: run from source, or updates turned off. */
  get active(): boolean {
    return this.options.enabled && this.options.target !== null;
  }

  /** The newest build on this install's channel. dev and stable are plain downloads; rc's newest tag is read from the public releases API. */
  async latest(signal?: AbortSignal): Promise<Release> {
    const { releasesUrl, releasesApi } = this.options;
    if (this.channel === "rc") {
      const releases = JSON.parse(await fetchText(`${releasesApi}/releases?per_page=100`, signal)) as { tag_name: string; draft: boolean }[];
      let newest: string | null = null;
      for (const release of releases) {
        const match = RC_TAG.exec(release.tag_name);
        if (match && !release.draft && (newest === null || compareVersions(match[1]!, newest) > 0)) newest = match[1]!;
      }
      if (newest === null) throw new Error("the rc channel has no release yet");
      return { version: newest, base: `${releasesUrl}/releases/download/v${newest}` };
    }
    const base = this.channel === "dev" ? `${releasesUrl}/releases/download/dev` : `${releasesUrl}/releases/latest/download`;
    const version = (await fetchText(`${base}/VERSION`, signal)).trim();
    if (!parseVersion(version)) throw new Error(`the ${this.channel} channel names no version: ${JSON.stringify(version.slice(0, 80))}`);
    return { version, base };
  }

  /**
   * Whether `version` replaces this tmb. dev is one rolling release, and its count restarts
   * at each stable tag, so any other dev build replaces this one; rc and stable move only up.
   */
  private replaces(version: string): boolean {
    return this.channel === "dev" ? version !== this.options.version : compareVersions(version, this.options.version) > 0;
  }

  /** The verified build kept for the next swap, when there is one that replaces this tmb. */
  staged(): Staged | null {
    const staged = readJson<Staged>(this.file("staged.json"));
    if (!staged || !existsSync(staged.file) || staged.channel !== this.channel) return null;
    return this.replaces(staged.version) ? staged : null;
  }

  /**
   * Looks for a newer build on the channel and, when there is one, downloads it, checks it
   * against the release's checksums and keeps it for the next swap. Unless `force`, does
   * nothing when the last look was less than an hour ago. Never throws: with no network,
   * tmb runs the version it has.
   */
  async check(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<{ outcome: "off" | "skipped" | "current" | "staged" | "failed"; version?: string; error?: string }> {
    if (!this.active) return { outcome: "off" };
    const last = readJson<{ at: string }>(this.file("check.json"));
    if (!options.force && last && Date.now() - Date.parse(last.at) < CHECK_INTERVAL_MS) return { outcome: "skipped" };
    try {
      const release = await this.latest(options.signal);
      const kept = this.staged();
      let outcome: { outcome: "current" | "staged"; version: string };
      if (!this.replaces(release.version)) outcome = { outcome: "current", version: release.version };
      else if (kept && kept.version === release.version) outcome = { outcome: "staged", version: kept.version };
      else {
        await this.download(release, options.signal);
        outcome = { outcome: "staged", version: release.version };
      }
      // Only a finished look counts toward the hour: one cut short by a session's end is tried again.
      writeJson(this.file("check.json"), { at: new Date().toISOString(), channel: this.channel });
      return outcome;
    } catch (error) {
      return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async download(release: Release, signal?: AbortSignal): Promise<void> {
    const asset = assetName();
    const sums = await fetchText(`${release.base}/SHA256SUMS`, signal);
    const expected = sums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1]?.replace(/^\*/, "") === asset)?.[0]
      ?.toLowerCase();
    if (!expected) throw new Error(`no checksum for ${asset} in ${release.base}/SHA256SUMS`);
    const response = await fetch(`${release.base}/${asset}`, {
      headers: { "user-agent": "tmb-updater" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${release.base}/${asset} answered ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch for ${asset} ${release.version}: expected ${expected}, got ${actual}`);
    const dir = this.file("staged");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, asset);
    writeFileSync(file, bytes);
    if (!IS_WINDOWS) chmodSync(file, 0o755);
    writeJson(this.file("staged.json"), { version: release.version, channel: this.channel, file, sha256: actual } satisfies Staged);
  }

  // --- sessions and projects ------------------------------------------------------------

  /** Marks a session as running in `projectDir` until `endSession`, and remembers the project. */
  startSession(projectDir: string, pid: number = process.pid): void {
    writeJson(path.join(this.leaseDir, `${pid}.json`), { pid, project: projectDir, startedAt: new Date().toISOString() });
    const projects = new Set(readJson<string[]>(this.file("projects.json")) ?? []);
    if (!projects.has(projectDir)) writeJson(this.file("projects.json"), [...projects, projectDir].sort());
  }

  endSession(pid: number = process.pid): void {
    rmSync(path.join(this.leaseDir, `${pid}.json`), { force: true });
  }

  /** Projects of the tmb sessions still running, other than the one of process `except`. Leases of ended processes are cleared. */
  liveSessions(except: number = process.pid): string[] {
    if (!existsSync(this.leaseDir)) return [];
    const live: string[] = [];
    for (const name of readdirSync(this.leaseDir)) {
      const lease = readJson<{ pid: number; project: string }>(path.join(this.leaseDir, name));
      if (!lease || typeof lease.pid !== "number") continue;
      if (lease.pid === except) continue;
      if (isRunning(lease.pid)) live.push(lease.project);
      else rmSync(path.join(this.leaseDir, name), { force: true });
    }
    return live;
  }

  /** Projects tmb has served that hold an open task. A project whose record is gone is forgotten. */
  projectsWithOpenTasks(): string[] {
    const projects = readJson<string[]>(this.file("projects.json")) ?? [];
    const busy: string[] = [];
    const kept: string[] = [];
    for (const project of projects) {
      const opened = openProjectStore(project, { create: false });
      if (!opened.ok) {
        // A record made by a newer tmb may still hold open tasks: keep the project and wait.
        if (opened.error.failure !== "missing") {
          kept.push(project);
          busy.push(project);
        }
        continue;
      }
      kept.push(project);
      try {
        if (opened.store.listTasks("open").length > 0) busy.push(project);
      } finally {
        opened.store.close();
      }
    }
    if (kept.length !== projects.length) writeJson(this.file("projects.json"), kept);
    return busy;
  }

  /**
   * Swaps the kept build in for the installed file, only between sessions: when no other
   * tmb session is running and no project holds an open task. The swap is a rename, so a
   * process still running the old file keeps it until it ends.
   */
  apply(except: number = process.pid): { outcome: "off" | "none" | "waiting" | "applied" | "failed"; version?: string; reason?: string } {
    if (!this.active) return { outcome: "off" };
    const staged = this.staged();
    if (!staged) return { outcome: "none" };
    const sessions = this.liveSessions(except);
    if (sessions.length > 0) return { outcome: "waiting", version: staged.version, reason: `a tmb session is running in ${sessions[0]}` };
    const busy = this.projectsWithOpenTasks();
    if (busy.length > 0) return { outcome: "waiting", version: staged.version, reason: `a task is open in ${busy[0]}` };
    const target = this.options.target!;
    try {
      const actual = createHash("sha256").update(readFileSync(staged.file)).digest("hex");
      if (actual !== staged.sha256) throw new Error("the kept build no longer matches its checksum");
      // Copied next to the target first, so the last step is a rename within one folder.
      const next = `${target}.new`;
      copyFileSync(staged.file, next);
      if (!IS_WINDOWS) chmodSync(next, 0o755);
      if (IS_WINDOWS && existsSync(target)) {
        // A running .exe cannot be replaced on Windows, but it can be renamed out of the way.
        const old = `${target}.old`;
        rmSync(old, { force: true });
        renameSync(target, old);
      }
      renameSync(next, target);
      rmSync(path.dirname(staged.file), { recursive: true, force: true });
      rmSync(this.file("staged.json"), { force: true });
      return { outcome: "applied", version: staged.version };
    } catch (error) {
      return { outcome: "failed", version: staged.version, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Removes what an earlier swap left: the old Windows executable, once it no longer runs. */
  tidy(): void {
    const target = this.options.target;
    if (!target) return;
    for (const leftover of [`${target}.old`, `${target}.new`]) {
      try {
        if (statSync(leftover, { throwIfNoEntry: false })) rmSync(leftover, { force: true });
      } catch {
        // Still running on Windows: removed after a later start.
      }
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
