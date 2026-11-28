// The subagent roles, written once in host-neutral form; each host adapter writes them in
// its host's own format.
import reviewerPrompt from "../../roles/reviewer.md" with { type: "text" };
import workerPrompt from "../../roles/worker.md" with { type: "text" };
import { namingProgram } from "./program.ts";
import { openProjectStore } from "./project.ts";
import type { ProjectRole, Store } from "./store/index.ts";

/** What a role may do, in host-neutral terms; each adapter maps these onto its host's tools. Every role also gets tmb's own tools. */
export const CAPABILITIES = ["read-files", "edit-files", "run-commands"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type SubagentRole = {
  /** The role's name, which is also its file name: lowercase letters, digits and hyphens. */
  name: string;
  /** When the host should start this role, in one line. */
  description: string;
  /** The role's prompt, naming the running program in its commands. */
  prompt: string;
  capabilities: readonly Capability[];
  /** The host starts the role in a worktree of its own, which tmb adopts as the task's. */
  ownWorktree?: boolean;
  model?: string;
  effort?: string;
};

/** The planner is the host's main agent, not a subagent, so it is not listed here. */
export const SUBAGENT_ROLES: readonly SubagentRole[] = [
  {
    name: "worker",
    description:
      "Carries out one task's spec in the task's own worktree, runs its checks and closes it. Start it only after task_start, with the task's task_id=<id> line at the head of its prompt.",
    // Read when the role is written and when its written file is compared, so both name the running program.
    get prompt() {
      return namingProgram(workerPrompt);
    },
    capabilities: ["read-files", "edit-files", "run-commands"],
    ownWorktree: true,
  },
  {
    name: "reviewer",
    description:
      "Judges a whole feature branch it did not write, before its pull request opens, for whether it breaks other behaviour, and records a pass or fail verdict with review_record. Start it with the feature=<name> line from feature_brief at the head of its prompt. It cannot edit files.",
    get prompt() {
      return namingProgram(reviewerPrompt);
    },
    capabilities: ["read-files", "run-commands"],
  },
];

/**
 * A role the project created, as its agent file is written: the prompt the planner wrote, then the
 * one line every tmb role carries, so its tool calls name it. It keeps every host tool: a role file
 * takes away only what the role must never use.
 */
export function createdSubagentRole(role: ProjectRole): SubagentRole {
  return {
    name: role.name,
    description: role.purpose,
    prompt: `${role.prompt.trimEnd()}\n\nPass \`role: "${role.name}"\` on every call to tmb's tools.\n`,
    capabilities: CAPABILITIES,
  };
}

/** Every subagent role in a project: the ones tmb ships, then the ones the project created. */
export function subagentRolesOf(store: Store): SubagentRole[] {
  return [...SUBAGENT_ROLES, ...store.listRoles().map(createdSubagentRole)];
}

/**
 * The project's subagent roles, read from its record; only the ones tmb ships before it has one.
 * Throws when the record cannot be read, so no created role's file is taken for one tmb no longer has.
 */
export function projectSubagentRoles(projectDir: string): SubagentRole[] {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    if (opened.error.failure === "missing") return [...SUBAGENT_ROLES];
    throw new Error(`tmb cannot read the record for its roles: ${opened.error.message}`);
  }
  try {
    return subagentRolesOf(opened.store);
  } finally {
    opened.store.close();
  }
}
