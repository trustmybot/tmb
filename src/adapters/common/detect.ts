import { spawnSync } from "node:child_process";
import type { HostDetection } from "../host-adapter.ts";

const VERSION = /\d+\.\d+\.\d+[^\s()]*/;

/** How long a host's `--version` may take before tmb stops waiting for it. */
export const HOST_VERSION_TIMEOUT_MS = 10_000;

/**
 * Runs `<program> --version`, with no shell, from PATH or from `searchPath` when given. A program
 * on the path that did not answer in time, or could not be started, is installed with no version
 * known: a loaded machine does not make a host missing (trustmybot/tmb#207). A program that
 * answered and failed is not. Never throws.
 */
export function detectProgram(program: string, searchPath?: string, timeoutMs = HOST_VERSION_TIMEOUT_MS): HostDetection {
  const binary = Bun.which(program, searchPath === undefined ? undefined : { PATH: searchPath });
  if (!binary) return { installed: false };
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: timeoutMs });
  if (result.error) return { installed: true };
  if (result.status !== 0) return { installed: false };
  const version = VERSION.exec(result.stdout)?.[0];
  return version ? { installed: true, version } : { installed: true };
}
