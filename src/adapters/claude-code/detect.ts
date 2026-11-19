import { spawnSync } from "node:child_process";
import type { HostDetection } from "../host-adapter.ts";

const VERSION = /\d+\.\d+\.\d+[^\s()]*/;

/** Runs `claude --version`, with no shell, from PATH or from `searchPath` when given. */
export function detect(searchPath?: string): HostDetection {
  const binary = Bun.which("claude", searchPath === undefined ? undefined : { PATH: searchPath });
  if (!binary) return { installed: false };
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) return { installed: false };
  const version = VERSION.exec(result.stdout)?.[0];
  return version ? { installed: true, version } : { installed: true };
}
