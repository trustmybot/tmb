import { SUBAGENT_ROLES, type SubagentRole, TMB_EVENT_TYPES } from "../../engine/index.ts";
import { keptRecordLine, listed, setUpRecord, shown } from "../common/record.ts";
import type { HostAdapter } from "../host-adapter.ts";
import { detect } from "./detect.ts";
import { answerHook } from "./hook.ts";
import { HOST_ID, registerServer, unregisterServer } from "./mcp-json.ts";
import { removeRoleFiles, roleFilePath, writeRoleFiles } from "./role-files.ts";
import { install, remove } from "./settings.ts";

function setUpRoleFiles(projectDir: string, roles: readonly SubagentRole[]): string[] {
  const result = writeRoleFiles(projectDir, roles);
  const file = (name: string) => shown(projectDir, roleFilePath(projectDir, name));
  return [
    ...result.written.map((name) => `Wrote the ${name} role to ${file(name)}.`),
    ...result.current.map((name) => `${file(name)} already holds the ${name} role; nothing to change.`),
    ...result.notOurs.map((name) => `${file(name)} is not tmb's, so it was kept as it is and the ${name} role was not written.`),
  ];
}

export const adapter: HostAdapter = {
  id: HOST_ID,
  name: "Claude Code",

  limits: { canDenyToolCall: true, modelPerRole: true, namesAgentOnToolCall: true, events: TMB_EVENT_TYPES },

  detect,

  setup(projectDir, tmbCommand, roles = SUBAGENT_ROLES) {
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
      settings.hooksAdded.length > 0
        ? `Added the ${listed(settings.hooksAdded)} hook${settings.hooksAdded.length > 1 ? "s" : ""} to ${file}.`
        : `${file} already has tmb's hooks; nothing to add.`,
    );
    if (settings.gitignoreChanged) lines.push(`Added ${file} to .gitignore.`);

    lines.push(...setUpRoleFiles(projectDir, roles));
    return lines;
  },

  remove(projectDir) {
    const lines: string[] = [];

    const server = unregisterServer(projectDir);
    const mcpFile = shown(projectDir, server.file);
    if (!server.removed) lines.push(`No tmb tool server found in ${mcpFile}; nothing to remove.`);
    else lines.push(server.fileDeleted ? `Removed the tmb tool server and the now-empty ${mcpFile}.` : `Removed the tmb tool server from ${mcpFile}.`);

    // Role files go first, so the settings file's removal can drop a folder they leave empty.
    for (const roleFile of removeRoleFiles(projectDir)) lines.push(`Removed tmb's role file ${shown(projectDir, roleFile)}.`);

    const settings = remove(projectDir);
    const file = shown(projectDir, settings.settingsFile);
    if (settings.hooksRemoved.length === 0 && !settings.serverDisabled) {
      lines.push(`No tmb hook or enabled tmb tool server found in ${file}; nothing to remove.`);
    } else {
      const hooks = settings.hooksRemoved.length > 0 && `the ${listed(settings.hooksRemoved)} hook${settings.hooksRemoved.length > 1 ? "s" : ""}`;
      const removed = listed([hooks, settings.serverDisabled && "the tmb tool server's enabled entry"].filter((part): part is string => !!part));
      lines.push(settings.fileDeleted ? `Removed ${removed}, then the now-empty ${file}.` : `Removed ${removed} from ${file}.`);
    }

    lines.push(...keptRecordLine(projectDir));
    return lines;
  },

  answerHook,
};
