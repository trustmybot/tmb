// Everything Claude Code-specific that tmb names: the host, its files, tmb's marker, its caps.
// One place, so no other file spells a Claude Code path or number of its own.
import path from "node:path";
import { PROJECT_DIR_NAME } from "../../engine/index.ts";

export const HOST_ID = "claude-code";
export const HOST_NAME = "Claude Code";
/** The program the Human runs to start Claude Code. */
export const HOST_COMMAND = "claude";
export const RECONNECT_TOOL_SERVER = "run `/mcp`, then Reconnect on tmb";

/** tmb's key among the project's tool servers, and the prefix Claude Code gives tmb's tools. */
export const SERVER_KEY = "tmb";

export const FILES = {
  /** Project-scoped tool servers. */
  mcpJson: ".mcp.json",
  /** Records that init created .mcp.json, so remove deletes the file only when it was tmb's. */
  mcpJsonCreatedMarker: path.join(PROJECT_DIR_NAME, "claude-code-created.json"),
  /** The Human's per-user, per-project settings: tmb's hooks and the enabled tool server. */
  settings: path.join(".claude", "settings.local.json"),
  /** The settings file as .gitignore names it. */
  settingsGitignoreEntry: ".claude/settings.local.json",
  /** Subagent definitions, one `<name>.md` each. */
  agentsDir: path.join(".claude", "agents"),
  /** Skills, one `<name>/SKILL.md` each. */
  skillsDir: path.join(".claude", "skills"),
  skillFile: "SKILL.md",
} as const;

/** The settings key that lists the enabled servers from .mcp.json. */
export const ENABLED_SERVERS_KEY = "enabledMcpjsonServers";

/**
 * A YAML comment as the frontmatter's first line: Claude Code ignores it, and it tells tmb the file
 * is its own. `earlier` is the marker builds before tmb init wrote, still recognised and replaced or removed.
 */
export const MARKERS = {
  current: "# Written by tmb init and deleted by tmb remove; tmb init replaces any edit.",
  earlier: "# Written by tmb setup and deleted by tmb remove; tmb setup replaces any edit.",
} as const;

/**
 * Claude Code's cap on one text a hook gives it, in characters. Over it, the model sees a path and
 * the first 2,000 characters only; the cap is per text, and cannot be raised.
 */
export const HOOK_TEXT_CAP = 10_000;
/** The most each session-start text may have: below the cap, so a text tmb fits is never cut by Claude Code. */
export const SESSION_TEXT_BUDGET = 8_000;

/** The subagent Claude Code starts when the call names no subagent_type. */
export const DEFAULT_SUBAGENT = "general-purpose";
