// Pushed updates: a program follows its own channel (program.ts), looks for a newer build
// there when a session starts, keeps a verified copy next to it, and swaps it in at once
// (trustmybot/tmb#159). A running session keeps the build it started with: the replaced build
// is kept under its version, and every tmb call in that session's project is handed over to it
// until the session moves to the new build or ends.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isProcessRunning, type KeptBuild, keptBuilds } from "../builds.ts";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { type Channel, channelOf, openProjectStore, type Program, programOf, programStateDir } from "../../engine/index.ts";

export { type Channel, channelOf, CHANNELS, isCompiledEntry } from "../../engine/index.ts";

const DEFAULT_RELEASES_URL = "https://github.com/trustmybot/tmb-releases";
const DEFAULT_RELEASES_API = "https://api.github.com/repos/trustmybot/tmb-releases";
/** A session start looks for an update at most this often. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const RC_TAG = /^v(\d+\.\d+\.\d+-rc\.\d+)$/;
const IS_WINDOWS = process.platform === "win32";

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
  /** The program this tmb is, named by its installed file; worked out from `target` when not given. */
  program?: Program;
  /**
   * True in a kept build an installed one handed a call over to: it serves a pinned project and
   * never updates the installed file itself. `target` is then the installed file.
   */
  handedOver?: boolean;
};

/** Set on a call the installed tmb hands over to a kept build, so it is handed over only once. */
export const HANDED_OVER_VARIABLE = "TMB_HANDED_OVER";
/** The installed file, for a kept build serving a handed-over call. */
export const INSTALLED_FILE_VARIABLE = "TMB_INSTALLED_FILE";

/** The updater's settings from the environment, for the tmb that is running. */
export function updaterOptions(version: string, compiled: boolean, env: NodeJS.ProcessEnv = process.env): UpdaterOptions {
  // TMB_UPDATE_FILE names the file to update in place of the running executable, for a run from source.
  const handedOver = env[HANDED_OVER_VARIABLE] === "1" && Boolean(env[INSTALLED_FILE_VARIABLE]);
  const target = env.TMB_UPDATE_FILE || (handedOver ? env[INSTALLED_FILE_VARIABLE]! : compiled ? process.execPath : null);
  const program = programOf(target, version);
  return {
    version,
    target,
    program,
    handedOver,
    // Each program keeps its own machine-wide state, so one never swaps another's build in.
    stateDir: programStateDir(program.name, env),
    releasesUrl: (env.TMB_RELEASES_URL || DEFAULT_RELEASES_URL).replace(/\/+$/, ""),
    releasesApi: (env.TMB_RELEASES_API || DEFAULT_RELEASES_API).replace(/\/+$/, ""),
    enabled: env.TMB_NO_UPDATE !== "1",
  };
}

/**
 * A running session, one per tool server process: its project, the build it runs, and how the
 * Human knows it: the folder, the title they gave it, and when it started.
 */
export type Lease = {
  pid: number;
  project: string;
  startedAt: string;
  /** The version of the build the session runs, as `tmb doctor` reads it (src/cli/builds.ts); a lease written before trustmybot/tmb#159 names none. */
  build?: string;
  /** The title the Human gave the session, when the host passes it. */
  title?: string | null;
  /** The processes above the tool server, nearest first, so a hook of the same session can find it. */
  ancestors?: number[];
  /** Why the session could not move to the installed build, when it tried and failed. */
  moveError?: string | null;
};

/** A kept build. `from` is the version that kept it: a reinstall of another version drops it. */
type Staged = { version: string; channel: Channel; from: string; file: string; sha256: string };

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
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
  readonly program: Program;

  constructor(readonly options: UpdaterOptions) {
    this.program = options.program ?? programOf(options.target, options.version);
  }

  /** The channel this program updates from; a pinned one reports its version's, and never updates. */
  get channel(): Channel {
    return this.program.channel ?? channelOf(this.options.version);
  }

  /** True for a program pinned to one version: tmb-<version>. */
  get pinned(): boolean {
    return this.program.channel === null;
  }

  private file(name: string): string {
    return path.join(this.options.stateDir, name);
  }

  private get leaseDir(): string {
    return this.file("sessions");
  }

  /** False when this tmb cannot update itself: run from source, pinned to one version, updates turned off, or a kept build serving a handed-over call. */
  get active(): boolean {
    return this.options.enabled && this.options.target !== null && !this.pinned && this.options.handedOver !== true;
  }

  /** True when this tmb keeps sessions and builds: an install that updates itself, or a kept build serving a handed-over call. */
  get tracksSessions(): boolean {
    return this.options.enabled && this.options.target !== null && !this.pinned;
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

  /**
   * The verified build kept for the next swap, when this tmb kept it and it replaces this tmb.
   * One kept by another installed version, such as before a reinstall, is never swapped in.
   */
  staged(): Staged | null {
    const staged = readJson<Staged>(this.file("staged.json"));
    if (!staged || !existsSync(staged.file) || staged.channel !== this.channel || staged.from !== this.options.version) return null;
    return this.replaces(staged.version) ? staged : null;
  }

  private discardStaged(): void {
    rmSync(this.file("staged.json"), { force: true });
    rmSync(this.file("staged"), { recursive: true, force: true });
  }

  /**
   * Runs `work` holding the updater's lock, so keeping a build and swapping it in never
   * overlap, across processes. Returns null, without running it, while another live process
   * holds the lock; a lock left by an ended process is taken over.
   */
  private withLock<T>(work: () => T): T | null {
    const lock = this.file("update.lock");
    mkdirSync(this.options.stateDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd: number;
      try {
        fd = openSync(lock, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = Number.parseInt(readFileSafe(lock), 10);
        if (Number.isInteger(holder) && isRunning(holder)) return null;
        rmSync(lock, { force: true });
        continue;
      }
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      try {
        return work();
      } finally {
        rmSync(lock, { force: true });
      }
    }
    return null;
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
    const result = await this.look(options.signal);
    // The outcome of the last look, for `tmb update` and for anyone finding out why nothing was kept.
    try {
      writeJson(this.file("last-check.json"), { at: new Date().toISOString(), version: this.options.version, ...result });
    } catch {
      // Best effort: a state folder that cannot be written fails the next step anyway.
    }
    return result;
  }

  private async look(signal?: AbortSignal): Promise<{ outcome: "current" | "staged" | "failed"; version?: string; error?: string }> {
    const options = { signal };
    try {
      const release = await this.latest(options.signal);
      const kept = this.staged();
      let outcome: { outcome: "current" | "staged"; version: string };
      if (!this.replaces(release.version)) {
        // Nothing on the channel replaces this tmb, so no kept build should either.
        this.withLock(() => this.discardStaged());
        outcome = { outcome: "current", version: release.version };
      } else if (kept && kept.version === release.version && sha256Of(kept.file) === kept.sha256) {
        outcome = { outcome: "staged", version: kept.version };
      } else {
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
    const kept = this.withLock(() => {
      this.discardStaged();
      const dir = this.file("staged");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, asset);
      // Written under another name and renamed, so a cut-short write is never taken for the build.
      writeFileSync(`${file}.part`, bytes);
      if (!IS_WINDOWS) chmodSync(`${file}.part`, 0o755);
      renameSync(`${file}.part`, file);
      writeJson(this.file("staged.json"), { version: release.version, channel: this.channel, from: this.options.version, file, sha256: actual } satisfies Staged);
      return true;
    });
    if (kept === null) throw new Error("another tmb is updating; trying again later");
  }

  // --- sessions, projects and kept builds ---------------------------------------------

  /** Marks a session as running in `projectDir` on build `version` (this tmb's unless given) until `endSession`, and remembers the project. */
  startSession(projectDir: string, pid: number = process.pid, info: { build?: string; ancestors?: number[] } = {}): void {
    const lease: Lease = { pid, project: projectDir, startedAt: new Date().toISOString(), build: info.build ?? this.options.version, title: null, ancestors: info.ancestors ?? [], moveError: null };
    writeJson(path.join(this.leaseDir, `${pid}.json`), lease);
    // One file per project, so sessions starting together never lose one another's project.
    const name = createHash("sha256").update(projectDir).digest("hex").slice(0, 32);
    writeJson(path.join(this.file("projects"), `${name}.json`), { project: projectDir });
  }

  /** Changes a running session's lease: the build it moved to, its title, why a move failed. */
  updateSession(pid: number, change: Partial<Omit<Lease, "pid" | "project" | "startedAt">>): void {
    const file = path.join(this.leaseDir, `${pid}.json`);
    const lease = readJson<Lease>(file);
    if (lease) writeJson(file, { ...lease, ...change });
  }

  endSession(pid: number = process.pid): void {
    rmSync(path.join(this.leaseDir, `${pid}.json`), { force: true });
  }

  /** The tmb sessions still running, other than the one of process `except`. Leases of ended processes are cleared. */
  leases(except: number = process.pid): Lease[] {
    if (!existsSync(this.leaseDir)) return [];
    const live: Lease[] = [];
    for (const name of readdirSync(this.leaseDir)) {
      const lease = readJson<Lease>(path.join(this.leaseDir, name));
      if (!lease || typeof lease.pid !== "number") continue;
      if (lease.pid === except) continue;
      if (isRunning(lease.pid)) live.push(lease);
      else rmSync(path.join(this.leaseDir, name), { force: true });
    }
    return live;
  }

  /** Projects of the tmb sessions still running, other than the one of process `except`. */
  liveSessions(except: number = process.pid): string[] {
    return this.leases(except).map((lease) => lease.project);
  }

  /**
   * The build a running session pins `projectDir` to, when it is not this tmb's: every tmb call
   * there runs that build until the session moves or ends. Null when nothing pins it.
   */
  pinOf(projectDir: string): string | null {
    const project = path.resolve(projectDir);
    const lease = this.leases().find((candidate) => path.resolve(candidate.project) === project && (candidate.build ?? this.options.version) !== this.options.version);
    return lease?.build ?? null;
  }

  /** Where the build of `version` is kept while sessions run it, under the program's own name. */
  keptFile(version: string): string {
    return path.join(this.file("builds"), version, `${this.program.name}${IS_WINDOWS ? ".exe" : ""}`);
  }

  /** The builds kept on disk, with their size and the running sessions that use each (src/cli/builds.ts). */
  keptBuilds(): KeptBuild[] {
    return keptBuilds(this.options.stateDir, isRunning);
  }

  /** True when `projectDir` has an open task; a record this tmb cannot open has none it can see. */
  hasOpenTask(projectDir: string): boolean {
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) return false;
    try {
      return opened.store.listTasks("open").length > 0;
    } finally {
      opened.store.close();
    }
  }

  /**
   * The sessions still on a build other than the installed `version`, each with why: a task is
   * open, a move failed, or it moves at its next tool call.
   */
  waiting(version: string): { lease: Lease; reason: string }[] {
    return this.leases(-1)
      .filter((lease) => lease.build !== undefined && lease.build !== version)
      .map((lease) => ({
        lease,
        reason: lease.moveError
          ? `it could not move: ${lease.moveError}`
          : this.hasOpenTask(lease.project)
            ? "a task is open there; it moves once the task closes"
            : "it moves at its next tool call",
      }));
  }

  /** Copies the installed file aside as the build of `version`, for sessions still running it. */
  private keepInstalled(version: string): void {
    const kept = this.keptFile(version);
    if (existsSync(kept)) return;
    mkdirSync(path.dirname(kept), { recursive: true });
    const part = `${kept}.${process.pid}.part`;
    copyFileSync(this.options.target!, part);
    if (!IS_WINDOWS) chmodSync(part, 0o755);
    renameSync(part, kept);
  }

  /**
   * Swaps the kept build in for the installed file at once, whatever is running. A session still
   * running this build keeps it: the installed file is first copied aside under its version, and
   * the swap is a rename, so a process still running the old file keeps it until it ends.
   */
  apply(except: number = process.pid): { outcome: "off" | "none" | "waiting" | "applied" | "failed"; version?: string; reason?: string } {
    if (!this.active) return { outcome: "off" };
    const staged = this.staged();
    if (!staged) return { outcome: "none" };
    const target = this.options.target!;
    const swapped = this.withLock(() => {
      // Copied next to the target first, under a name of this process's own, and checked there,
      // so the last step is a rename within one folder of exactly the verified bytes.
      const next = `${target}.${process.pid}.new`;
      try {
        copyFileSync(staged.file, next);
        if (sha256Of(next) !== staged.sha256) {
          this.discardStaged();
          throw new Error("the kept build no longer matches its checksum; it is dropped and downloaded again");
        }
        if (!IS_WINDOWS) chmodSync(next, 0o755);
        // A session still on this build keeps running it, from the kept copy.
        if (this.leases(except).some((lease) => (lease.build ?? this.options.version) === this.options.version)) this.keepInstalled(this.options.version);
        const old = `${target}.old`;
        const movedAside = IS_WINDOWS && existsSync(target);
        if (movedAside) {
          // A running .exe cannot be replaced on Windows, but it can be renamed out of the way.
          rmSync(old, { force: true });
          renameSync(target, old);
        }
        try {
          renameSync(next, target);
        } catch (error) {
          if (movedAside) renameSync(old, target);
          throw error;
        }
        this.discardStaged();
        return { outcome: "applied" as const, version: staged.version };
      } catch (error) {
        return { outcome: "failed" as const, version: staged.version, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        rmSync(next, { force: true });
      }
    });
    return swapped ?? { outcome: "waiting", version: staged.version, reason: "another tmb is updating" };
  }

  /** Removes what an earlier swap left: the old Windows executable once it no longer runs, and copies of ended swaps. */
  tidy(): void {
    const target = this.options.target;
    if (!target) return;
    const base = path.basename(target);
    const copies = (readdirSafe(path.dirname(target)))
      .map((entry) => ({ entry, pid: entry.startsWith(`${base}.`) && entry.endsWith(".new") ? Number(entry.slice(base.length + 1, -4)) : NaN }))
      .filter(({ pid }) => Number.isInteger(pid) && pid !== process.pid && !isRunning(pid))
      .map(({ entry }) => path.join(path.dirname(target), entry));
    for (const leftover of [`${target}.old`, ...copies]) {
      try {
        if (statSync(leftover, { throwIfNoEntry: false })) rmSync(leftover, { force: true });
      } catch {
        // Still running on Windows: removed after a later start.
      }
    }
  }
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const isRunning = isProcessRunning;

/**
 * The version of the tmb installed at `file`, as it reports it; null when it cannot say. Asked
 * again only when the file changes.
 */
const installedVersions = new Map<string, { stamp: string; version: string | null }>();
export function installedVersionOf(file: string): string | null {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const known = installedVersions.get(file);
  if (known && known.stamp === stamp) return known.version;
  // Asked as a handed-over call, so the installed tmb answers for itself and hands nothing over.
  const result = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, [HANDED_OVER_VARIABLE]: "1", [INSTALLED_FILE_VARIABLE]: file } });
  const version = result.status === 0 ? (result.stdout.trim().split(/\s+/)[1] ?? null) : null;
  installedVersions.set(file, { stamp, version });
  return version;
}
