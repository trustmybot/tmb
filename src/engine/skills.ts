// tmb's own skills: each holds one situational procedure of tmb's harness, written once in
// host-neutral form, which a role loads when its trigger fires so the role's always-loaded prompt
// stays short. Each host adapter writes them in its host's own format.
import codeGraphKnowledge from "../../skills/tmb-code-graph-knowledge.md" with { type: "text" };
import feedback from "../../skills/tmb-feedback.md" with { type: "text" };
import onboarding from "../../skills/tmb-onboarding.md" with { type: "text" };
import recovery from "../../skills/tmb-recovery.md" with { type: "text" };
import spec from "../../skills/tmb-spec.md" with { type: "text" };
import truest from "../../skills/tmb-truest.md" with { type: "text" };
import { namingProgram } from "./program.ts";

export type Skill = {
  /** The skill's name, which is also its folder's or file's name: lowercase letters, digits and hyphens. */
  name: string;
  /** Who loads it and when: its trigger, in one line, which the host shows the model to pick it by. */
  description: string;
  /** The procedure, naming the running program in its commands. */
  prompt: string;
};

/** A skill whose prompt is read when it is written and when its written file is compared, so both name the running program. */
function skill(name: string, description: string, text: string): Skill {
  return {
    name,
    description,
    get prompt() {
      return namingProgram(text);
    },
  };
}

export const SKILLS: readonly Skill[] = [
  skill(
    "tmb-onboarding",
    "For tmb's planner: when a session starts with the project's settings empty, or the Human asks to change the base branch, the checks or the review mode. How to apply the settings you recommend and ask the Human for the review mode.",
    onboarding,
  ),
  skill(
    "tmb-spec",
    "For tmb's planner: before each task_start. How to scope the task from tmb's code graph and write its spec: intent, files, success criteria and checks.",
    spec,
  ),
  skill(
    "tmb-truest",
    "For tmb's planner: when the project's or a repo's review mode is truest, from task_start to the task's pull request. Each task's own review, rework after a fail, and task_pr.",
    truest,
  ),
  skill(
    "tmb-recovery",
    "For tmb's planner: when a tmb step fails or stalls: task_close or feature_update refused, the reviewer failed a branch, a run never ended, or a task or feature branch nobody will finish. What to do for each, and how to drop a task or a feature branch.",
    recovery,
  ),
  skill(
    "tmb-code-graph-knowledge",
    "For tmb's planner: at onboarding once the code graph is built, when graph_areas shows files in no area or an area marked broken or for review, when the Human asks to change the project's areas, or when you learn a flow or a rule that spans files. How to write areas and record concepts.",
    codeGraphKnowledge,
  ),
  skill(
    "tmb-feedback",
    "For tmb's planner: when a tmb tool or command fails in a way that is tmb's fault, not the project's. How to draft a bug report for tmb's maintainers, show it to the Human and send it only after their yes.",
    feedback,
  ),
];
