// The processes above this one, which tie a hook to the session that runs it.
import { spawnSync } from "node:child_process";

/** How many processes up the tree a session is looked for. */
const ANCESTOR_DEPTH = 6;

/** The processes above `pid`, nearest first, up to `depth`; empty where they cannot be read. */
export function ancestorsOf(pid: number, ppid: number, platform: NodeJS.Platform, depth = ANCESTOR_DEPTH): number[] {
  if (platform === "win32") return [ppid];
  const found: number[] = [];
  let current = pid;
  for (let step = 0; step < depth; step++) {
    const parent = Number.parseInt(spawnSync("ps", ["-o", "ppid=", "-p", String(current)], { encoding: "utf8" }).stdout?.trim() ?? "", 10);
    if (!Number.isInteger(parent) || parent <= 1) break;
    found.push(parent);
    current = parent;
  }
  return found;
}
