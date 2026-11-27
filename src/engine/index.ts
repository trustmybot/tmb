import type { FeedbackEnv } from "./feedback/index.ts";
import { endHostReviewerRun, isReviewerHost, NO_VERDICT } from "./host-runs.ts";
import { openProjectStore } from "./project.ts";
import { type SessionStartTexts, sessionRole, sessionStartContext } from "./session-start.ts";

/**
 * A host-neutral event, raised by a host adapter. `unattended` is true when no one can answer
 * in the run, as whoever started tmb said. `host` is the adapter's id; an event with none is
 * answered as the planner's. A session start answers with the project's state, and the role too
 * unless `texts` says the host takes it apart, from `session-role`, which only reads.
 */
export type EngineEvent =
  | { type: "session-start"; projectDir: string; unattended: boolean; host?: string; feedback?: FeedbackEnv; refreshed?: string | null; doctor?: (projectDir: string) => string | null; texts?: SessionStartTexts }
  | { type: "session-role"; projectDir: string; host?: string }
  | { type: "session-end"; projectDir: string; host: string };

export type EngineAnswer = { context: string };

/** A reviewer host's session that ends before its verdict ends its run with none. Never throws. */
function sessionEnd(projectDir: string, host: string): void {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) return;
  try {
    if (isReviewerHost(opened.store, host)) endHostReviewerRun(opened.store, host, NO_VERDICT);
  } catch {
    // A session's end must never fail the host; the run stays open, and an open run is a finding.
  } finally {
    opened.store.close();
  }
}

export function handleEvent(event: EngineEvent): EngineAnswer {
  switch (event.type) {
    case "session-start":
      return { context: sessionStartContext(event.projectDir, event.unattended, event.host, event.feedback, event.refreshed ?? null, event.doctor, event.texts) };
    case "session-role":
      return { context: sessionRole(event.projectDir, event.host) };
    case "session-end":
      sessionEnd(event.projectDir, event.host);
      return { context: "" };
  }
}

export { type Decision, decide, MAIN_AGENT, UNNAMED_AGENT, TMB_EVENT_TYPES, type TmbEvent, type TmbEventType } from "./decide.ts";
export { CAPABILITIES, type Capability, SUBAGENT_ROLES, type SubagentRole } from "./roles.ts";
export { type Skill, SKILLS } from "./skills.ts";
export { OPERATIONS } from "./handlers/index.ts";
export { installPushGate, installPushGates, judgePush, pushGateGaps, parsePushRefs, type PushRef, removePushGate, removePushGates } from "./push-gate.ts";
export {
  AWAITING_REVIEW_HEADING,
  DOCTOR_HEADING,
  EMPTY_SETTINGS_HEADING,
  HOST_FILES_HEADING,
  OPEN_WORK_HEADING,
  OPEN_WORK_MAX,
  PULL_REQUESTS_ENDED_HEADING,
  plannerRole,
  reviewerRole,
  type SessionStartTexts,
  UNATTENDED_INSTRUCTION,
} from "./session-start.ts";
export { NO_VERDICT } from "./host-runs.ts";
export { type FeedbackEnv, feedbackEnv } from "./feedback/index.ts";
export { FEEDBACK_HEADING, firstRunAtInit } from "./feedback/first-run.ts";
export { openProjectStore, PROJECT_DIR_NAME, projectDbPath, projectRootOf } from "./project.ts";
export { detectBaseBranch, FALLBACK_BASE_BRANCH } from "./base-branch.ts";
export { type ProgramTie, recordProgramMove, tiedProgram, tieProgram } from "./program-tie.ts";
export { detectChecks } from "./check-detection.ts";
export {
  AVAILABLE_REVIEW_MODES,
  chooseReviewMode,
  DEFAULT_HOST_ROLE,
  HOST_ROLES,
  type HostRole,
  hostRole,
  type HostRoles,
  validateHostRole,
  readSettings,
  RECOMMENDED_REVIEW_MODE,
  REVIEW_MODE_COSTS,
  REVIEW_MODES,
  type ReviewMode,
  type ReviewModeChooser,
  reviewModeChosenVia,
  reviewModeOf,
  SETTING_NAMES,
  SettingError,
  type SettingName,
  settingLines,
  type Settings,
  type SettingValues,
  validateSetting,
  writeSetting,
} from "./settings.ts";
