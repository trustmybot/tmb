// The one place that lists host adapters. Everything else reaches a host through the
// HostAdapter interface, so a new host is a new adapter and an entry here.
import { adapter as claudeCode } from "./claude-code/index.ts";
import type { HostAdapter } from "./host-adapter.ts";

export const HOST_ADAPTERS: readonly HostAdapter[] = [claudeCode];

/** The adapter the command line wires and answers through: the first listed, the only host so far. */
export function hostAdapter(): HostAdapter {
  return HOST_ADAPTERS[0]!;
}

// The plugin tmb replaces ran on Claude Code only, so migrating from it is that adapter's.
export { findPluginDb, MigrationError, migratePluginProject, type MigrationResult } from "./claude-code/migrate-plugin.ts";
export type { HostAdapter, HostDetection, HostLimits } from "./host-adapter.ts";
