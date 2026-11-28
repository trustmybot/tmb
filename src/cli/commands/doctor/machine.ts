// The machine's checks: the program, its kept builds, its update, its sessions and its state
// folder (trustmybot/tmb#160). Each reads only; a fix runs only after the Human's yes.
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { formatBytes, keptBuilds, sessionEntries } from "../../builds.ts";
import { CHANNELS, programName } from "../../../engine/index.ts";
import type { DoctorEnv, Finding } from "./types.ts";

const INSTALLER = {
  unix: "https://github.com/trustmybot/tmb-releases/releases/download/dev/install.sh",
  windows: "https://github.com/trustmybot/tmb-releases/releases/download/dev/install.ps1",
};

const finding = (check: string, rest: Omit<Finding, "check" | "scope">): Finding => ({ check, scope: "machine", ...rest });

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Looks a program up on `searchPath`, as a shell would; null when none of its folders holds it. */
export function whichOn(name: string, searchPath: string, platform: NodeJS.Platform): string | null {
  const names = platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of searchPath.split(path.delimiter).filter((part) => part !== "")) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      const stat = statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      if (platform !== "win32") {
        try {
          accessSync(file, constants.X_OK);
        } catch {
          continue;
        }
      }
      return file;
    }
  }
  return null;
}

/** The step that installs this program again, so the one on the PATH is it. */
export function installStep(env: DoctorEnv): string {
  const pinned = env.program.channel === null ? env.version : null;
  const channel = env.program.channel ?? "stable";
  if (env.platform === "win32") {
    const vars = [`$env:TMB_CHANNEL = '${channel}'`, ...(pinned ? [`$env:TMB_INSTALL_VERSION = '${pinned}'`] : [])].join("; ");
    return `${vars}; irm ${INSTALLER.windows} | iex`;
  }
  const vars = [`TMB_CHANNEL=${channel}`, ...(pinned ? [`TMB_INSTALL_VERSION=${pinned}`] : [])].join(" ");
  return `curl -fsSL ${INSTALLER.unix} | ${vars} sh`;
}

function programCheck(env: DoctorEnv): Finding {
  const name = env.program.name;
  const follows = env.program.channel === null ? "pinned to this version" : `on the ${env.program.channel} channel`;
  if (env.installed === null) return finding("program", { status: "ok", summary: `${name} ${env.version}, ${follows}, runs from source` });
  const where = `${name} ${env.version}, ${follows}, installed at ${env.installed}`;
  const onPath = whichOn(name, env.path, env.platform);
  if (onPath === null) {
    return finding("program", {
      status: "warn",
      summary: `${where}; no ${name} is on the PATH, so hosts and git cannot run it by name`,
      fix: { say: `add ${path.dirname(env.installed)} to your PATH, or install it again: ${installStep(env)}` },
    });
  }
  if (real(onPath) !== real(env.installed)) {
    return finding("program", {
      status: "warn",
      summary: `${where}; the ${name} on the PATH is another file, ${onPath}`,
      fix: { say: `install it again, so one ${name} is on the PATH: ${installStep(env)}` },
    });
  }
  return finding("program", { status: "ok", summary: `${where}; it is the ${name} on the PATH` });
}

function sessionsNamed(projects: string[]): string {
  const unique = [...new Set(projects)];
  return unique.length === 1 ? `a session in ${unique[0]}` : `${projects.length} sessions, in ${unique.join(", ")}`;
}

function oldBuildChecks(env: DoctorEnv): Finding[] {
  const builds = keptBuilds(env.stateDir, env.isRunning).filter((build) => build.version !== env.version);
  if (builds.length === 0) return [finding("old builds", { status: "ok", summary: "no old build is kept on disk" })];
  return builds.map((build) => {
    const size = formatBytes(build.bytes);
    if (build.usedBy.length > 0) {
      return finding("old builds", { status: "ok", summary: `${env.program.name} ${build.version} (${size}) is kept: ${sessionsNamed(build.usedBy.map((entry) => entry.project))} still uses it` });
    }
    return finding("old builds", {
      status: "warn",
      summary: `${env.program.name} ${build.version} (${size}) is kept on disk and no session uses it`,
      fix: {
        say: `delete it with \`${env.program.name} doctor --fix\``,
        ask: `Delete the old build ${env.program.name} ${build.version} (${size}) at ${build.dir}?`,
        apply: () => {
          // Asked again at the moment of deleting: a session may have started on it since.
          const now = keptBuilds(env.stateDir, env.isRunning).find((kept) => kept.version === build.version);
          if (now && now.usedBy.length > 0) return `Kept ${build.version}: ${sessionsNamed(now.usedBy.map((entry) => entry.project))} started on it meanwhile.`;
          rmSync(build.dir, { recursive: true, force: true });
          return `Deleted the old build ${build.version} (${size}).`;
        },
      },
    });
  });
}

type Staged = { version?: unknown; from?: unknown; file?: unknown };
type LastCheck = { at?: unknown; outcome?: unknown; error?: unknown };

const DAY_MS = 24 * 60 * 60 * 1000;

/** A build's number on its channel: the N of 0.1.0-dev.N, with the version before it. */
function buildNumber(version: string): { line: string; n: number } | null {
  const found = /^(.*-[0-9A-Za-z]+)\.(\d+)$/.exec(version);
  return found === null ? null : { line: found[1]!, n: Number(found[2]) };
}

/**
 * How far the installed build is behind the newer one, in builds when both are numbered on one
 * line, and in days between the two files' arrival (trustmybot/tmb#257); null when neither is known.
 */
export function howFarBehind(installed: string, newer: string, installedFile: string, newerFile: string): string | null {
  const parts: string[] = [];
  const from = buildNumber(installed);
  const to = buildNumber(newer);
  if (from !== null && to !== null && from.line === to.line && to.n > from.n) parts.push(`${to.n - from.n} build${to.n - from.n === 1 ? "" : "s"}`);
  try {
    const days = Math.floor((statSync(newerFile).mtimeMs - statSync(installedFile).mtimeMs) / DAY_MS);
    if (days >= 1) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  } catch {
    // A file that cannot be read gives no days.
  }
  return parts.length === 0 ? null : `${parts.join(" and ")} behind`;
}

function updateCheck(env: DoctorEnv): Finding[] {
  const name = env.program.name;
  if (env.installed === null || env.program.channel === null) {
    return [finding("update", { status: "ok", summary: env.installed === null ? "runs from source and does not update itself" : `${name} is pinned to ${env.version} and never updates itself` })];
  }
  const findings: Finding[] = [];
  const staged = readJson<Staged>(path.join(env.stateDir, "staged.json"));
  const file = typeof staged?.file === "string" ? staged.file : null;
  if (staged && typeof staged.version === "string" && file !== null && existsSync(file) && staged.version !== env.version) {
    if (staged.from !== env.version) {
      findings.push(finding("update", {
        status: "warn",
        summary: `${name} ${staged.version} is downloaded, but ${typeof staged.from === "string" ? staged.from : "another version"} downloaded it, so it never applies to ${env.version}`,
        fix: { say: `\`${name} update\` looks again and keeps the right one` },
      }));
    } else {
      const others = sessionEntries(env.stateDir).filter((entry) => entry.pid !== process.pid && env.isRunning(entry.pid));
      const why = others.length > 0 ? `${sessionsNamed(others.map((entry) => entry.project))} is running` : "no session has ended since it was downloaded";
      const behind = howFarBehind(env.version, staged.version, env.installed, file);
      findings.push(finding("update", {
        status: "warn",
        summary: `${name} ${staged.version} is downloaded and not applied yet${behind === null ? "" : `; the installed ${env.version} is ${behind}`}: ${why}`,
        ...(others.length > 0 ? { details: others.map((entry) => `held by process ${entry.pid}, in ${entry.project}${entry.startedAt ? `, started ${entry.startedAt}` : ""}`) } : {}),
        fix: { say: `\`${name} update\`` },
      }));
    }
  }
  const last = readJson<LastCheck>(path.join(env.stateDir, "last-check.json"));
  if (last?.outcome === "failed") {
    findings.push(finding("update", {
      status: "warn",
      summary: `the last look for an update${typeof last.at === "string" ? `, at ${last.at},` : ""} failed: ${typeof last.error === "string" ? last.error : "no reason kept"}`,
      fix: { say: `\`${name} update\` looks again now` },
    }));
  }
  if (findings.length === 0) findings.push(finding("update", { status: "ok", summary: "no downloaded update is waiting" }));
  return findings;
}

function staleSessionsCheck(env: DoctorEnv): Finding {
  const stale = sessionEntries(env.stateDir).filter((entry) => !env.isRunning(entry.pid));
  if (stale.length === 0) return finding("session entries", { status: "ok", summary: "every session entry names a running process" });
  return finding("session entries", {
    status: "warn",
    summary: `${stale.length} session entr${stale.length === 1 ? "y names a process" : "ies name processes"} that ended`,
    details: stale.map((entry) => `process ${entry.pid}, in ${entry.project}${entry.startedAt ? `, started ${entry.startedAt}` : ""}`),
    fix: {
      say: `remove them with \`${env.program.name} doctor --fix\``,
      ask: `Remove ${stale.length} session entr${stale.length === 1 ? "y" : "ies"} of ended processes?`,
      apply: () => {
        const gone = stale.filter((entry) => !env.isRunning(entry.pid));
        for (const entry of gone) rmSync(entry.file, { force: true });
        return `Removed ${gone.length} session entr${gone.length === 1 ? "y" : "ies"}.`;
      },
    },
  });
}

/** Files an update that stopped half-way left: copies of ended swaps, a lock of an ended process, cut-short downloads and writes. */
export function updateLeftovers(env: DoctorEnv): string[] {
  const left: string[] = [];
  const pidOf = (text: string) => (/^\d+$/.test(text) ? Number(text) : NaN);
  if (env.installed !== null) {
    const dir = path.dirname(env.installed);
    const base = path.basename(env.installed);
    if (existsSync(`${env.installed}.old`)) left.push(`${env.installed}.old`);
    for (const entry of readdirSafe(dir)) {
      if (!entry.startsWith(`${base}.`) || !entry.endsWith(".new")) continue;
      const pid = pidOf(entry.slice(base.length + 1, -4));
      if (Number.isInteger(pid) && !env.isRunning(pid)) left.push(path.join(dir, entry));
    }
  }
  const lock = path.join(env.stateDir, "update.lock");
  if (existsSync(lock)) {
    let holder = NaN;
    try {
      holder = pidOf(readFileSync(lock, "utf8").trim());
    } catch {
      // Unreadable: treated as left over.
    }
    if (!Number.isInteger(holder) || !env.isRunning(holder)) left.push(lock);
  }
  for (const dir of [env.stateDir, path.join(env.stateDir, "sessions"), path.join(env.stateDir, "projects"), path.join(env.stateDir, "staged")]) {
    for (const entry of readdirSafe(dir)) {
      const tmp = /\.(\d+)\.tmp$/.exec(entry);
      if (entry.endsWith(".part") || (tmp && !env.isRunning(Number(tmp[1])))) left.push(path.join(dir, entry));
    }
  }
  return left;
}

function leftoversCheck(env: DoctorEnv): Finding {
  const left = updateLeftovers(env);
  if (left.length === 0) return finding("update leftovers", { status: "ok", summary: "no update stopped half-way" });
  return finding("update leftovers", {
    status: "warn",
    summary: `an update stopped half-way and left ${left.length} file${left.length === 1 ? "" : "s"}`,
    details: left,
    fix: {
      say: `remove them with \`${env.program.name} doctor --fix\``,
      ask: `Remove ${left.length} file${left.length === 1 ? "" : "s"} an update left?`,
      apply: () => {
        const problems: string[] = [];
        for (const file of left) {
          try {
            rmSync(file, { force: true });
          } catch (error) {
            // A Windows program still running cannot be removed: a later start does it.
            problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return problems.length === 0 ? `Removed ${left.length} file${left.length === 1 ? "" : "s"}.` : `Removed ${left.length - problems.length}; kept ${problems.join("; ")}.`;
      },
    },
  });
}

const PINNED = /^tmb-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\.exe)?$/i;

function otherProgramsCheck(env: DoctorEnv): Finding {
  const names = new Set(CHANNELS.map((channel) => programName(channel)));
  for (const dir of env.path.split(path.delimiter).filter((part) => part !== "")) {
    for (const entry of readdirSafe(dir)) if (PINNED.test(entry)) names.add(entry.replace(/\.exe$/i, ""));
  }
  names.delete(env.program.name);
  const lines: string[] = [];
  for (const name of [...names].sort()) {
    const file = whichOn(name, env.path, env.platform);
    if (file === null) continue;
    const answer = env.versionOf(file);
    const version = answer?.split(/\s+/)[1];
    lines.push(`${name} ${version ?? "(did not say its version)"} at ${file}`);
  }
  if (lines.length === 0) return finding("other programs", { status: "ok", summary: "no other tmb program is on the PATH" });
  return finding("other programs", { status: "ok", summary: `${lines.length} other tmb program${lines.length === 1 ? " is" : "s are"} installed side by side`, details: lines });
}

function stateFolderCheck(env: DoctorEnv): Finding {
  const dir = env.stateDir;
  const stat = statSync(dir, { throwIfNoEntry: false });
  const repair = env.platform === "win32" ? `give your user full control of ${dir}` : `chmod u+rwx '${dir}'`;
  if (stat === undefined) {
    let parent = path.dirname(dir);
    while (!existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    try {
      accessSync(parent, constants.W_OK);
      return finding("state folder", { status: "ok", summary: `${dir} is not made yet; tmb makes it when it first needs it` });
    } catch {
      return finding("state folder", { status: "fail", summary: `${dir} does not exist and ${parent} cannot be written, so tmb cannot keep its state`, fix: { say: `make ${dir} and give your user write access to it` } });
    }
  }
  if (!stat.isDirectory()) return finding("state folder", { status: "fail", summary: `${dir} is a file, not a folder`, fix: { say: `move the file ${dir} away; tmb makes the folder again` } });
  try {
    accessSync(dir, constants.R_OK | constants.W_OK | (env.platform === "win32" ? 0 : constants.X_OK));
    return finding("state folder", { status: "ok", summary: `${dir} can be read and written` });
  } catch (error) {
    // EPERM, not EACCES: the folder's own permissions allow it, and something around this
    // process, such as a sandbox, denies it. chmod would change nothing.
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return finding("state folder", {
        status: "fail",
        summary: `${dir} cannot be read and written from here: its permissions allow it, so something around this process, such as a sandbox, denies it`,
        fix: { say: "run tmb outside that sandbox, or allow it to write the folder" },
      });
    }
    return finding("state folder", { status: "fail", summary: `${dir} cannot be read and written by you`, fix: { say: repair } });
  }
}

/** The machine's checks, in the order they print. */
export const MACHINE_CHECKS: { name: string; run: (env: DoctorEnv) => Finding | Finding[] }[] = [
  { name: "program", run: programCheck },
  { name: "old builds", run: oldBuildChecks },
  { name: "update", run: updateCheck },
  { name: "session entries", run: staleSessionsCheck },
  { name: "update leftovers", run: leftoversCheck },
  { name: "other programs", run: otherProgramsCheck },
  { name: "state folder", run: stateFolderCheck },
];
