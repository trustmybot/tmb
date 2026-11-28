// Claude Code reads subagent definitions from the project's .claude/agents/<name>.md. tmb
// writes one file per subagent role, marks it as its own, and never touches an agent file
// it did not write.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CAPABILITIES, type Capability, inGitWorkTree, type SubagentRole } from "../../engine/index.ts";
import { MarkedFiles } from "../common/marked-files.ts";
import { FILES, MARKERS } from "./host.ts";

const ROLE_FILE_EXTENSION = ".md";

/**
 * Claude Code's own tools for each capability. A role is denied the tools of the capabilities
 * it lacks and keeps every other tool, so a project's own tools and any new tool of the host
 * reach it. Claude Code enforces the denial itself.
 */
export const CAPABILITY_TOOLS: Readonly<Record<Capability, readonly string[]>> = {
  "read-files": ["Read", "Glob", "Grep"],
  "edit-files": ["Edit", "Write", "NotebookEdit"],
  "run-commands": ["Bash"],
};

/** The agent file's deny list: the host tools of every capability the role lacks. */
export function roleDeniedTools(role: SubagentRole): string[] {
  return CAPABILITIES.filter((capability) => !role.capabilities.includes(capability)).flatMap((capability) => CAPABILITY_TOOLS[capability]);
}

/** Whether tmb wrote the file: its frontmatter opens with tmb's marker. Role files and skill files share it. */
export function isTmbFile(file: string): boolean {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return [MARKERS.current, MARKERS.earlier].some((marker) => text.startsWith(`---\n${marker}\n`));
}

/**
 * Where Claude Code can make a subagent's worktree: it cuts one only from a git work tree, so a
 * workspace folder that holds repos and is none gets no worktree from it (trustmybot/tmb#463).
 */
export type RoleFileOptions = { readonly hostWorktree: boolean };

/**
 * The role as a Claude Code agent file. Values are JSON strings, which YAML reads as quoted
 * scalars; the deny list is one comma-separated string, the form Claude Code documents, and
 * a role that lacks no capability has none.
 */
export function roleFileText(role: SubagentRole, options: RoleFileOptions = { hostWorktree: true }): string {
  const lines = ["---", MARKERS.current, `name: ${JSON.stringify(role.name)}`, `description: ${JSON.stringify(role.description)}`];
  const denied = roleDeniedTools(role);
  if (denied.length > 0) lines.push(`disallowedTools: ${JSON.stringify(denied.join(", "))}`);
  // Claude Code makes the worktree the role's working folder and keeps its edits there; tmb adopts it as the task's.
  // Where it cannot make one, the start would fail, so the role starts without and works in the worktree tmb cut.
  if (role.ownWorktree && options.hostWorktree) lines.push(`isolation: "worktree"`);
  if (role.model) lines.push(`model: ${JSON.stringify(role.model)}`);
  if (role.effort) lines.push(`effort: ${JSON.stringify(role.effort)}`);
  lines.push("---", "", role.prompt.trimEnd(), "");
  return lines.join("\n");
}

/** tmb's agent files in the project's .claude/agents. */
export class RoleFiles extends MarkedFiles<SubagentRole> {
  constructor() {
    super("role");
  }

  dir(projectDir: string): string {
    return path.join(projectDir, FILES.agentsDir);
  }

  filePath(projectDir: string, roleName: string): string {
    return path.join(this.dir(projectDir), `${roleName}${ROLE_FILE_EXTENSION}`);
  }

  /** Whether Claude Code can make a role's worktree in the project, as its agent files are written for. */
  options(projectDir: string): RoleFileOptions {
    return { hostWorktree: inGitWorkTree(projectDir) };
  }

  protected override textOf(projectDir: string): (role: SubagentRole) => string {
    const options = this.options(projectDir);
    return (role) => roleFileText(role, options);
  }

  protected override isOurs(file: string): boolean {
    return isTmbFile(file);
  }

  protected override ownedFiles(projectDir: string, only: (file: string) => boolean): string[] {
    const dir = this.dir(projectDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((entry) => entry.isFile() && entry.name.endsWith(ROLE_FILE_EXTENSION))
      .map((entry) => path.join(dir, entry.name))
      .filter((file) => only(file) && isTmbFile(file));
  }
}
