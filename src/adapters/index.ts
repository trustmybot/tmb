// The one place that lists host adapters. Everything else reaches a host through the
// HostAdapter interface, so a new host is a new adapter and an entry here.
import { adapter as claudeCode } from "./claude-code/index.ts";
import type { HostAdapter } from "./host-adapter.ts";
import { HostRegistry } from "./registry.ts";

/**
 * The hosts this release supports are Claude Code's. Another host can be set up so its work can be
 * tried, but init says it is not supported yet: mixed agent support is out of v1 (trustmybot/tmb#18).
 * A hook that names no host comes from Claude Code, the first host tmb wired.
 */
const registry = new HostRegistry([claudeCode], [claudeCode.id], claudeCode.id);

export const HOST_ADAPTERS: readonly HostAdapter[] = registry.all;
export const SUPPORTED_HOST_IDS: readonly string[] = registry.supportedIds;
export const DEFAULT_HOST_ID: string = registry.defaultId;

/** The adapter with the id; throws, naming the hosts tmb knows, when there is none. */
export function adapterById(id: string): HostAdapter {
  return registry.byId(id);
}

// The plugin tmb replaces ran on Claude Code only, so migrating from it is that adapter's.
export {
  findPluginDb,
  MigrationError,
  migratePluginProject,
  migratePluginWorkspace,
  type MigrationResult,
  type WorkspaceMigration,
} from "./claude-code/migrate-plugin.ts";
export type { HookRun, HostAdapter, HostDetection, HostLimits, SessionTextLimit } from "./host-adapter.ts";
export { HostRegistry } from "./registry.ts";
