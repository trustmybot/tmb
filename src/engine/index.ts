import type { FeedbackEnv } from "./feedback/index.ts";
import { endHostReviewerRun, isReviewerHost, NO_VERDICT } from "./host-runs.ts";
import { openProjectStore } from "./project.ts";
import { plannerTurnContext, type SessionStartTexts, sessionRole, sessionStartContext } from "./session-start.ts";

/**
 * A host-neutral event, raised by a host adapter. `unattended` is true when no one can answer
 * in the run, as whoever started tmb said. `host` is the adapter's id; an event with none is
 * answered as the planner's. A session start answers with the project's state, and the role too
 * unless `texts` says the host takes it apart, from `session-role`, which only reads. Before the
 * main agent's turn, `planner-turn` answers with what changed outside its chat, or nothing.
 */
export type EngineEvent =
  | { type: "session-start"; projectDir: string; unattended: boolean; host?: string; feedback?: FeedbackEnv; refreshed?: string | null; doctor?: (projectDir: string) => string | null; texts?: SessionStartTexts }
  | { type: "session-role"; projectDir: string; host?: string }
  | { type: "planner-turn"; projectDir: string; host?: string }
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
    case "planner-turn":
      return { context: plannerTurnContext(event.projectDir, event.host) };
    case "session-end":
      sessionEnd(event.projectDir, event.host);
      return { context: "" };
  }
}

export { type Decision, decide, MAIN_AGENT, UNNAMED_AGENT, TMB_EVENT_TYPES, type TmbEvent, type TmbEventType } from "./decide.ts";
export { CAPABILITIES, type Capability, createdSubagentRole, projectSubagentRoles, SUBAGENT_ROLES, type SubagentRole, subagentRolesOf } from "./roles.ts";
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
  plannerTurnContext,
  PULL_REQUESTS_ENDED_HEADING,
  plannerRole,
  reviewerRole,
  type SessionStartTexts,
  UNATTENDED_INSTRUCTION,
} from "./session-start.ts";
export { NO_VERDICT } from "./host-runs.ts";
export { OUTSIDE_CHANGES_HEADING, OUTSIDE_CHANGES_MAX, takeOutsideChanges } from "./outside-changes.ts";
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
  ISSUE_SYNC_COSTS,
  ISSUE_SYNC_MODES,
  DEFAULT_ISSUE_SYNC,
  type IssueSync,
  issueSyncOf,
  issueSyncOn,
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
  sharedFoldersOf,
  validateSetting,
  writeSetting,
} from "./settings.ts";
export { detectBaseBranchWithEvidence } from "./base-branch.ts";
export { feedbackExplanation } from "./feedback/first-run.ts";
export { channelFor, draftReport, draftText, GH_FEEDBACK_GITHUB, keepLastError, recentLastError, routeLine, sendDraft, setFeedback, statusOf } from "./feedback/index.ts";
export { runGit } from "./git.ts";
export { githubRepoOf, parseRemoteUrl } from "./github.ts";
export { type Area, areasOf, listAreas } from "./graph/areas.ts";
export { EXTRACTOR_VERSION, FUNCTION_KINDS, MINIFIED } from "./graph/build.ts";
export type { Concept } from "./graph/concepts.ts";
export { BASE_LAYER, graphDbPath, openGraphDb } from "./graph/db.ts";
export { indexProject, openView } from "./graph/fresh.ts";
export { baseCommit } from "./graph/git-source.ts";
export { SYMBOL_KINDS } from "./graph/languages/contract.ts";
export { languageNamed } from "./graph/languages/registry.ts";
export { type CallCounts, countsOf, type Hit, type MapResult, type RefRow, type ScopeResult, type SymbolCard, symbolCard } from "./graph/lookups.ts";
export { notReadLines, type NotReadNote, notReadSummary } from "./graph/not-read.ts";
export type { CallState } from "./graph/resolve.ts";
export { installsOff, machinePlaces } from "./graph/tool-copy.ts";
export { type InstallOptions, installTool, missingTools } from "./graph/tool-install.ts";
export { baseLanguages, toolLine, type ToolRow, toolRows } from "./graph/tool-report.ts";
export { DEFAULT_LINK_WAY } from "./graph/ways.ts";
export { endReadyLine, type OperationContext, type RemoteIssueAnswer, type RemoteIssueEdit, type RemoteIssueState, type RemoteIssueTarget, type RemoteIssueWriter } from "./handlers/common.ts";
export { HandlerError } from "./handlers/errors.ts";
export { keptCheckouts, removeTaskCheckout } from "./handlers/fold.ts";
export { type FeatureBrief, type FeatureDropResult, type FeaturePrResult, type FeatureSummary, type FeatureUpdateResult, type GraphAnswer, type IssueDetail, type IssueList, type IssueUpdateResult, markLine, markRequiredLine, type OperationName, type RoleChangeResult, type RoleView, type TaskBrief, type TaskCloseResult, type TaskDropResult, type TaskPrResult, type TaskStartResult, type TaskSummary, type TaskWaiveResult, type WaiveResult } from "./handlers/index.ts";
export { MARK_CONTEXT, requiredMarkOn, requireMarkHowTo } from "./handlers/marks.ts";
export { emptySettings } from "./handlers/settings.ts";
export { ACTIONS, type Action, DEFAULT_ROLES, defaultActions, effectiveActions, EVERY_ROLE, FIXED_HUMAN_ACTIONS, HUMAN_ROLE, isAction, isHumanStep, mayTake, requirePermission, type RoleActionChange, roleChangeRefusal, type RoleName } from "./permissions.ts";
export { HUMAN_YES, humanOnlyStep, humanYesQuestion, notConfirmedRefusal, noTerminalRefusal, unattendedChangeRefusal } from "./human-only.ts";
export { createIdFactory } from "./ids.ts";
export { type Channel, channelOf, CHANNELS, isCompiledEntry, type Program, programName, programOf, programStateDir, runningName, runningProgram } from "./program.ts";
export { type PullRequestReader, refreshPullRequestStates } from "./pull-request-state.ts";
export { pushActorFrom } from "./push-actor.ts";
export { addToForeignHook, FOREIGN_GAP, foreignHooks, handCallLine, NO_RECORD, otherProjectInRepo, pushGateOffLine, repoTopOf } from "./push-gate.ts";
export { inGitWorkTree, isManaged, type Repo, repoDirOf, repoOf, repoOfRow, type Scan, scanRepos, scanWorkspace, unnamedRepos, unnamedReposFix, workingRepos, workspaceRepos } from "./repos.ts";
export { type RepoPolicies, type RepoPolicy, repoPolicyLine, validateRepoName, WORKSPACE_REVIEW_MODE, writeRepos } from "./settings.ts";
export { type Actor, type ClaimRefusal, type Discussion, emptySyncRow, type Issue, type IssueSummary, type MirrorKind, type MirroredRow, type ModelUsage, type Role, SCHEMA_VERSION, type SearchHit, SHAPE_WRITER_KEY, Store, type StoredEvent, type SyncRow, type Task } from "./store/index.ts";
export { giveTasksTheirRepos, PLUGIN_IMPORT, tasksWithNoRepo } from "./task-repos.ts";
export { RECORD_READ_WAIT_MS, type RecordReadListener, SYNC_RUNNING_NOTE, type RolesListener, serveTools, type SharedFoldersListener } from "./tool-server.ts";
export { version, versionLine } from "./version.ts";
