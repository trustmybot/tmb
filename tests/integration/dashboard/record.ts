// A prepared record for the dashboard tests: one of each thing the pages show, written
// through the store the way the engine writes it.
import { openProjectStore } from "../../../src/engine/project.ts";
import type { Actor } from "../../../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };
const PLANNER: Actor = { kind: "agent", role: "planner", host: "claude-code" };
const WORKER: Actor = { kind: "agent", role: "worker", host: "claude-code" };

export const SEED = {
  issueTitle: "Add a dark mode toggle",
  issueBody: "The settings page needs a **dark mode** switch.",
  milestone: "v1",
  closedIssueTitle: "Fix the login typo",
  note: "Check the contrast in both themes.",
  oldDecision: "Store the mode in a cookie.",
  decision: "Store the mode in localStorage, not a cookie.",
  featureName: "dark-mode",
  taskTitle: "Wire the toggle into the header",
  taskSpec: "Add a `ThemeToggle` button to the header.",
  branch: "tmb/task-dark-toggle",
  commit: "0123456789abcdef0123456789abcdef01234567",
  checkCommand: "bun test",
  failedCommand: "bun run lint",
  checkOutput: "12 pass, 0 fail",
  failedOutput: "header.tsx: unused import",
  guardReason: "rm -rf outside the worktree",
  auditWhat: "setting:host",
  auditDetail: '"claude-code"',
} as const;

export type SeededIds = { issueId: string; closedIssueId: string; taskId: string; featureId: string; decisionId: string; oldDecisionId: string };

/** Writes the prepared record into `projectDir/.tmb/trajectory.db` and returns the ids made. */
export function seedRecord(projectDir: string): SeededIds {
  const opened = openProjectStore(projectDir, { create: true });
  if (!opened.ok) throw opened.error;
  const store = opened.store;
  try {
    const issueId = store.createIssue(PLANNER, { title: SEED.issueTitle, body: SEED.issueBody, milestone: SEED.milestone });
    const closedIssueId = store.createIssue(HUMAN, { title: SEED.closedIssueTitle, body: "Typo on the login page." });
    store.updateIssue(HUMAN, closedIssueId, { state: "closed" });
    store.appendDiscussion(HUMAN, { issueId, kind: "note", body: SEED.note });
    const oldDecisionId = store.appendDiscussion(PLANNER, { issueId, kind: "decision", body: SEED.oldDecision });
    const decisionId = store.appendDiscussion(HUMAN, { issueId, kind: "decision", body: SEED.decision });
    const featureId = store.createFeature(PLANNER, { name: SEED.featureName, baseBranch: "main", baseCommit: SEED.commit });
    const taskId = store.appendTask(PLANNER, {
      issueId,
      title: SEED.taskTitle,
      spec: SEED.taskSpec,
      state: "open",
      branch: SEED.branch,
      worktree: "/tmp/worktrees/dark-toggle",
      baseCommit: SEED.commit,
      featureId,
      kind: "code",
    });
    const runId = store.appendRun(WORKER, { taskId, role: "worker", startedAt: "2026-01-01T10:00:00.000Z" });
    store.endRun(WORKER, runId, { endedAt: "2026-01-01T10:05:00.000Z", outcome: "stopped" });
    store.appendRun(PLANNER, { role: "planner", startedAt: "2026-01-01T09:00:00.000Z" });
    const checkId = store.appendCheckRun(WORKER, { taskId, commitSha: SEED.commit, startedAt: "2026-01-01T10:04:00.000Z" });
    store.endCheckRun(WORKER, checkId, {
      endedAt: "2026-01-01T10:04:30.000Z",
      result: "failed",
      commands: [
        { command: SEED.checkCommand, status: "passed", exitCode: 0, startedAt: "2026-01-01T10:04:00.000Z", endedAt: "2026-01-01T10:04:20.000Z", outputTail: SEED.checkOutput },
        { command: SEED.failedCommand, status: "failed", exitCode: 1, startedAt: "2026-01-01T10:04:20.000Z", endedAt: "2026-01-01T10:04:30.000Z", outputTail: SEED.failedOutput },
      ],
    });
    store.appendGuardDecision(WORKER, { event: "PreToolUse", decision: "deny", reason: SEED.guardReason });
    store.recordSettingChange(HUMAN, { key: "host", oldValue: null, newValue: SEED.auditDetail });
    return { issueId, closedIssueId, taskId, featureId, decisionId, oldDecisionId };
  } finally {
    store.close();
  }
}
