import { existsSync } from "node:fs";
import path from "node:path";
import { openProjectStore, PROJECT_DIR_NAME, projectDbPath } from "../../engine/index.ts";
import type { HostAdapter } from "../host-adapter.ts";
import { ignoreInGit } from "./git.ts";
import { answerHook } from "./hook.ts";
import { registerServer, unregisterServer } from "./mcp-json.ts";
import { install, remove } from "./settings.ts";

function shown(projectDir: string, file: string): string {
  return path.relative(projectDir, file) || file;
}

/** Creates the project's record through the engine, or keeps the one already there. */
function setUpRecord(projectDir: string): string[] {
  const dbFile = shown(projectDir, projectDbPath(projectDir));
  const existed = existsSync(projectDbPath(projectDir));
  const opened = openProjectStore(projectDir, { create: true });
  if (!opened.ok) throw new Error(`cannot set up the record: ${opened.error.message}`);
  opened.store.close();
  const lines = [existed ? `${dbFile} already holds the record; kept it.` : `Created the record at ${dbFile}.`];
  if (ignoreInGit(projectDir, `${PROJECT_DIR_NAME}/`, path.join(PROJECT_DIR_NAME, "trajectory.db"))) {
    lines.push(`Added ${PROJECT_DIR_NAME}/ to .gitignore.`);
  }
  return lines;
}

export const adapter: HostAdapter = {
  name: "Claude Code",

  setup(projectDir, tmbCommand) {
    const lines = setUpRecord(projectDir);

    const server = registerServer(projectDir, tmbCommand);
    const mcpFile = shown(projectDir, server.file);
    if (!server.changed) lines.push(`${mcpFile} already registers the tmb tool server; nothing to add.`);
    else lines.push(server.created ? `Created ${mcpFile} with the tmb tool server.` : `Registered the tmb tool server in ${mcpFile}.`);
    if (server.gitignoreChanged) lines.push(`Added ${mcpFile} to .gitignore.`);

    const settings = install(projectDir, tmbCommand);
    const file = shown(projectDir, settings.settingsFile);
    lines.push(
      settings.serverEnabled ? `Enabled the tmb tool server in ${file}.` : `${file} already enables the tmb tool server; nothing to add.`,
      settings.hookAdded ? `Added the SessionStart hook to ${file}.` : `${file} already has the SessionStart hook; nothing to add.`,
    );
    if (settings.gitignoreChanged) lines.push(`Added ${file} to .gitignore.`);
    return lines;
  },

  remove(projectDir) {
    const lines: string[] = [];

    const server = unregisterServer(projectDir);
    const mcpFile = shown(projectDir, server.file);
    if (!server.removed) lines.push(`No tmb tool server found in ${mcpFile}; nothing to remove.`);
    else lines.push(server.fileDeleted ? `Removed the tmb tool server and the now-empty ${mcpFile}.` : `Removed the tmb tool server from ${mcpFile}.`);

    const settings = remove(projectDir);
    const file = shown(projectDir, settings.settingsFile);
    if (!settings.hookRemoved && !settings.serverDisabled) {
      lines.push(`No tmb hook or enabled tmb tool server found in ${file}; nothing to remove.`);
    } else {
      const removed = [settings.hookRemoved && "the SessionStart hook", settings.serverDisabled && "the tmb tool server's enabled entry"]
        .filter(Boolean)
        .join(" and ");
      lines.push(settings.fileDeleted ? `Removed ${removed}, then the now-empty ${file}.` : `Removed ${removed} from ${file}.`);
    }

    const dbFile = projectDbPath(projectDir);
    if (existsSync(dbFile)) lines.push(`Kept the record at ${shown(projectDir, dbFile)}: it is your data; delete it yourself if you no longer want it.`);
    return lines;
  },

  answerHook,
};
