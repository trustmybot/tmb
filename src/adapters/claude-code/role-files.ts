// Claude Code reads subagent definitions from the project's .claude/agents/<name>.md. tmb
// writes one file per subagent role, marks it as its own, and never touches an agent file
// it did not write.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CAPABILITIES, type Capability, type SubagentRole } from "../../engine/index.ts";
import { deleteFile } from "../common/json-file.ts";

const AGENTS_RELATIVE = path.join(".claude", "agents");
// A YAML comment as the frontmatter's first line: Claude Code ignores it, and it tells tmb the file is its own.
export const MARKER = "# Written by tmb init and deleted by tmb remove; tmb init replaces any edit.";
// The marker builds before tmb init wrote, so their files are still recognised and replaced or removed.
const EARLIER_MARKER = "# Written by tmb setup and deleted by tmb remove; tmb setup replaces any edit.";
const ROLE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Claude Code's own tools for each capability. A role is denied the tools of the capabilities
 * it lacks and keeps every other tool, so a project's own tools and any new tool of the host
 * reach it. Claude Code enforces the denial itself.
 */
export const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  "read-files": ["Read", "Glob", "Grep"],
  "edit-files": ["Edit", "Write", "NotebookEdit"],
  "run-commands": ["Bash"],
};

/** The agent file's deny list: the host tools of every capability the role lacks. */
export function roleDeniedTools(role: SubagentRole): string[] {
  return CAPABILITIES.filter((capability) => !role.capabilities.includes(capability)).flatMap((capability) => CAPABILITY_TOOLS[capability]);
}

export function agentsDir(projectDir: string): string {
  return path.join(projectDir, AGENTS_RELATIVE);
}

export function roleFilePath(projectDir: string, roleName: string): string {
  return path.join(agentsDir(projectDir), `${roleName}.md`);
}

/** Whether tmb wrote the file: its frontmatter opens with tmb's marker. Role files and skill files share it. */
export function isTmbFile(file: string): boolean {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return [MARKER, EARLIER_MARKER].some((marker) => text.startsWith(`---\n${marker}\n`));
}

/**
 * The role as a Claude Code agent file. Values are JSON strings, which YAML reads as quoted
 * scalars; the deny list is one comma-separated string, the form Claude Code documents, and
 * a role that lacks no capability has none.
 */
export function roleFileText(role: SubagentRole): string {
  const lines = [
    "---",
    MARKER,
    `name: ${JSON.stringify(role.name)}`,
    `description: ${JSON.stringify(role.description)}`,
  ];
  const denied = roleDeniedTools(role);
  if (denied.length > 0) lines.push(`disallowedTools: ${JSON.stringify(denied.join(", "))}`);
  // Claude Code makes the worktree the role's working folder and keeps its edits there; tmb adopts it as the task's.
  if (role.ownWorktree) lines.push(`isolation: "worktree"`);
  if (role.model) lines.push(`model: ${JSON.stringify(role.model)}`);
  if (role.effort) lines.push(`effort: ${JSON.stringify(role.effort)}`);
  lines.push("---", "", role.prompt.trimEnd(), "");
  return lines.join("\n");
}

/** Role names in each outcome: written or rewritten, already current, or left alone because the file is not tmb's. */
export type RoleFilesResult = { written: string[]; current: string[]; notOurs: string[]; removed: string[] };

export function writeRoleFiles(projectDir: string, roles: readonly SubagentRole[]): RoleFilesResult {
  const result: RoleFilesResult = { written: [], current: [], notOurs: [], removed: [] };
  for (const role of roles) {
    if (!ROLE_NAME.test(role.name)) throw new Error(`role name ${JSON.stringify(role.name)} must be lowercase letters, digits and hyphens`);
    const file = roleFilePath(projectDir, role.name);
    const text = roleFileText(role);
    if (existsSync(file)) {
      if (!isTmbFile(file)) {
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
    if (!entry.isFile() || !entry.name.endsWith(".md") || !only(file) || !isTmbFile(file)) continue;
    deleteFile(file, projectDir);
    removed.push(file);
  }
  return removed;
}

/** What `tmb doctor` finds wrong with tmb's role files: one line each, none when init would change nothing. Never writes. */
export function roleFileGaps(projectDir: string, roles: readonly SubagentRole[]): string[] {
  const gaps: string[] = [];
  for (const role of roles) {
    const file = roleFilePath(projectDir, role.name);
    const shown = path.relative(projectDir, file);
    if (!existsSync(file)) gaps.push(`${shown} is missing: the ${role.name} role is not written`);
    else if (!isTmbFile(file)) gaps.push(`${shown} is not tmb's, so the ${role.name} role is not tmb's either; tmb leaves it alone`);
    else if (readFileSync(file, "utf8") !== roleFileText(role)) gaps.push(`${shown} is not this version's ${role.name} role`);
  }
  const wanted = new Set(roles.map((role) => roleFilePath(projectDir, role.name)));
  const dir = agentsDir(projectDir);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md") && !wanted.has(file) && isTmbFile(file)) {
        gaps.push(`${path.relative(projectDir, file)} is tmb's role file for a role this version no longer has`);
      }
    }
  }
  return gaps;
}
