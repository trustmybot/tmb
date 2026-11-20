// Which tmb program this is. Channels and versions live side by side on one machine under
// separate names (trustmybot/tmb#89): `tmb` follows stable, `tmb-rc` rc, `tmb-dev` dev, and
// `tmb-<version>` is one exact version that never updates itself. The name is the installed
// file's, so the same build installed under two names is two programs.
import { homedir } from "node:os";
import path from "node:path";

export const CHANNELS = ["dev", "rc", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];

export type Program = {
  /** The program's name: the installed file's name without `.exe`. */
  name: string;
  /** The channel it updates from; null for a program pinned to one version. */
  channel: Channel | null;
};

/** The channel a version follows: its stamp names it. */
export function channelOf(version: string): Channel {
  if (/-dev\./.test(version)) return "dev";
  if (/-rc\./.test(version)) return "rc";
  return "stable";
}

const PINNED_NAME = /^tmb-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;

/** The name a program is installed under: tmb for stable, tmb-rc, tmb-dev, or tmb-<version> when pinned. */
export function programName(channel: Channel, pinnedVersion?: string): string {
  if (pinnedVersion !== undefined) return `tmb-${pinnedVersion}`;
  return channel === "stable" ? "tmb" : `tmb-${channel}`;
}

/**
 * The program an installed file is, from its name. `tmb-rc` and `tmb-dev` follow the channel
 * they name and `tmb-<version>` none. Plain `tmb`, and a name tmb does not know, follow the
 * channel their version names: a stable build for `tmb` as installed, and the channel a build
 * installed as `tmb` before the names were split was on.
 */
export function programOf(file: string | null, version: string): Program {
  if (file === null) return { name: "tmb", channel: channelOf(version) };
  const name = path.basename(file).replace(/\.exe$/i, "");
  if (name === "tmb-rc") return { name, channel: "rc" };
  if (name === "tmb-dev") return { name, channel: "dev" };
  if (PINNED_NAME.test(name)) return { name, channel: null };
  return { name, channel: channelOf(version) };
}

/**
 * Whether Bun's entry point is a compiled tmb's embedded file rather than a source file. Compiled,
 * it is /$bunfs/root/... on macOS and Linux and B:/~BUN/root/... on Windows (seen with either slash).
 */
export function isCompiledEntry(main: string): boolean {
  return /^(?:\/\$bunfs\/|[A-Z]:[\\/]~BUN[\\/])/i.test(main);
}

/** The program that is running: the installed file's, or plain tmb when run from source. */
export function runningProgram(version: string): Program {
  return programOf(isCompiledEntry(Bun.main) ? process.execPath : null, version);
}

/** How a program describes itself: its name, version and what it follows. */
export function describeProgram(program: Program, version: string): string {
  return `${program.name} ${version}, ${program.channel === null ? "pinned: it never updates itself" : `on the ${program.channel} channel`}`;
}

/**
 * Where a program keeps its machine-wide state: the updater's, and the person's feedback
 * setting. One folder per program, so each channel's program keeps its own. TMB_STATE_DIR
 * names it instead.
 */
export function programStateDir(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.TMB_STATE_DIR) return env.TMB_STATE_DIR;
  const home = env.HOME || env.USERPROFILE || homedir();
  const root = platform === "win32" ? env.LOCALAPPDATA || path.join(home, "AppData", "Local") : env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(root, name);
}
