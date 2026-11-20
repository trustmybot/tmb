// The project's .codex/config.toml, where Codex finds project-scoped tool servers. tmb keeps
// its server in one marked block at the end of the file and never touches the rest.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ignoreInGit } from "../common/git.ts";
import { deleteFile, isObject, writeJsonObject } from "../common/json-file.ts";
import { CODEX_DIR, configTomlPath, createdMarkerPath, HOST_ID, SERVER_KEY } from "./paths.ts";

const BEGIN = "# >>> tmb: written by tmb init and deleted by tmb remove; tmb init replaces any edit.";
// The first line builds before tmb init wrote, so their block is still found and replaced or removed.
const EARLIER_BEGIN = "# >>> tmb: written by tmb setup and deleted by tmb remove; tmb setup replaces any edit.";
const END = "# <<< tmb";
// The block and the newline init put before it: a blank line after a file that ends with one.
// An editor or git may turn the file's line endings into CRLF after init, so either is read.
const BLOCK = new RegExp(String.raw`\r?\n(?:${escape(BEGIN)}|${escape(EARLIER_BEGIN)})\r?\n[\s\S]*?\r?\n${escape(END)}\r?\n`);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A TOML basic string: JSON's escapes are all valid TOML ones. */
const tomlString = (value: string) => JSON.stringify(value);

export function serverBlock(tmbCommand: readonly string[], eol = "\n"): string {
  const args = [...tmbCommand.slice(1), "mcp", "--host", HOST_ID];
  return [BEGIN, `[mcp_servers.${SERVER_KEY}]`, `command = ${tomlString(tmbCommand[0]!)}`, `args = [${args.map(tomlString).join(", ")}]`, END, ""].join(eol);
}

function parse(text: string, file: string): Record<string, unknown> {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${file} is not valid TOML, so tmb left it as it is: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasServer(config: Record<string, unknown>): boolean {
  const servers = config.mcp_servers;
  return isObject(servers) && Object.hasOwn(servers, SERVER_KEY);
}

export type RegisterResult = { file: string; changed: boolean; created: boolean; gitignoreChanged: boolean };

export function registerServer(projectDir: string, tmbCommand: readonly string[]): RegisterResult {
  const file = configTomlPath(projectDir);
  const created = !existsSync(file);
  const before = created ? "" : readFileSync(file, "utf8");
  const humans = before.replace(BLOCK, "");
  if (hasServer(parse(humans, file))) throw new Error(`${file} already has an [mcp_servers.${SERVER_KEY}] tmb did not write; remove it, then run tmb init again`);
  // One newline before the block: a blank line after a file that ends with one, a line break after one that does not.
  const eol = humans.includes("\r\n") ? "\r\n" : "\n";
  const text = `${humans}${eol}${serverBlock(tmbCommand, eol)}`;
  if (!hasServer(parse(text, file))) throw new Error(`tmb could not add its server to ${file}`);

  const changed = text !== before;
  if (changed) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (created) writeJsonObject(createdMarkerPath(projectDir, "config"), { created: path.join(CODEX_DIR, "config.toml") });
  }
  // A config.toml tmb made holds only a machine-specific path, so it stays out of git.
  const gitignoreChanged = existsSync(createdMarkerPath(projectDir, "config")) && ignoreInGit(projectDir, `${CODEX_DIR}/config.toml`, path.join(CODEX_DIR, "config.toml"));
  return { file, changed, created: created && changed, gitignoreChanged };
}

export type UnregisterResult = { file: string; removed: boolean; fileDeleted: boolean };

export function unregisterServer(projectDir: string): UnregisterResult {
  const file = configTomlPath(projectDir);
  const marker = createdMarkerPath(projectDir, "config");
  const tmbCreatedIt = existsSync(marker);
  const result: UnregisterResult = { file, removed: false, fileDeleted: false };
  if (existsSync(file)) {
    const before = readFileSync(file, "utf8");
    const after = before.replace(BLOCK, "");
    if (after !== before) {
      result.removed = true;
      if (tmbCreatedIt && after.trim() === "") {
        deleteFile(file, projectDir);
        result.fileDeleted = true;
      } else {
        writeFileSync(file, after);
      }
    }
  }
  if (tmbCreatedIt) deleteFile(marker, projectDir);
  return result;
}

/** What `tmb doctor` finds wrong with tmb's block in .codex/config.toml, or null when it is the one init writes. Never writes. */
export function serverGap(projectDir: string, tmbCommand: readonly string[]): string | null {
  const file = configTomlPath(projectDir);
  const shown = path.join(CODEX_DIR, "config.toml");
  if (!existsSync(file)) return `${shown} does not register the tmb tool server`;
  const text = readFileSync(file, "utf8");
  const block = BLOCK.exec(text);
  if (block === null) return `${shown} does not register the tmb tool server`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return block[0].endsWith(serverBlock(tmbCommand, eol)) ? null : `${shown} registers the tmb tool server with another command than this tmb's`;
}
