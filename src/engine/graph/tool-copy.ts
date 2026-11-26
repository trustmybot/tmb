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
// A tool tmb carries in its own program is tmb's copy, at the version it carries.
// Finding runs only the copy's version command: it downloads and installs nothing.
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { programStateDir, runningName } from "../../program.ts";
import type { FoundCopy, ToolCopy } from "./languages/contract.ts";

export type { FoundCopy, ToolCopy, Whose } from "./languages/contract.ts";

/** Where the copy came from, or that none was found. */
export type CopySearch = FoundCopy | { missing: string };

/** The machine's places the order looks in: the PATH it searches, and tmb's machine-wide state folder. */
export type CopyPlaces = { searchPath: string; stateDir: string };

/** tmb's tools folder, inside its machine-wide state folder: one folder per program, holding `bin/<program>`. */
export const TOOLS_FOLDER = "tools";

/** The setting that names a tool's path, by its program's name: `{ "paths": { "<program>": "<path>" } }`, in the state folder. */
export const TOOL_PATHS_FILE = "tools.json";

/** tmb's tools folder in a state folder. */
export const toolsFolder = (stateDir: string): string => path.join(stateDir, TOOLS_FOLDER);

/** A program's file name on this platform. */
const fileName = (program: string): string => (process.platform === "win32" ? `${program}.exe` : program);

/** The machine's places now: its PATH and the running program's state folder. */
export function machinePlaces(env: NodeJS.ProcessEnv = process.env): CopyPlaces {
  return { searchPath: env.PATH ?? "", stateDir: programStateDir(runningName(), env) };
}

/** The paths the setting names, by program; a missing or unreadable setting names none. */
export function toolPaths(stateDir: string): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, TOOL_PATHS_FILE), "utf8")) as { paths?: unknown };
    if (typeof value.paths !== "object" || value.paths === null) return {};
    return Object.fromEntries(Object.entries(value.paths).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
  } catch {
    return {};
  }
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

type Spawned = Exclude<ToolCopy, { carried: string }>;

/** A copy's version, as it reports it, or why it does not run. */
function reportOf(tool: Spawned, file: string): { report: string } | { fails: string } {
  const run = spawnSync(file, [...tool.versionArgs], { encoding: "utf8", env: { ...process.env, ...(tool.env ?? {}) } });
  if (run.error !== undefined) return { fails: run.error.message };
  if (run.status !== 0) return { fails: `\`${tool.program} ${tool.versionArgs.join(" ")}\` failed: ${(run.stderr ?? "").trim()}` };
  return { report: tool.report({ stdout: run.stdout ?? "", stderr: run.stderr ?? "" }) };
}

/** Finds the copy of a tool to use, in the one order above. */
export function findCopy(tool: ToolCopy, places: CopyPlaces): CopySearch {
  if ("carried" in tool) return { whose: "tmb", path: null, version: tool.carried };
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
    const tmbs = path.join(toolsFolder(places.stateDir), tool.program, "bin", fileName(tool.program));
    if (runnable(tmbs)) {
      const run = reportOf(tool, tmbs);
      if ("report" in run) return { whose: "tmb", path: tmbs, version: run.report, ...(older === null ? {} : { note: `${older}; tmb's copy is used` }) };
      return { missing: `${older === null ? "" : `${older}; `}tmb's copy at ${tmbs} does not run (${run.fails})` };
    }
  }
  // 4. None.
  const looked = ["PATH", ...(tool.userPlaces?.() ?? [])].join(" or in ");
  const none = `${tool.what} is missing: no \`${tool.program}\` on ${looked}${tool.tmbInstalls ? " or in tmb's tools folder" : ""}`;
  if (older === null) return { missing: none };
  return { missing: `${older}, and ${tool.tmbInstalls ? "tmb's tools folder holds no copy" : "tmb installs no language"}` };
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
