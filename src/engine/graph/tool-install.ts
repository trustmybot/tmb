// Installing a language's tool (CODE_GRAPH.md, "Where a language's tool comes from";
// trustmybot/tmb#393). An install is asked for, checked, and never part of a read: `tmb init`
// offers the tools a repo's languages miss and installs them on a yes, and `tmb tools install` does
// the same later. Nothing that reads the graph calls this file.
// - The pinned release, which the tool's language module keeps, comes from the tool's own release
//   page, or for a library, a package tmb loads, from the tool's own package registry, and is
//   checked against the digest tmb carries. A failed check installs nothing.
// - The release is unpacked into a folder of its own in the tools folder and moved into place
//   whole, so two installs at once each leave a whole copy, and a cut-short one leaves none.
// - A setting turns installs off (tool-copy.ts, TOOL_PATHS_FILE).
// - tmb installs a tool, never a language: a language's own command is never installed.
// The engine names no language: each tool's facts are its language module's.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { ReleaseAsset, ToolCopy, ToolRelease } from "./languages/contract.ts";
import { languageNamed } from "./languages/registry.ts";
import { tarEntries } from "./tar.ts";
import { assetFor, type CopyPlaces, copyName, fileName, findCopy, installsOff, machineKind, TOOL_PATHS_FILE, toolFolder, toolsFolder } from "./tool-copy.ts";
import { zipEntries } from "./zip.ts";

/** The machines a release may name an asset for, as the running program names them: `<os>-<arch>`. */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"] as const;

/** A tool the find order looks for: a program, or a library tmb loads. */
export type Installable = ToolCopy;

/**
 * Where and how to install: the machine's places; the fetch that downloads (the global fetch unless
 * given); the machine's kind (this one unless given); and the release of a tool, when not the one
 * its language module pins.
 */
export type InstallOptions = {
  places: CopyPlaces;
  fetch?: (url: string) => Promise<Response>;
  platform?: string;
  releaseOf?: (copy: Installable) => ToolRelease | undefined;
};

/** Where the installed program is, or why nothing was installed. */
export type InstallResult = { installed: string } | { failed: string };

/** The file errors a rename gives when its target is a folder already there. */
const TAKEN = new Set(["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"]);
/** The mode of the installed program: run by anyone, written by its owner. */
const PROGRAM_MODE = 0o755;
/** The mode of the tool's folder: read by anyone, as the folder the release lays out would be. */
const FOLDER_MODE = 0o755;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** The digest of a download, in the form the asset gives the one tmb carries: sha256 in hex, sha512 in base64. */
const digestOf = (bytes: Uint8Array, asset: ReleaseAsset): { carried: string; actual: string } =>
  "sha512" in asset
    ? { carried: asset.sha512, actual: createHash("sha512").update(bytes).digest("base64") }
    : { carried: asset.sha256, actual: createHash("sha256").update(bytes).digest("hex") };

/** Writes one file of the release under the tool's folder; a path that would leave it is refused. */
function writeInside(folder: string, relative: string, data: Uint8Array): void {
  const file = path.resolve(folder, relative);
  if (!file.startsWith(folder + path.sep)) throw new Error(`the release names ${relative}, outside the tool's folder`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

/** Unpacks the release into the tool's folder: the program to `bin/`, and what the release lays out beside it; or a library's package. */
function unpack(bytes: Uint8Array, archive: ReleaseAsset["archive"], folder: string, name: string): void {
  if (archive.format === "gzip") {
    writeInside(folder, path.join("bin", fileName(name)), gunzipSync(bytes));
    return;
  }
  const entries = archive.format === "zip" ? zipEntries(bytes) : tarEntries(gunzipSync(bytes)).map((e) => ({ ...e, read: () => e.data }));
  for (const entry of entries) {
    if (entry.directory || !entry.name.startsWith(archive.from)) continue;
    writeInside(folder, archive.to + entry.name.slice(archive.from.length), entry.read());
  }
}

/** The files the installed copy must hold, from its folder: a program's `bin/<program>`, or each a library names. */
const mustHold = (copy: ToolCopy): readonly string[] => ("library" in copy ? copy.holds : [path.join("bin", fileName(copy.program))]);

/**
 * Moves the unpacked folder into the tool's place. A copy already there is moved aside first and
 * removed after; when another install puts its copy in between, that copy, of the same checked
 * release, stays.
 */
function putInPlace(staged: string, folder: string): void {
  try {
    renameSync(staged, folder);
    return;
  } catch (error) {
    if (!TAKEN.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const aside = `${staged}.old`;
  try {
    renameSync(folder, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    renameSync(staged, folder);
  } catch (error) {
    if (!TAKEN.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
}

/** Installs the pinned release of a tool into tmb's tools folder, checked against its digest; a failure installs nothing. */
export async function installTool(copy: ToolCopy, options: InstallOptions): Promise<InstallResult> {
  if ("program" in copy && !copy.tmbInstalls) return { failed: `${copy.what} is the user's own: tmb installs a tool, never a language` };
  const { stateDir } = options.places;
  if (installsOff(stateDir)) return { failed: `installs are off in ${path.join(stateDir, TOOL_PATHS_FILE)}; nothing is installed` };
  const release = options.releaseOf?.(copy) ?? copy.release;
  const kind = options.platform ?? machineKind();
  const asset = assetFor(release, kind);
  if (asset === undefined) return { failed: `tmb has no release of ${copy.what} for ${kind}; nothing is installed` };
  let bytes: Uint8Array;
  try {
    const response = await (options.fetch ?? fetch)(asset.url);
    if (!response.ok) return { failed: `${asset.url} answered ${response.status}; nothing is installed` };
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return { failed: `${asset.url} could not be downloaded (${message(error)}); nothing is installed` };
  }
  const { carried, actual } = digestOf(bytes, asset);
  if (actual !== carried) return { failed: `checksum mismatch for ${asset.url}: tmb carries ${carried}, the download is ${actual}; nothing is installed` };
  const name = copyName(copy);
  mkdirSync(toolsFolder(stateDir), { recursive: true });
  const folder = toolFolder(stateDir, name);
  const staged = mkdtempSync(path.join(toolsFolder(stateDir), `.install-${name}-`));
  try {
    chmodSync(staged, FOLDER_MODE);
    unpack(bytes, asset.archive, staged, name);
    const lacking = mustHold(copy).filter((file) => !existsSync(path.join(staged, file)));
    if (lacking.length > 0) return { failed: `${asset.url} holds no ${lacking.join(", ")}; nothing is installed` };
    if ("program" in copy) chmodSync(path.join(staged, "bin", fileName(copy.program)), PROGRAM_MODE);
    putInPlace(staged, folder);
  } catch (error) {
    return { failed: `${asset.url} could not be installed (${message(error)}); nothing is installed` };
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  return { installed: "program" in copy ? path.join(folder, "bin", fileName(copy.program)) : folder };
}

/** A tool the languages given miss that tmb may install: its name, the languages that use it, its facts, and why it is missing. */
export type Offer = { tool: string; languages: string[]; copy: Installable; why: string };

/**
 * The tools the languages given miss: each tool tmb installs that the find order finds no copy of,
 * once for all the languages that share it; and, for a language whose own command is missing, a
 * note, as tmb installs no language. It downloads and installs nothing.
 */
export function missingTools(languages: readonly string[], places: CopyPlaces): { offers: Offer[]; notes: string[] } {
  const offers = new Map<string, Offer>();
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const language of languages) {
    const tool = languageNamed(language)?.tool;
    if (tool === undefined) continue;
    const name = copyName(tool.copy);
    const offered = offers.get(name);
    if (offered !== undefined) {
      offered.languages.push(language);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const found = findCopy(tool.copy, places);
    if (!("missing" in found)) continue;
    if ("program" in tool.copy && !tool.copy.tmbInstalls) notes.push(`${language}: ${found.missing}; tmb installs no language`);
    else if (assetFor(tool.copy.release, machineKind()) === undefined) notes.push(`${language}: ${found.missing}`);
    else offers.set(name, { tool: tool.name, languages: [language], copy: tool.copy, why: found.missing });
  }
  return { offers: [...offers.values()], notes };
}
