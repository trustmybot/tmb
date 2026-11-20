import type { HostDetection } from "../host-adapter.ts";
import { detectProgram } from "../common/detect.ts";

/** Runs `claude --version`, with no shell, from PATH or from `searchPath` when given. */
export function detect(searchPath?: string): HostDetection {
  return detectProgram("claude", searchPath);
}
