// The subagent roles, written once in host-neutral form; each host adapter writes them in
// its host's own format.
import reviewerPrompt from "../../roles/reviewer.md" with { type: "text" };
import workerPrompt from "../../roles/worker.md" with { type: "text" };
import { namingProgram } from "../program.ts";

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
