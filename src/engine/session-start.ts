// What a new session is told: the planner role, then the open work from the record, so the
// session resumes from the record rather than from any earlier conversation, then the project's
// layout from the code graph as it was last indexed.
import { existsSync } from "node:fs";
import plannerRole from "../../roles/planner.md" with { type: "text" };
import reviewerRole from "../../roles/reviewer.md" with { type: "text" };
import { firstRunSection } from "./feedback/first-run.ts";
import type { FeedbackEnv } from "./feedback/index.ts";
import { retryKeptCheckouts } from "./handlers/fold.ts";
import { featureBriefOf, reviewLine } from "./handlers/reviews.ts";
import { detectedSettings, emptySettings } from "./handlers/settings.ts";
import { ensureHostReviewerRun, isReviewerHost } from "./host-runs.ts";
import { BASE_LAYER, graphDbPath, layerRow, openGraphDb } from "./graph/db.ts";
import { UNTRUSTED_NOTE } from "./graph/summary.ts";
import { openProjectStore } from "./project.ts";
import { refreshPullRequestStates } from "./pull-request-state.ts";
import { repoDirOf, workspaceRepos } from "./repos.ts";
import { readSettings, RECOMMENDED_REVIEW_MODE, REVIEW_MODE_COSTS, type RepoPolicies, type ReviewMode } from "./settings.ts";
import { type Actor, type Store, type Task, clip } from "./store/index.ts";

export const OPEN_WORK_HEADING = "## Open work in the record";
export const AWAITING_REVIEW_HEADING = "## Feature branches waiting for your review";
export const OPEN_WORK_MAX = 20;
export const PULL_REQUESTS_ENDED_HEADING = "## Pull requests and local merges that ended since the last session";
export const EMPTY_SETTINGS_HEADING = "## The project's settings are empty";
export const HOST_FILES_HEADING = "## tmb's files in this project";
export const DOCTOR_HEADING = "## What tmb doctor finds";
export const PROJECT_MAP_HEADING = "## The project, from the code graph";
export const PROJECT_MAP_MAX_DIRS = 40;
const PROJECT_MAP_DEPTH = 2;
const MAP_SUMMARY_MAX = 120;

function openWork(store: Store): string {
  return `${OPEN_WORK_HEADING}\n\n${openIssues(store)}${openTasks(store)}${inReviewTasks(store)}`;
}

function openIssues(store: Store): string {
  // Ids sort in time order, so the newest issues come last in the store's list.
  const open = store.listIssues({ state: "open" }).reverse();
  if (open.length === 0) return "No open issues.";
  const lines = open.slice(0, OPEN_WORK_MAX).map((issue) => {
    const decision = store.newestDecision(issue.id);
    return `- ${issue.id} ${issue.title}${decision ? ` (decision: ${clip(decision.body)})` : ""}`;
  });
  if (open.length > OPEN_WORK_MAX) lines.push(`- …and ${open.length - OPEN_WORK_MAX} older open issues; issue_list shows them all.`);
  return `Newest first:\n\n${lines.join("\n")}`;
}

/** The open tasks, oldest first, so a session resumes a task a worker left open; empty when none is. */
function openTasks(store: Store): string {
  const open = store.listTasks("open");
  if (open.length === 0) return "";
  const lines = open.slice(0, OPEN_WORK_MAX).map((task) => {
    const feature = task.featureId === null ? null : store.getFeature(task.featureId)?.name;
    return `- ${task.id} ${task.title} (issue ${task.issueId}${feature ? `, feature branch ${feature}` : ""}, worktree ${task.worktree ?? "none"})`;
  });
  if (open.length > OPEN_WORK_MAX) lines.push(`- …and ${open.length - OPEN_WORK_MAX} newer open tasks; task_list shows them all.`);
  return `\n\nOpen tasks, oldest first:\n\n${lines.join("\n")}`;
}

/** Truest tasks waiting on their review or their pull request, oldest first; empty when none is. */
function inReviewTasks(store: Store): string {
  const waiting = store.listTasks("in_review");
  if (waiting.length === 0) return "";
  const lines = waiting.slice(0, OPEN_WORK_MAX).map((task) => `- ${task.id} ${task.title} (issue ${task.issueId}, at ${task.commitSha?.slice(0, 12) ?? "no commit"})`);
  if (waiting.length > OPEN_WORK_MAX) lines.push(`- …and ${waiting.length - OPEN_WORK_MAX} newer tasks in review; task_list shows them all.`);
  return `\n\nTasks in review, oldest first (task_brief shows whether a review covers each; task_pr opens a covered one's pull request):\n\n${lines.join("\n")}`;
}

/** Text from the project's files on one line, so a path or summary cannot forge a heading of this context. */
const oneLineText = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, " ").trim();
const shorten = (text: string): string => (text.length <= MAP_SUMMARY_MAX ? text : `${text.slice(0, MAP_SUMMARY_MAX - 1)}…`);

/**
 * The base branch's directories as the graph last indexed them, without bringing it forward:
 * session start must stay fast, and graph_map answers from the newest commit. Empty when the
 * project has no graph yet or it cannot be read.
 */
function projectMapSection(projectDir: string, store: Store): string {
  const repos = workspaceRepos(store);
  if (repos !== null) return workspaceSection(projectDir, repos);
  if (!existsSync(graphDbPath(projectDir))) return "";
  try {
    const db = openGraphDb(projectDir);
    try {
      const layer = layerRow(db, BASE_LAYER);
      if (layer === null) return "";
      const dirs = db
        .query("SELECT path, summary, file_count FROM dirs WHERE layer = ? AND depth <= ? ORDER BY depth, path LIMIT ?")
        .all(BASE_LAYER, PROJECT_MAP_DEPTH, PROJECT_MAP_MAX_DIRS) as { path: string; summary: string; file_count: number }[];
      const total = (db.query("SELECT count(*) AS n FROM dirs WHERE layer = ?").get(BASE_LAYER) as { n: number }).n;
      const lines = dirs.map((dir) => {
        const summary = dir.summary ? `: ${shorten(oneLineText(dir.summary))}` : "";
        return `- ${dir.path === "." ? "./" : `${oneLineText(dir.path)}/`} (${dir.file_count} files)${summary}`;
      });
      if (total > dirs.length) lines.push(`- …and ${total - dirs.length} more directories; graph_map shows them.`);
      return (
        `\n\n${PROJECT_MAP_HEADING}\n\nAs indexed at ${layer.commit_sha.slice(0, 12)}: ${layer.files} files, ${layer.symbols} symbols. ` +
        `Scope from here with graph_map, graph_find, graph_symbol and graph_scope, which bring the graph to the newest commit first. ${UNTRUSTED_NOTE}\n\n${lines.join("\n")}`
      );
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

/** A repo's graph as last indexed, in a few words, without bringing it forward. */
function indexedLine(projectDir: string, repo: string): string {
  if (!existsSync(graphDbPath(projectDir, repo))) return "not indexed yet";
  try {
    const db = openGraphDb(projectDir, repo);
    try {
      const layer = layerRow(db, BASE_LAYER);
      return layer === null ? "not indexed yet" : `indexed at ${layer.commit_sha.slice(0, 12)}: ${layer.files} files, ${layer.symbols} symbols`;
    } finally {
      db.close();
    }
  } catch {
    return "its graph cannot be read";
  }
}

/** In a workspace: its repos, each with its base branch and graph, and that work names its repo. */
function workspaceSection(projectDir: string, repos: RepoPolicies): string {
  const names = Object.keys(repos);
  const lines = names.map((name) => {
    const policy = repos[name]!;
    if (policy.git === false) return `- ${oneLineText(name)}: not a repo, tmb does no work in it`;
    if (policy.exempt === true) return `- ${oneLineText(name)}: exempt, tmb does no work in it`;
    return `- ${oneLineText(name)} on \`${oneLineText(policy.base_branch ?? "")}\`: ${indexedLine(projectDir, name)}`;
  });
  return (
    `\n\n${PROJECT_MAP_HEADING}\n\nThis project is a workspace of ${names.length} repo${names.length === 1 ? "" : "s"} sharing one record. ` +
    "feature_start, task_start and the graph tools take repo, the repo's name below; with several repos they refuse a call that names none. " +
    `A task works in its feature branch's repo. ${UNTRUSTED_NOTE}\n\n${lines.length === 0 ? "- none found; `tmb init` finds them" : lines.join("\n")}`
  );
}

const SETTING_LABELS = { base_branch: "base branch", review_mode: "review mode", checks: "checks" } as const;

/**
 * When the project's settings are empty, as `tmb init` leaves them, the planner onboards the
 * project itself: it applies the base branch and checks it recommends and shows them. The review
 * mode is the Human's choice: init asks nothing, so the planner asks for it among its onboarding
 * questions, and with no one to ask leaves it unset, so task_start is refused. Empty when all are set.
 */
function emptySettingsSection(store: Store, projectDir: string, unattended: boolean): string {
  const empty = emptySettings(readSettings(store));
  if (empty.length === 0) return "";
  const detected = detectedSettings(projectDir);
  const checks = detected.checks.length === 0 ? "none found" : detected.checks.map((check) => `\`${oneLineText(check)}\``).join(", ");
  const branch = (name: string | null) => (name === null ? "none found" : `\`${oneLineText(name)}\``);
  const found = [
    ...(detected.repos === undefined
      ? [`base branch: ${detected.base_branch === null ? "none found, as this is not a git work tree" : branch(detected.base_branch)}`, `checks: ${checks}`]
      : Object.entries(detected.repos).map(([name, repo]) => `repo ${oneLineText(name)}: base branch ${branch(repo.base_branch)}`)),
    `review modes: ${detected.review_modes.map((mode) => `${mode} (${REVIEW_MODE_COSTS[mode as ReviewMode]})`).join(" or ")}`,
  ];
  const others = empty.filter((name) => name !== "review_mode");
  const parts: string[] = [];
  if (others.length > 0) {
    parts.push(
      `Before other work, work out the ${others.map((name) => SETTING_LABELS[name]).join(" and ")} you recommend for this project, reading what you need of it, and apply them with settings_set.`,
      unattended
        ? "Name each value you applied in your answer."
        : "Then show the Human what you applied, and remind them that `tmb onboard` can be run again at any time to change the settings, and that you can change a value when they ask.",
    );
  }
  if (empty.includes("review_mode")) {
    parts.push(
      unattended
        ? "The review mode is the Human's choice, as it decides how many tokens the project uses, and no one can answer in this run: do not set it. " +
            "task_start is refused until the Human runs `tmb onboard`; say so in your answer."
        : "The review mode is the Human's choice, as it decides how many tokens the project uses: do not set it yourself. " +
            `Ask the Human for it among your onboarding questions, with your host's question tool, such as AskUserQuestion: one option per mode with what it costs, ${RECOMMENDED_REVIEW_MODE} marked as recommended. ` +
            "Set their answer with settings_set. task_start is refused until it is set.",
    );
  }
  return `\n\n${EMPTY_SETTINGS_HEADING}\n\nNot set yet: ${empty.map((name) => SETTING_LABELS[name]).join(", ")}. ${parts.join(" ")}\n\nWhat tmb found in the project:\n\n${found.map((line) => `- ${line}`).join("\n")}`;
}

function withRole(section: string): string {
  return `${plannerRole.trimEnd()}\n\n${section}\n`;
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

export const UNATTENDED_INSTRUCTION =
  "## Unattended run\n\nNo one can answer in this run, so apply your defaults, name each default you used, and stop with the reason when a default is not safe.";

/**
 * Open feature branches with work on them and no review or waiver at their tip, oldest first.
 * A branch whose newest review at the tip failed waits for rework, not for a review.
 */
function awaitingReview(store: Store, projectDir: string): string {
  const lines: string[] = [];
  for (const feature of store.listFeatures("open")) {
    const brief = featureBriefOf(store, projectDir, feature);
    if (brief.groups.length === 0 || brief.covered || brief.reviews.some((review) => review.commit === brief.tip)) continue;
    lines.push(`- ${reviewLine(feature.name)} at ${brief.tip.slice(0, 12)}: ${brief.groups.length} task${brief.groups.length === 1 ? "" : "s"} onto ${brief.baseBranch}`);
  }
  const list = lines.length === 0 ? "No feature branch waits for a review now." : lines.join("\n");
  return `${AWAITING_REVIEW_HEADING}\n\nThis host is set up as the project's reviewer: another agent plans and writes, and you judge its work through the record. Take each branch below as your prompt's \`feature=<name>\` line. Report your verdict to the Human, who passes it on to the planner.\n\n${list}`;
}

/** The reviewer host's context; opens its run, so the verdict it records has one. Never throws. */
function reviewerContext(projectDir: string, host: string): string {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) return `${reviewerRole.trimEnd()}\n\ntmb could not read the record: ${oneLine(opened.error)}\n`;
  try {
    const context = `${reviewerRole.trimEnd()}\n\n${awaitingReview(opened.store, projectDir)}\n`;
    // A host may raise a session start again on resume, clear or compact: one run per session.
    ensureHostReviewerRun(opened.store, host);
    return context;
  } catch (error) {
    return `${reviewerRole.trimEnd()}\n\ntmb could not read the record: ${oneLine(error)}\n`;
  } finally {
    opened.store.close();
  }
}

/** Whether the record sets the host up as the reviewer; false when there is no host or no readable record. */
function reviewsHere(projectDir: string, host: string | undefined): boolean {
  if (host === undefined) return false;
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) return false;
  try {
    return isReviewerHost(opened.store, host);
  } catch {
    return false;
  } finally {
    opened.store.close();
  }
}

/**
 * The role and its work: for the planner the open work, for a host set up as the reviewer the
 * branches waiting for review. Then, when `unattended` says no one can answer in this run, the
 * instruction for it. Nothing about the mode is stored in the project.
 */
export function sessionStartContext(projectDir: string, unattended: boolean, host?: string, feedback?: FeedbackEnv, refreshed: string | null = null, doctor?: (projectDir: string) => string | null): string {
  if (reviewsHere(projectDir, host)) {
    const context = withHostFiles(reviewerContext(projectDir, host!), refreshed, unattended);
    return unattended ? `${context.trimEnd()}\n\n${UNATTENDED_INSTRUCTION}\n` : context;
  }
  const context = withDoctor(withHostFiles(plannerContext(projectDir, unattended, host), refreshed, unattended), projectDir, doctor, unattended);
  if (unattended) return `${context.trimEnd()}\n\n${UNATTENDED_INSTRUCTION}\n`;
  // Only the planner's attended session tells the Human about the feedback program, once per program on this machine.
  const told = feedback === undefined ? "" : feedbackSection(feedback);
  return told === "" ? context : `${context.trimEnd()}\n\n${told}\n`;
}

/**
 * The one line on refreshing the project's host files after an update (trustmybot/tmb#128),
 * which the role tells the Human, or names in its answer when no one can answer.
 */
function withHostFiles(context: string, refreshed: string | null, unattended: boolean): string {
  if (refreshed === null) return context;
  const tell = unattended ? "Name it in your answer." : "Tell the Human in one line.";
  return `${context.trimEnd()}\n\n${HOST_FILES_HEADING}\n\n${oneLine(refreshed)} ${tell}\n`;
}

/**
 * The planner's one line on what \`tmb doctor\` finds (trustmybot/tmb#160), run after the session
 * start's own clean-up so it counts only what is left. Never throws.
 */
function withDoctor(context: string, projectDir: string, doctor: ((projectDir: string) => string | null) | undefined, unattended: boolean): string {
  let line: string | null = null;
  try {
    line = doctor?.(projectDir) ?? null;
  } catch {
    line = null;
  }
  if (line === null) return context;
  const tell = unattended ? "Name it in your answer." : "Tell the Human in one line.";
  return `${context.trimEnd()}\n\n${DOCTOR_HEADING}\n\n${oneLine(line)} ${tell}\n`;
}

/** The feedback program's first-run section; never throws, as a session start must not fail. */
function feedbackSection(feedback: FeedbackEnv): string {
  try {
    return firstRunSection(feedback);
  } catch {
    return "";
  }
}

/**
 * With no task open, tries again to remove the worktrees and branches closed and dropped tasks
 * kept (trustmybot/tmb#132, trustmybot/tmb#170), so one goes once its files are gone or ignored. Never throws.
 */
function tidyClosedTasks(store: Store, projectDir: string): void {
  try {
    if (store.listTasks("open").length > 0 || store.listTasks("in_review").length > 0) return;
    // Each repo's git holds its own tasks' worktrees and branches.
    const byRepo = new Map<string | null, Task[]>();
    for (const task of [...store.listTasks("closed"), ...store.listTasks("dropped")]) byRepo.set(task.repo, [...(byRepo.get(task.repo) ?? []), task]);
    for (const [repo, tasks] of byRepo) retryKeptCheckouts(repoDirOf(projectDir, repo), tasks);
  } catch {
    // A session start never fails over a cleanup; the next one tries again.
  }
}

/**
 * Reads the pull request of each feature branch in pr_open and moves it to merged or closed once
 * GitHub says so (trustmybot/tmb#131); a section naming those it moved, empty when none. Never throws.
 */
function endedPullRequests(store: Store, projectDir: string, host?: string): string {
  const actor: Actor = host === undefined ? { kind: "human" } : { kind: "agent", role: "planner", host };
  const moved = refreshPullRequestStates(store, actor, projectDir);
  return moved.length === 0 ? "" : `\n\n${PULL_REQUESTS_ENDED_HEADING}\n\n${moved.map((line) => `- ${line}`).join("\n")}`;
}

/** Never throws: a missing record gives the role alone, a bad one the role and a line naming the problem. */
function plannerContext(projectDir: string, unattended: boolean, host?: string): string {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    return opened.error.failure === "missing" ? plannerRole : withRole(`tmb could not read the record: ${oneLine(opened.error)}`);
  }
  try {
    tidyClosedTasks(opened.store, projectDir);
    const ended = endedPullRequests(opened.store, projectDir, host);
    return withRole(`${openWork(opened.store)}${ended}${emptySettingsSection(opened.store, projectDir, unattended)}${projectMapSection(projectDir, opened.store)}`);
  } catch (error) {
    return withRole(`tmb could not read the record: ${oneLine(error)}`);
  } finally {
    opened.store.close();
  }
}

export { plannerRole, reviewerRole };
