// Fills in tmb's package-manager manifests from a release, and pushes them to the tap and the
// bucket (trustmybot/tmb#89, Part 3). The templates live in packaging/.
//   bun scripts/package-managers.ts current <version>
//       prints "yes" when <version> is still the newest build on its channel, "no" otherwise
//   bun scripts/package-managers.ts render <version> <SHA256SUMS> <outDir>
//       writes homebrew/Casks/<cask>.rb, scoop/bucket/<program>.json and winget/manifests/...
//   bun scripts/package-managers.ts publish <owner/repo> <dir>
//       copies <dir> into the repo and pushes it, with the token in TMB_PACKAGING_TOKEN; skips,
//       and exits 0, when the token is missing or the repo cannot be reached
// TMB_RELEASES_URL and TMB_RELEASES_API point at another release repo; TMB_PACKAGING_REMOTE
// replaces https://github.com as the base of the repo publish pushes to.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { programName } from "../src/engine/program.ts";
import { channelOf, compareVersions, type Channel, Updater } from "../src/cli/commands/update.ts";

const root = path.resolve(import.meta.dir, "..");
const PACKAGING = path.join(root, "packaging");
const DEFAULT_RELEASES_URL = "https://github.com/trustmybot/tmb-releases";
const DEFAULT_RELEASES_API = "https://api.github.com/repos/trustmybot/tmb-releases";

/** Every release file a manifest names, with the placeholder its checksum fills. */
export const ASSETS = {
  "tmb-darwin-arm64": "SHA256_DARWIN_ARM64",
  "tmb-darwin-x64": "SHA256_DARWIN_X64",
  "tmb-linux-arm64": "SHA256_LINUX_ARM64",
  "tmb-linux-x64": "SHA256_LINUX_X64",
  "tmb-windows-x64.exe": "SHA256_WINDOWS_X64",
} as const;

/** What each channel installs as, so the three sit side by side (trustmybot/tmb#89, Part 2). */
export type Names = { program: string; cask: string; wingetId: string; name: string };

export function namesOf(channel: Channel): Names {
  switch (channel) {
    case "stable":
      return { program: programName("stable"), cask: "tmb", wingetId: "TrustMyBot.tmb", name: "tmb" };
    case "rc":
      return { program: programName("rc"), cask: "tmb@rc", wingetId: "TrustMyBot.tmb.RC", name: "tmb (rc)" };
    case "dev":
      return { program: programName("dev"), cask: "tmb@dev", wingetId: "TrustMyBot.tmb.Dev", name: "tmb (dev)" };
  }
}

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-(?:rc\.\d+|dev\.[0-9A-Za-z.]+))?$/;

/** The release's checksums by file name, from a SHA256SUMS file as `sha256sum` writes it. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

/** Where a release's files are downloaded from. rc and stable are pinned to their tag; dev is one rolling release. */
export function downloadBase(version: string, releasesUrl: string = DEFAULT_RELEASES_URL): string {
  const base = releasesUrl.replace(/\/+$/, "");
  return channelOf(version) === "dev" ? `${base}/releases/download/dev` : `${base}/releases/download/v${version}`;
}

function fill(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`no value for ${whole}`);
    return value;
  });
  return out;
}

function template(name: string): string {
  return readFileSync(path.join(PACKAGING, name), "utf8");
}

/** Every manifest for one release, by its path under the output folder. */
export function renderManifests(version: string, sums: Map<string, string>, releasesUrl?: string): Record<string, string> {
  if (!VERSION_SHAPE.test(version)) throw new Error(`not a tmb release version: ${JSON.stringify(version)}`);
  const channel = channelOf(version);
  const names = namesOf(channel);
  const values: Record<string, string> = {
    VERSION: version,
    CHANNEL: channel,
    PROGRAM: names.program,
    CASK: names.cask,
    WINGET_ID: names.wingetId,
    NAME: names.name,
    DOWNLOAD: downloadBase(version, releasesUrl),
  };
  const missing: string[] = [];
  for (const [asset, key] of Object.entries(ASSETS)) {
    const sum = sums.get(asset);
    if (sum === undefined) missing.push(asset);
    else values[key] = sum;
  }
  if (missing.length > 0) throw new Error(`SHA256SUMS has no checksum for ${missing.join(", ")}`);
  values.SHA256_WINDOWS_X64_UPPER = values.SHA256_WINDOWS_X64!.toUpperCase();

  // winget's own repo keeps each package under manifests/<first letter>/<id as folders>/<version>.
  const wingetDir = ["winget", "manifests", names.wingetId[0]!.toLowerCase(), ...names.wingetId.split("."), version].join("/");
  return {
    [`homebrew/Casks/${names.cask}.rb`]: fill(template("homebrew/cask.rb"), values),
    [`scoop/bucket/${names.program}.json`]: fill(template("scoop/manifest.json"), values),
    [`${wingetDir}/${names.wingetId}.yaml`]: fill(template("winget/version.yaml"), values),
    [`${wingetDir}/${names.wingetId}.installer.yaml`]: fill(template("winget/installer.yaml"), values),
    [`${wingetDir}/${names.wingetId}.locale.en-US.yaml`]: fill(template("winget/locale.en-US.yaml"), values),
  };
}

export function writeManifests(outDir: string, manifests: Record<string, string>): void {
  for (const [file, content] of Object.entries(manifests)) {
    const target = path.join(outDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Whether `version` is still the newest build on its channel, so an older release never overwrites a newer manifest. */
export async function isCurrent(version: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const state = mkdtempSync(path.join(tmpdir(), "tmb-packaging-"));
  try {
    const updater = new Updater({
      version,
      target: null,
      stateDir: state,
      releasesUrl: (env.TMB_RELEASES_URL || DEFAULT_RELEASES_URL).replace(/\/+$/, ""),
      releasesApi: (env.TMB_RELEASES_API || DEFAULT_RELEASES_API).replace(/\/+$/, ""),
      enabled: true,
    });
    const latest = await updater.latest();
    return channelOf(version) === "dev" ? latest.version === version : compareVersions(latest.version, version) <= 0;
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

export type PublishResult = { status: "skipped" | "unchanged" | "pushed"; reason: string };

function git(args: string[], cwd: string, token: string): { ok: boolean; out: string } {
  // The token goes in a header, never in the URL, so no error message can print it.
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const result = spawnSync("git", ["-c", `http.extraheader=AUTHORIZATION: basic ${auth}`, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/**
 * Copies the files under `dir` into `repo` and pushes them as one commit. Skips with a reason,
 * and never fails, when the token is missing or the repo cannot be reached: the tap and the
 * bucket are created by the Human, and a release must not fail before they exist.
 */
export function publish(repo: string, dir: string, opts: { token?: string; remoteBase?: string; message: string }): PublishResult {
  const token = opts.token ?? "";
  if (token === "") return { status: "skipped", reason: `TMB_PACKAGING_TOKEN is not set, so ${repo} was not updated` };
  const remote = `${(opts.remoteBase ?? "https://github.com").replace(/\/+$/, "")}/${repo}.git`;
  const work = mkdtempSync(path.join(tmpdir(), "tmb-publish-"));
  try {
    if (!git(["ls-remote", "--exit-code", remote, "HEAD"], work, token).ok) {
      return { status: "skipped", reason: `${repo} does not exist, is empty, or the token cannot read it` };
    }
    const clone = path.join(work, "repo");
    const cloned = git(["clone", "--depth", "1", remote, clone], work, token);
    if (!cloned.ok) throw new Error(`clone of ${repo} failed: ${cloned.out}`);
    for (const entry of readdirSync(dir)) cpSync(path.join(dir, entry), path.join(clone, entry), { recursive: true });
    git(["add", "--all"], clone, token);
    if (git(["diff", "--cached", "--quiet"], clone, token).ok) return { status: "unchanged", reason: `${repo} already holds these manifests` };
    const committed = git(
      ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "--quiet", "-m", opts.message],
      clone,
      token,
    );
    if (!committed.ok) throw new Error(`commit to ${repo} failed: ${committed.out}`);
    // Another channel's run may have pushed in between: each touches only its own files, so a rebase is clean.
    let pushed = git(["push", "--quiet", "origin", "HEAD"], clone, token);
    for (let attempt = 1; !pushed.ok && attempt < 3; attempt++) {
      const rebased = git(["pull", "--quiet", "--rebase", "origin", "HEAD"], clone, token);
      if (!rebased.ok) throw new Error(`rebase onto ${repo} failed: ${rebased.out}`);
      pushed = git(["push", "--quiet", "origin", "HEAD"], clone, token);
    }
    if (!pushed.ok) throw new Error(`push to ${repo} failed: ${pushed.out}`);
    return { status: "pushed", reason: `${repo} updated` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "current" && args.length === 1) {
    console.log((await isCurrent(args[0]!)) ? "yes" : "no");
    return 0;
  }
  if (command === "render" && args.length === 3) {
    const [version, sumsFile, outDir] = args as [string, string, string];
    const manifests = renderManifests(version, parseSums(readFileSync(sumsFile, "utf8")), process.env.TMB_RELEASES_URL || undefined);
    writeManifests(outDir, manifests);
    for (const file of Object.keys(manifests)) console.log(file);
    return 0;
  }
  if (command === "publish" && args.length === 2) {
    const [repo, dir] = args as [string, string];
    const result = publish(repo, dir, {
      token: process.env.TMB_PACKAGING_TOKEN,
      remoteBase: process.env.TMB_PACKAGING_REMOTE || undefined,
      message: process.env.TMB_PACKAGING_MESSAGE || "Update tmb manifests",
    });
    // A skip is a notice on GitHub Actions, not a failure.
    console.log(result.status === "skipped" ? `::notice::${result.reason}` : result.reason);
    return 0;
  }
  console.error("usage: package-managers.ts current <version> | render <version> <SHA256SUMS> <outDir> | publish <owner/repo> <dir>");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
