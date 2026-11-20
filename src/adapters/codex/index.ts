import { SUBAGENT_ROLES, type SubagentRole, TMB_EVENT_TYPES } from "../../engine/index.ts";
import { keptRecordLine, listed, setUpRecord, shown } from "../common/record.ts";
import type { HostAdapter } from "../host-adapter.ts";
import { registerServer, unregisterServer } from "./config-toml.ts";
import { detect } from "./detect.ts";
import { answerHook } from "./hook.ts";
import { installHooks, removeHooks } from "./hooks-json.ts";
import { HOST_ID } from "./paths.ts";
import { removeRoleFiles, roleFilePath, writeRoleFiles } from "./role-files.ts";
import { pendingSteps } from "./trust.ts";

function setUpRoleFiles(projectDir: string, roles: readonly SubagentRole[]): string[] {
  const result = writeRoleFiles(projectDir, roles);
  const file = (name: string) => shown(projectDir, roleFilePath(projectDir, name));
  return [
    ...result.written.map((name) => `Wrote the ${name} role to ${file(name)}.`),
    ...result.current.map((name) => `${file(name)} already holds the ${name} role; nothing to change.`),
    ...result.notOurs.map((name) => `${file(name)} is not tmb's, so it was kept as it is and the ${name} role was not written.`),
    ...result.removed.map((removed) => `Removed tmb's role file ${shown(projectDir, removed)}, for a role this version no longer has.`),
  ];
}

const hooksNamed = (events: readonly string[]) => `the ${listed(events)} hook${events.length > 1 ? "s" : ""}`;

export const adapter: HostAdapter = {
  id: HOST_ID,
  name: "Codex",
  command: "codex",

  // Codex raises every tmb event but a worker's folder: a Codex worker has no worktree of its host's
  // making, so it works in the one tmb cut. A subagent's start is denied from its spawn tool call.
  limits: { canDenyToolCall: true, modelPerRole: true, namesAgentOnToolCall: false, events: TMB_EVENT_TYPES.filter((type) => type !== "worker-in-folder") },

  detect,

  setup(projectDir, tmbCommand, roles = SUBAGENT_ROLES) {
    const lines = setUpRecord(projectDir);

    const server = registerServer(projectDir, tmbCommand);
    const configFile = shown(projectDir, server.file);
    if (!server.changed) lines.push(`${configFile} already registers the tmb tool server; nothing to add.`);
    else lines.push(server.created ? `Created ${configFile} with the tmb tool server.` : `Registered the tmb tool server in ${configFile}.`);
    if (server.gitignoreChanged) lines.push(`Added ${configFile} to .gitignore.`);

    const hooks = installHooks(projectDir, tmbCommand);
    const hooksFile = shown(projectDir, hooks.file);
    lines.push(hooks.hooksAdded.length > 0 ? `Added ${hooksNamed(hooks.hooksAdded)} to ${hooksFile}.` : `${hooksFile} already has tmb's hooks; nothing to add.`);
    if (hooks.hooksRemoved.length > 0) lines.push(`Removed tmb's hooks this version no longer wires under ${listed(hooks.hooksRemoved)} from ${hooksFile}.`);
    if (hooks.gitignoreChanged) lines.push(`Added ${hooksFile} to .gitignore.`);

    lines.push(...setUpRoleFiles(projectDir, roles));
    return lines;
  },

  remove(projectDir) {
    const lines: string[] = [];
    // Role files go first, so the later removals can drop a .codex folder they leave empty.
    for (const roleFile of removeRoleFiles(projectDir)) lines.push(`Removed tmb's role file ${shown(projectDir, roleFile)}.`);

    const hooks = removeHooks(projectDir);
    const hooksFile = shown(projectDir, hooks.file);
    if (hooks.hooksRemoved.length === 0) lines.push(`No tmb hook found in ${hooksFile}; nothing to remove.`);
    else lines.push(hooks.fileDeleted ? `Removed ${hooksNamed(hooks.hooksRemoved)}, then the now-empty ${hooksFile}.` : `Removed ${hooksNamed(hooks.hooksRemoved)} from ${hooksFile}.`);

    const server = unregisterServer(projectDir);
    const configFile = shown(projectDir, server.file);
    if (!server.removed) lines.push(`No tmb tool server found in ${configFile}; nothing to remove.`);
    else lines.push(server.fileDeleted ? `Removed the tmb tool server and the now-empty ${configFile}.` : `Removed the tmb tool server from ${configFile}.`);

    lines.push(...keptRecordLine(projectDir));
    return lines;
  },

  pendingSteps,

  answerHook,
};
