// Codex reads custom agents from the project's .codex/agents/<name>.toml. tmb writes one file
// per subagent role, marks it as its own, and never touches an agent file it did not write.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SubagentRole } from "../../engine/index.ts";
import { deleteFile } from "../common/json-file.ts";
import { agentsDir } from "./paths.ts";

const MARKER = "# Written by tmb init and deleted by tmb remove; tmb init replaces any edit.";
// The marker builds before tmb init wrote, so their files are still recognised and replaced or removed.
const EARLIER_MARKER = "# Written by tmb setup and deleted by tmb remove; tmb setup replaces any edit.";
const ROLE_NAME = /^[a-z][a-z0-9-]*$/;

export function roleFilePath(projectDir: string, roleName: string): string {
  return path.join(agentsDir(projectDir), `${roleName}.toml`);
}

function isTmbRoleFile(file: string): boolean {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return [MARKER, EARLIER_MARKER].some((marker) => text.startsWith(`${marker}\n`));
}

/**
 * The role as a Codex agent file. Values are JSON strings, which TOML reads as basic strings.
 * A role that may not run commands loses the shell tool. Codex has no per-agent switch for
 * file edits, and names no agent on a tool call, so a Codex reviewer can edit files; git's
 * pre-push hook still judges every push.
 */
export function roleFileText(role: SubagentRole): string {
  const lines = [
    MARKER,
    `name = ${JSON.stringify(role.name)}`,
    `description = ${JSON.stringify(role.description)}`,
    `developer_instructions = ${JSON.stringify(role.prompt.trimEnd())}`,
  ];
  if (role.model) lines.push(`model = ${JSON.stringify(role.model)}`);
  if (role.effort) lines.push(`model_reasoning_effort = ${JSON.stringify(role.effort)}`);
  if (!role.capabilities.includes("run-commands")) lines.push("", "[features]", "shell_tool = false");
  lines.push("");
  return lines.join("\n");
}

export type RoleFilesResult = { written: string[]; current: string[]; notOurs: string[]; removed: string[] };

export function writeRoleFiles(projectDir: string, roles: readonly SubagentRole[]): RoleFilesResult {
  const result: RoleFilesResult = { written: [], current: [], notOurs: [], removed: [] };
  for (const role of roles) {
    if (!ROLE_NAME.test(role.name)) throw new Error(`role name ${JSON.stringify(role.name)} must be lowercase letters, digits and hyphens`);
    const file = roleFilePath(projectDir, role.name);
    const text = roleFileText(role);
    if (existsSync(file)) {
      if (!isTmbRoleFile(file)) {
        result.notOurs.push(role.name);
        continue;
      }
      if (readFileSync(file, "utf8") === text) {
        result.current.push(role.name);
        continue;
      }
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    result.written.push(role.name);
  }
  // A role file of tmb's for a role this version no longer has goes, as tmb remove would take it.
  const wanted = new Set(roles.map((role) => roleFilePath(projectDir, role.name)));
  result.removed = removeRoleFiles(projectDir, (file) => !wanted.has(file));
  return result;
}

/** Deletes every agent file tmb marked as its own, or those of them `only` keeps; returns their paths. */
export function removeRoleFiles(projectDir: string, only: (file: string) => boolean = () => true): string[] {
  const dir = agentsDir(projectDir);
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".toml") || !only(file) || !isTmbRoleFile(file)) continue;
    deleteFile(file, projectDir);
    removed.push(file);
  }
  return removed;
}
