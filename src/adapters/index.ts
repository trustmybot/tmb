// The one place that lists host adapters. Everything else reaches a host through the
// HostAdapter interface, so a new host is a new adapter and an entry here.
import { adapter as claudeCode } from "./claude-code/index.ts";
import { adapter as codex } from "./codex/index.ts";
import type { HostAdapter } from "./host-adapter.ts";

export const HOST_ADAPTERS: readonly HostAdapter[] = [claudeCode, codex];

/** The host a hook that names none comes from: Claude Code, the first host tmb wired. */
export const DEFAULT_HOST_ID = claudeCode.id;

/** The adapter with the id; throws, naming the hosts tmb knows, when there is none. */
export function adapterById(id: string): HostAdapter {
  const found = HOST_ADAPTERS.find((adapter) => adapter.id === id);
  if (!found) throw new Error(`unknown host '${id}'; tmb knows ${HOST_ADAPTERS.map((adapter) => adapter.id).join(", ")}`);
  return found;
}

// The plugin tmb replaces ran on Claude Code only, so migrating from it is that adapter's.
export { findPluginDb, MigrationError, migratePluginProject, type MigrationResult } from "./claude-code/migrate-plugin.ts";
export type { HostAdapter, HostDetection, HostLimits } from "./host-adapter.ts";
