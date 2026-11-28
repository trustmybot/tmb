// The project's .mcp.json, where Claude Code finds project-scoped tool servers. tmb adds its
// own entry and never touches another server's.
import { existsSync } from "node:fs";
import path from "node:path";
import { ignoreInGit } from "../common/git.ts";
import { deleteFile, isObject, type JsonObject, readJsonObject, writeJsonObject } from "../common/json-file.ts";
import { FILES, HOST_ID, SERVER_KEY } from "./host.ts";

/** tmb's entry: the tmb command, then its tool server for this host. */
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
export type UnregisterResult = { file: string; removed: boolean; fileDeleted: boolean };

/** tmb's tool server entry in the project's .mcp.json. */
export class McpJsonFile {
  path(projectDir: string): string {
    return path.join(projectDir, FILES.mcpJson);
  }

  private markerPath(projectDir: string): string {
    return path.join(projectDir, FILES.mcpJsonCreatedMarker);
  }

  register(projectDir: string, tmbCommand: readonly string[]): RegisterResult {
    const file = this.path(projectDir);
    const created = !existsSync(file);
    const config = readJsonObject(file);
    const servers = serversOf(config, file);
    const entry = serverEntry(tmbCommand);

    const changed = JSON.stringify(servers[SERVER_KEY]) !== JSON.stringify(entry);
    if (changed) {
      config.mcpServers = { ...servers, [SERVER_KEY]: entry };
      writeJsonObject(file, config);
      if (created) writeJsonObject(this.markerPath(projectDir), { created: FILES.mcpJson });
    }
    // A .mcp.json tmb made holds only a machine-specific path, so it stays out of git.
    const gitignoreChanged = existsSync(this.markerPath(projectDir)) && ignoreInGit(projectDir, FILES.mcpJson);
    return { file, changed, created: created && changed, gitignoreChanged };
  }

  unregister(projectDir: string): UnregisterResult {
    const file = this.path(projectDir);
    const marker = this.markerPath(projectDir);
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

  /** What `tmb doctor` finds wrong with tmb's entry, or null when it is the one init writes. Never writes. */
  gap(projectDir: string, tmbCommand: readonly string[]): string | null {
    const file = this.path(projectDir);
    try {
      const entry = serversOf(readJsonObject(file), file)[SERVER_KEY];
      if (entry === undefined) return `${FILES.mcpJson} does not register the tmb tool server`;
      return JSON.stringify(entry) === JSON.stringify(serverEntry(tmbCommand)) ? null : `${FILES.mcpJson} registers the tmb tool server with another command than this tmb's`;
    } catch (error) {
      return `${FILES.mcpJson} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
