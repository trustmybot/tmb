// Where a language's tool comes from (CODE_GRAPH.md, "Where a language's tool comes from";
// trustmybot/tmb#392). One find order for every tool, with no language named here: each language's
// module gives its tool's facts (ToolCopy), such as the program's name, how it reports its version
// and the lowest version tmb supports.
// 1. A setting names the path of the tool: that copy is used, and nothing is searched.
// 2. The user's own copy, on PATH or where the language's own installer puts it, when it is at or
//    above the lowest version tmb supports. tmb installs no second one.
// 3. tmb's copy, in its tools folder, kept once per machine. A tool that is a language's own
//    command has none: tmb installs a tool, never a language.
// 4. None: the tool is missing, and the built-in rules build the graph; why names what is missing.
// A library, a package tmb loads into its own program, is only ever tmb's copy, at tmb's pin: no
// setting and no copy of the user's is looked for, on PATH or in a repo's own packages, so one tmb
// gives one answer. Its version is the one its package names.
// Finding runs only the copy's version command, and reads a library's package file: it downloads
// and installs nothing.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { programStateDir, runningName } from "../../program.ts";
import type { FoundCopy, ReleaseAsset, ToolCopy, ToolRelease } from "./languages/contract.ts";

export type { FoundCopy, ToolCopy, Whose } from "./languages/contract.ts";

/** Where the copy came from, or that none was found. */
export type CopySearch = FoundCopy | { missing: string };

/** The machine's places the order looks in: the PATH it searches, and tmb's machine-wide state folder. */
export type CopyPlaces = { searchPath: string; stateDir: string };

/** tmb's tools folder, inside its machine-wide state folder: one folder per tool, holding `bin/<program>`, or a library's package. */
export const TOOLS_FOLDER = "tools";

/**
 * The machine's tool settings, a file in the state folder the user edits: the path of a tool, by
 * its program's name, and whether tmb may install tools: `{ "paths": { "<program>": "<path>" },
 * "install": false }`. Installs are on unless `install` is false.
 */
export const TOOL_PATHS_FILE = "tools.json";

/** The file of a package that names it and its version. */
const PACKAGE_FILE = "package.json";

/** tmb's tools folder in a state folder. */
export const toolsFolder = (stateDir: string): string => path.join(stateDir, TOOLS_FOLDER);

/** tmb's own folder for one tool, in its tools folder: it holds `bin/<program>` and what the release lays out beside it, or a library's package. */
export const toolFolder = (stateDir: string, name: string): string => path.join(toolsFolder(stateDir), name);

/** The name a tool's folder in the tools folder takes: its program's, or its package's. */
export const copyName = (tool: ToolCopy): string => ("library" in tool ? tool.library : tool.program);

/** The asset of a release for a machine: its own, else the one for every machine. */
export const assetFor = (release: ToolRelease | undefined, kind: string): ReleaseAsset | undefined => release?.assets[kind] ?? release?.everyMachine;

/** A program's file name on this platform. */
export const fileName = (program: string): string => (process.platform === "win32" ? `${program}.exe` : program);

/** The machine's places now: its PATH and the running program's state folder. */
export function machinePlaces(env: NodeJS.ProcessEnv = process.env): CopyPlaces {
  return { searchPath: env.PATH ?? "", stateDir: programStateDir(runningName(), env) };
}

/** The machine's tool settings as written; a missing or unreadable file sets nothing. */
function toolSettings(stateDir: string): { paths?: unknown; install?: unknown } {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, TOOL_PATHS_FILE), "utf8")) as unknown;
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

/** The paths the setting names, by program; a missing or unreadable setting names none. */
export function toolPaths(stateDir: string): Record<string, string> {
  const { paths } = toolSettings(stateDir);
  if (typeof paths !== "object" || paths === null) return {};
  return Object.fromEntries(Object.entries(paths).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
}

/** Whether the setting turns installs off, for a machine that may not download programs. */
export const installsOff = (stateDir: string): boolean => toolSettings(stateDir).install === false;

/** The running machine as a release names its assets: `<os>-<arch>`, as the running program names them. */
export const machineKind = (): string => `${process.platform}-${process.arch}`;

/** How a tool tmb does not have yet can come: the command that installs it, or why it cannot. */
function howToInstall(tool: ToolCopy, stateDir: string): string {
  if (installsOff(stateDir)) return `installs are off in ${path.join(stateDir, TOOL_PATHS_FILE)}`;
  if (assetFor(tool.release, machineKind()) === undefined) return `tmb has no release of it for ${machineKind()}`;
  return `\`${runningName()} tools install\` installs it`;
}

/** Whether a file is there and may be run. */
function runnable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first folder of a search path that holds the program. */
function onPath(program: string, folders: readonly string[]): string | null {
  for (const folder of folders) {
    if (folder === "") continue;
    const file = path.join(folder, fileName(program));
    if (runnable(file)) return file;
  }
  return null;
}

type Spawned = Extract<ToolCopy, { program: string }>;
type Library = Extract<ToolCopy, { library: string }>;

/** The version a package names in its package file, or null when it names none. */
function packageVersion(folder: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(path.join(folder, PACKAGE_FILE), "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** A library's copy: tmb's, in its tools folder, at tmb's pin and holding every file it must; else missing. */
function findLibrary(tool: Library, stateDir: string): CopySearch {
  const folder = toolFolder(stateDir, tool.library);
  const pin = tool.release.version;
  const how = howToInstall(tool, stateDir);
  const version = packageVersion(folder);
  if (version === null) return { missing: `${tool.what} is missing: tmb's tools folder holds no ${tool.library} ${pin}; ${how}` };
  if (version !== pin) return { missing: `${tool.what} is missing: tmb's copy at ${folder} is ${tool.library} ${version}, and tmb uses only ${pin}; ${how}` };
  const lacking = tool.holds.filter((file) => !existsSync(path.join(folder, file)));
  if (lacking.length > 0) return { missing: `${tool.what} is missing: tmb's copy at ${folder} lacks ${lacking.join(", ")}; ${how}` };
  return { whose: "tmb", path: folder, version };
}

/** A copy's version, as it reports it, or why it does not run. */
function reportOf(tool: Spawned, file: string): { report: string } | { fails: string } {
  const run = spawnSync(file, [...tool.versionArgs], { encoding: "utf8", env: { ...process.env, ...(tool.env ?? {}) } });
  if (run.error !== undefined) return { fails: run.error.message };
  if (run.status !== 0) return { fails: `\`${tool.program} ${tool.versionArgs.join(" ")}\` failed: ${(run.stderr ?? "").trim()}` };
  return { report: tool.report({ stdout: run.stdout ?? "", stderr: run.stderr ?? "" }) };
}

/** Finds the copy of a tool to use, in the one order above. */
export function findCopy(tool: ToolCopy, places: CopyPlaces): CopySearch {
  if ("library" in tool) return findLibrary(tool, places.stateDir);
  // 1. The setting: that copy, and nothing searched.
  const named = toolPaths(places.stateDir)[tool.program];
  if (named !== undefined) {
    const file = path.resolve(named);
    if (!runnable(file)) return { missing: `the setting names ${file} for \`${tool.program}\`, which is not a program that runs` };
    const run = reportOf(tool, file);
    if ("fails" in run) return { missing: `the setting names ${file} for \`${tool.program}\`, which does not run (${run.fails})` };
    return { whose: "setting", path: file, version: run.report };
  }
  // 2. The user's own copy, at a version tmb supports.
  const userFolders = [...places.searchPath.split(path.delimiter), ...(tool.userPlaces?.() ?? [])];
  const mine = onPath(tool.program, userFolders);
  let older: string | null = null;
  if (mine !== null) {
    const run = reportOf(tool, mine);
    if ("report" in run && tool.supported(run.report)) return { whose: "user", path: mine, version: run.report };
    older =
      "report" in run
        ? `the user's ${tool.what} at ${mine} is ${run.report}, older than ${tool.lowest}, the lowest tmb supports`
        : `the user's ${tool.what} at ${mine} does not run (${run.fails})`;
  }
  // 3. tmb's copy in its tools folder; a language has none.
  if (tool.tmbInstalls) {
    const tmbs = path.join(toolFolder(places.stateDir, tool.program), "bin", fileName(tool.program));
    if (runnable(tmbs)) {
      const run = reportOf(tool, tmbs);
      if ("report" in run) return { whose: "tmb", path: tmbs, version: run.report, ...(older === null ? {} : { note: `${older}; tmb's copy is used` }) };
      return { missing: `${older === null ? "" : `${older}; `}tmb's copy at ${tmbs} does not run (${run.fails}); ${howToInstall(tool, places.stateDir)}` };
    }
  }
  // 4. None.
  const looked = ["PATH", ...(tool.userPlaces?.() ?? [])].join(" or in ");
  const how = tool.tmbInstalls ? `; ${howToInstall(tool, places.stateDir)}` : "";
  const none = `${tool.what} is missing: no \`${tool.program}\` on ${looked}${tool.tmbInstalls ? " or in tmb's tools folder" : ""}${how}`;
  if (older === null) return { missing: none };
  return { missing: `${older}, and ${tool.tmbInstalls ? "tmb's tools folder holds no copy" : "tmb installs no language"}${how}` };
}

/** Whether a version, as numbers, is at or above the lowest, as numbers: a part not given is 0. */
export function atLeast(version: readonly number[], lowest: readonly number[]): boolean {
  for (let i = 0; i < Math.max(version.length, lowest.length); i++) {
    const a = version[i] ?? 0;
    const b = lowest[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** The numbers of a dotted version, such as `1.92.0`. */
export const versionNumbers = (text: string): number[] => text.split(".").map((part) => Number.parseInt(part, 10) || 0);
