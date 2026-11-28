// The Claude Code adapter: one class over small collaborators, each owning one of the host's files
// or formats. Its names, paths and caps are in host.ts.
import { type ModelUsage, SKILLS, SUBAGENT_ROLES, type SubagentRole, TMB_EVENT_TYPES } from "../../engine/index.ts";
import { detectProgram } from "../common/detect.ts";
import { keptRecordLine, listed, setUpRecord, shown } from "../common/record.ts";
import type { HookRun, HostAdapter, HostDetection, HostLimits, SessionTextLimit } from "../host-adapter.ts";
import { HookTranslator } from "./hook.ts";
import { HOOK_TEXT_CAP, HOST_COMMAND, HOST_ID, HOST_NAME, RECONNECT_TOOL_SERVER, SESSION_TEXT_BUDGET } from "./host.ts";
import { McpJsonFile } from "./mcp-json.ts";
import { RoleFiles } from "./role-files.ts";
import { SettingsFile } from "./settings.ts";
import { SkillFiles } from "./skill-files.ts";
import { usageOfTranscriptFile } from "./usage.ts";
import { WorktreeLinks } from "./worktree-links.ts";

/** What the adapter is made of; each part is passed in, so a test can hand in its own. */
export type ClaudeCodeParts = {
  readonly toolServer: McpJsonFile;
  readonly settings: SettingsFile;
  readonly roleFiles: RoleFiles;
  readonly skillFiles: SkillFiles;
  readonly hooks: HookTranslator;
  readonly worktreeLinks: WorktreeLinks;
};

/** The parts as tmb ships them. */
export function defaultParts(): ClaudeCodeParts {
  const settings = new SettingsFile();
  return {
    toolServer: new McpJsonFile(),
    settings,
    roleFiles: new RoleFiles(),
    skillFiles: new SkillFiles(),
    hooks: new HookTranslator(settings, usageOfTranscriptFile),
    worktreeLinks: new WorktreeLinks(),
  };
}

const hooksNamed = (events: readonly string[]) => `the ${listed(events)} hook${events.length > 1 ? "s" : ""}`;

export class ClaudeCodeAdapter implements HostAdapter {
  readonly id = HOST_ID;
  readonly name = HOST_NAME;
  readonly command = HOST_COMMAND;
  readonly reconnectToolServer = RECONNECT_TOOL_SERVER;
  readonly limits: HostLimits = {
    canDenyToolCall: true,
    modelPerRole: true,
    namesAgentOnToolCall: true,
    events: TMB_EVENT_TYPES,
  };
  readonly sessionText: SessionTextLimit = { cap: HOOK_TEXT_CAP, budget: SESSION_TEXT_BUDGET };

  constructor(readonly parts: ClaudeCodeParts = defaultParts()) {}

  /** Runs `claude --version`, with no shell, from PATH or from `searchPath` when given. */
  detect(searchPath?: string): HostDetection {
    return detectProgram(HOST_COMMAND, searchPath);
  }

  sessionTitle(stdinText: string): string | null {
    // Claude Code passes `session_title` at a session start when the Human named the session (`--name` or `/rename`).
    try {
      const title = (JSON.parse(stdinText) as { session_title?: unknown }).session_title;
      return typeof title === "string" && title.trim() !== "" ? title.trim() : null;
    } catch {
      return null;
    }
  }

  setup(projectDir: string, tmbCommand: readonly string[], roles: readonly SubagentRole[] = SUBAGENT_ROLES): string[] {
    const { toolServer, settings, roleFiles, skillFiles } = this.parts;
    const lines = setUpRecord(projectDir);

    const server = toolServer.register(projectDir, tmbCommand);
    const mcpFile = shown(projectDir, server.file);
    if (!server.changed) lines.push(`${mcpFile} already registers the tmb tool server; nothing to add.`);
    else lines.push(server.created ? `Created ${mcpFile} with the tmb tool server.` : `Registered the tmb tool server in ${mcpFile}.`);
    if (server.gitignoreChanged) lines.push(`Added ${mcpFile} to .gitignore.`);

    const installed = settings.install(projectDir, tmbCommand);
    const file = shown(projectDir, installed.settingsFile);
    lines.push(
      installed.serverEnabled ? `Enabled the tmb tool server in ${file}.` : `${file} already enables the tmb tool server; nothing to add.`,
      installed.hooksAdded.length > 0 ? `Added ${hooksNamed(installed.hooksAdded)} to ${file}.` : `${file} already has tmb's hooks; nothing to add.`,
    );
    if (installed.hooksRemoved.length > 0) lines.push(`Removed tmb's hooks this version no longer wires under ${listed(installed.hooksRemoved)} from ${file}.`);
    if (installed.gitignoreChanged) lines.push(`Added ${file} to .gitignore.`);

    lines.push(...roleFiles.setUp(projectDir, roles), ...skillFiles.setUp(projectDir, SKILLS));
    return lines;
  }

  remove(projectDir: string): string[] {
    const { toolServer, settings, roleFiles, skillFiles } = this.parts;
    const lines: string[] = [];

    const server = toolServer.unregister(projectDir);
    const mcpFile = shown(projectDir, server.file);
    if (!server.removed) lines.push(`No tmb tool server found in ${mcpFile}; nothing to remove.`);
    else lines.push(server.fileDeleted ? `Removed the tmb tool server and the now-empty ${mcpFile}.` : `Removed the tmb tool server from ${mcpFile}.`);

    // Role and skill files go first, so the settings file's removal can drop a folder they leave empty.
    lines.push(...roleFiles.tearDown(projectDir), ...skillFiles.tearDown(projectDir), ...this.parts.worktreeLinks.set(projectDir, []));

    const removed = settings.remove(projectDir);
    const file = shown(projectDir, removed.settingsFile);
    if (removed.hooksRemoved.length === 0 && !removed.serverDisabled) {
      lines.push(`No tmb hook or enabled tmb tool server found in ${file}; nothing to remove.`);
    } else {
      const hooks = removed.hooksRemoved.length > 0 && hooksNamed(removed.hooksRemoved);
      const what = listed([hooks, removed.serverDisabled && "the tmb tool server's enabled entry"].filter((part): part is string => !!part));
      lines.push(removed.fileDeleted ? `Removed ${what}, then the now-empty ${file}.` : `Removed ${what} from ${file}.`);
    }

    lines.push(...keptRecordLine(projectDir));
    return lines;
  }

  shareFolders(projectDir: string, folders: readonly string[]): string[] {
    return this.parts.worktreeLinks.set(projectDir, folders);
  }

  wiringGaps(projectDir: string, tmbCommand: readonly string[], sharedFolders: readonly string[] = []): string[] {
    const { toolServer, settings, roleFiles, skillFiles, worktreeLinks } = this.parts;
    const server = toolServer.gap(projectDir, tmbCommand);
    return [
      ...(server === null ? [] : [server]),
      ...settings.gaps(projectDir, tmbCommand),
      ...worktreeLinks.gaps(projectDir, sharedFolders),
      ...roleFiles.gaps(projectDir, SUBAGENT_ROLES),
      ...skillFiles.gaps(projectDir, SKILLS),
    ];
  }

  answerHook(event: string, stdinText: string, run: HookRun): string {
    return this.parts.hooks.answer(event, stdinText, run);
  }

  readUsage(transcriptFile: string | undefined): ModelUsage[] | null {
    return usageOfTranscriptFile(transcriptFile);
  }
}

export const adapter = new ClaudeCodeAdapter();

/** The shipped adapter's own parts, for code that works on one of Claude Code's files alone. */
export const { toolServer, settings: settingsFile, roleFiles, skillFiles } = adapter.parts;
