// The project's .mcp.json, where Claude Code finds project-scoped tool servers. tmb adds its
// own entry and never touches another server's.
import { existsSync } from "node:fs";
import path from "node:path";
import { PROJECT_DIR_NAME } from "../../engine/index.ts";
import { ignoreInGit } from "../common/git.ts";
import { deleteFile, isObject, type JsonObject, readJsonObject, writeJsonObject } from "../common/json-file.ts";

export const SERVER_KEY = "tmb";
export const HOST_ID = "claude-code";
const MCP_JSON = ".mcp.json";
// Records that init created .mcp.json, so remove deletes the file only when it was tmb's.
const CREATED_MARKER = path.join(PROJECT_DIR_NAME, "claude-code-created.json");

export function mcpJsonPath(projectDir: string): string {
  return path.join(projectDir, MCP_JSON);
}

function markerPath(projectDir: string): string {
  return path.join(projectDir, CREATED_MARKER);
}

export function serverEntry(tmbCommand: readonly string[]): JsonObject {
  return { command: tmbCommand[0], args: [...tmbCommand.slice(1), "mcp", "--host", HOST_ID] };
}

function serversOf(config: JsonObject, file: string): JsonObject {
  const servers = config.mcpServers;
  if (servers === undefined) return {};
  if (!isObject(servers)) throw new Error(`mcpServers in ${file} is not an object`);
  return servers;
}

export type RegisterResult = { file: string; changed: boolean; created: boolean; gitignoreChanged: boolean };

export function registerServer(projectDir: string, tmbCommand: readonly string[]): RegisterResult {
  const file = mcpJsonPath(projectDir);
  const created = !existsSync(file);
  const config = readJsonObject(file);
  const servers = serversOf(config, file);
  const entry = serverEntry(tmbCommand);

  const changed = JSON.stringify(servers[SERVER_KEY]) !== JSON.stringify(entry);
  if (changed) {
    config.mcpServers = { ...servers, [SERVER_KEY]: entry };
    writeJsonObject(file, config);
    if (created) writeJsonObject(markerPath(projectDir), { created: MCP_JSON });
  }
  // A .mcp.json tmb made holds only a machine-specific path, so it stays out of git.
  const gitignoreChanged = existsSync(markerPath(projectDir)) && ignoreInGit(projectDir, MCP_JSON);
  return { file, changed, created: created && changed, gitignoreChanged };
}

export type UnregisterResult = { file: string; removed: boolean; fileDeleted: boolean };

export function unregisterServer(projectDir: string): UnregisterResult {
  const file = mcpJsonPath(projectDir);
  const marker = markerPath(projectDir);
  const tmbCreatedIt = existsSync(marker);
  const result: UnregisterResult = { file, removed: false, fileDeleted: false };

  if (existsSync(file)) {
    const config = readJsonObject(file);
    const servers = serversOf(config, file);
    if (Object.hasOwn(servers, SERVER_KEY)) {
      delete servers[SERVER_KEY];
      config.mcpServers = servers;
      result.removed = true;
      const nowEmpty = Object.keys(servers).length === 0 && Object.keys(config).length === 1;
      if (tmbCreatedIt && nowEmpty) {
        deleteFile(file, projectDir);
        result.fileDeleted = true;
      } else {
        writeJsonObject(file, config);
      }
    }
  }
  if (tmbCreatedIt) deleteFile(marker, projectDir);
  return result;
}
