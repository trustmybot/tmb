// The subagent roles, written once in host-neutral form; each host adapter writes them in
// its host's own format.

export type SubagentRole = {
  /** The role's name, which is also its file name: lowercase letters, digits and hyphens. */
  name: string;
  /** When the host should start this role, in one line. */
  description: string;
  /** The role's prompt. */
  prompt: string;
  model?: string;
  effort?: string;
};

/** The planner is the host's main agent, not a subagent, so it is not listed here. */
export const SUBAGENT_ROLES: readonly SubagentRole[] = [];
