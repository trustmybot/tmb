import { sessionStartContext } from "./session-start.ts";

/** A host-neutral event, raised by a host adapter. */
export type EngineEvent = { type: "session-start"; projectDir: string };

export type EngineAnswer = { context: string };

export function handleEvent(event: EngineEvent): EngineAnswer {
  switch (event.type) {
    case "session-start":
      return { context: sessionStartContext(event.projectDir) };
  }
}

export { type Decision, decide, TMB_EVENT_TYPES, type TmbEvent, type TmbEventType } from "./decide.ts";
export { CAPABILITIES, type Capability, SUBAGENT_ROLES, type SubagentRole } from "./roles.ts";
export { OPERATIONS } from "./handlers/index.ts";
export { OPEN_WORK_HEADING, OPEN_WORK_MAX, plannerRole } from "./session-start.ts";
export { openProjectStore, PROJECT_DIR_NAME, projectDbPath, projectRootOf } from "./project.ts";
export { detectBaseBranch, FALLBACK_BASE_BRANCH } from "./base-branch.ts";
export { detectChecks } from "./check-detection.ts";
export {
  AVAILABLE_REVIEW_MODES,
  readSettings,
  REVIEW_MODES,
  type ReviewMode,
  SETTING_NAMES,
  SettingError,
  type SettingName,
  settingLines,
  type Settings,
  type SettingValues,
  validateSetting,
  writeSetting,
} from "./settings.ts";
