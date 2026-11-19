import type { SubagentRole, TmbEventType } from "../engine/index.ts";

/** Whether the host is installed on this machine, and its version when it says. */
export type HostDetection = { installed: boolean; version?: string };

/** What the host can do, so the engine can fall back or refuse where it cannot. */
export type HostLimits = {
  /** The host asks before a tool call and obeys a deny. */
  canDenyToolCall: boolean;
  /** The host runs each subagent role on the model its role file names. */
  modelPerRole: boolean;
  /** The tmb events the host raises. */
  events: readonly TmbEventType[];
};

/** What every host adapter gives the command line. */
export interface HostAdapter {
  /** The host's id: what `--host` takes and what the record stores as the project's host. */
  id: string;
  /** The host's display name. */
  name: string;
  limits: HostLimits;
  /** Looks for the host's program; `searchPath` replaces PATH for the lookup. Never throws. */
  detect(searchPath?: string): HostDetection;
  /**
   * Wires the host to tmb in the project; returns what changed, one line each. `tmbCommand`
   * runs this tmb: its executable, then its entry file when it runs from source. `roles` are
   * the subagent roles to write, the engine's list unless given.
   */
  setup(projectDir: string, tmbCommand: readonly string[], roles?: readonly SubagentRole[]): string[];
  /** Undoes exactly what setup added; returns what changed, one line each. */
  remove(projectDir: string): string[];
  /** Answers a host event: the host's stdin in, the host's stdout out (empty when there is nothing to say). Throws on bad input. */
  answerHook(event: string, stdinText: string): string;
}
