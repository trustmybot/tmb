// What a new session is told: the planner role, then the open work from the record, so the
// session resumes from the record rather than from any earlier conversation, then the project's
// layout from the code graph as it was last indexed.
import { existsSync } from "node:fs";
import plannerRole from "../../roles/planner.md" with { type: "text" };
import reviewerRole from "../../roles/reviewer.md" with { type: "text" };
import { namingProgram, runningName } from "./program.ts";
import { firstRunSection } from "./feedback/first-run.ts";
import type { FeedbackEnv } from "./feedback/index.ts";
import { retryKeptCheckouts } from "./handlers/fold.ts";
import { featureBriefOf, reviewLine } from "./handlers/reviews.ts";
import { detectedSettings, emptySettings } from "./handlers/settings.ts";
import { ensureHostReviewerRun, isReviewerHost } from "./host-runs.ts";
import { BASE_LAYER, graphDbPath, layerRow, openGraphDb } from "./graph/db.ts";
import { UNTRUSTED_NOTE } from "./graph/summary.ts";
import { takeOutsideChanges } from "./outside-changes.ts";
import { openProjectStore } from "./project.ts";
import { refreshPullRequestStates } from "./pull-request-state.ts";
import { repoDirOf, workspaceRepos } from "./repos.ts";
import { readSettings, RECOMMENDED_REVIEW_MODE, REVIEW_MODE_COSTS, type RepoPolicies, type RepoPolicy, type ReviewMode } from "./settings.ts";
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

function openWork(store: Store, max: number): string {
  return `${OPEN_WORK_HEADING}\n\n${openIssues(store, max)}${openTasks(store, max)}${inReviewTasks(store, max)}`;
}

function openIssues(store: Store, max: number): string {
  // Ids sort in time order, so the newest issues come last in the store's list.
  const open = store.listIssues({ state: "open" }).reverse();
  if (open.length === 0) return "No open issues.";
  const lines = open.slice(0, max).map((issue) => {
    const decision = store.newestDecision(issue.id);
    return `- ${issue.id} ${issue.title}${decision ? ` (decision: ${clip(decision.body)})` : ""}`;
  });
  if (open.length > max) lines.push(`- …and ${open.length - max} older open issues; issue_list shows them all.`);
  return `Newest first:\n\n${lines.join("\n")}`;
}

/** The open tasks, oldest first, so a session resumes a task a worker left open; empty when none is. */
function openTasks(store: Store, max: number): string {
  const open = store.listTasks("open");
  if (open.length === 0) return "";
  const lines = open.slice(0, max).map((task) => {
    const feature = task.featureId === null ? null : store.getFeature(task.featureId)?.name;
    return `- ${task.id} ${task.title} (issue ${task.issueId}${feature ? `, feature branch ${feature}` : ""}, worktree ${task.worktree ?? "none"})`;
  });
  if (open.length > max) lines.push(`- …and ${open.length - max} newer open tasks; task_list shows them all.`);
  return `\n\nOpen tasks, oldest first:\n\n${lines.join("\n")}`;
}

/** Truest tasks waiting on their review or their pull request, oldest first; empty when none is. */
function inReviewTasks(store: Store, max: number): string {
  const waiting = store.listTasks("in_review");
  if (waiting.length === 0) return "";
  const lines = waiting.slice(0, max).map((task) => `- ${task.id} ${task.title} (issue ${task.issueId}, at ${task.commitSha?.slice(0, 12) ?? "no commit"})`);
  if (waiting.length > max) lines.push(`- …and ${waiting.length - max} newer tasks in review; task_list shows them all.`);
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
function projectMapSection(projectDir: string, store: Store, maxDirs: number): string {
  const repos = workspaceRepos(store);
  if (repos !== null) return workspaceSection(projectDir, repos, readSettings(store).review_mode);
  if (!existsSync(graphDbPath(projectDir))) return "";
  try {
    const db = openGraphDb(projectDir);
    try {
      const layer = layerRow(db, BASE_LAYER);
      if (layer === null) return "";
      const dirs = db
        .query("SELECT path, summary, file_count FROM dirs WHERE layer = ? AND depth <= ? ORDER BY depth, path LIMIT ?")
        .all(BASE_LAYER, PROJECT_MAP_DEPTH, maxDirs) as { path: string; summary: string; file_count: number }[];
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

/** A repo's review mode in a few words: its own, else the workspace's (trustmybot/tmb#216). */
function repoModeText(policy: RepoPolicy, workspaceMode: ReviewMode | null): string {
  if (policy.review_mode !== undefined) return `${policy.review_mode} mode (its own)`;
  return workspaceMode === null ? "no review mode chosen" : `${workspaceMode} mode (the workspace's)`;
}

/** In a workspace: its repos, each with its base branch, review mode and graph, and that work names its repo. */
function workspaceSection(projectDir: string, repos: RepoPolicies, workspaceMode: ReviewMode | null): string {
  const names = Object.keys(repos);
  const lines = names.map((name) => {
    const policy = repos[name]!;
    if (policy.git === false) return `- ${oneLineText(name)}: not a repo, tmb does no work in it`;
    if (policy.exempt === true) return `- ${oneLineText(name)}: exempt, tmb does no work in it`;
    return `- ${oneLineText(name)} on \`${oneLineText(policy.base_branch ?? "")}\`, ${repoModeText(policy, workspaceMode)}: ${indexedLine(projectDir, name)}`;
  });
  return (
    `\n\n${PROJECT_MAP_HEADING}\n\nThis project is a workspace of ${names.length} repo${names.length === 1 ? "" : "s"} sharing one record. ` +
    "feature_start, task_start and the graph tools take repo, the repo's name below; with several repos they refuse a call that names none. " +
    "Each repo follows its own review mode, below: a truest repo has no feature branches. " +
    `A task works in its feature branch's repo. ${UNTRUSTED_NOTE}\n\n${lines.length === 0 ? `- none found; \`${runningName()} init\` finds them` : lines.join("\n")}`
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
        : `Then show the Human what you applied, and remind them that \`${runningName()} onboard\` can be run again at any time to change the settings, and that you can change a value when they ask.`,
    );
  }
  if (empty.includes("review_mode")) {
    parts.push(
      unattended
        ? "The review mode is the Human's choice, as it decides how many tokens the project uses, and no one can answer in this run: do not set it. " +
            `task_start is refused until the Human runs \`${runningName()} onboard\`; say so in your answer.`
        : "The review mode is the Human's choice, as it decides how many tokens the project uses: do not set it yourself. " +
            `Ask the Human for it among your onboarding questions, with your host's question tool, such as AskUserQuestion: one option per mode with what it costs, ${RECOMMENDED_REVIEW_MODE} marked as recommended. ` +
            "Set their answer with settings_set. task_start is refused until it is set.",
    );
  }
  return `\n\n${EMPTY_SETTINGS_HEADING}\n\nNot set yet: ${empty.map((name) => SETTING_LABELS[name]).join(", ")}. ${parts.join(" ")}\n\nWhat tmb found in the project:\n\n${found.map((line) => `- ${line}`).join("\n")}`;
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

// A question with a recommended answer counts as answered by it: otherwise the role's rule to ask
// open questions wins and the run stops with nothing started (trustmybot/tmb#281). It comes first
// in the answer: a host may show only the head of a long context and keep the rest in a file the
// agent reads only if it chooses to, so an instruction at the end was seen only some of the time.
export const UNATTENDED_INSTRUCTION =
  "## Unattended run\n\nNo one can answer in this run, so apply your defaults and name each default you used. " +
  "A question you have a recommended answer for counts as answered by that recommendation: record it as a decision on its issue, name it in your answer, and go on with the work. " +
  "A choice your role leaves to the Human alone is never a default. " +
  "Stop only when no default is safe, and say why. " +
  "Your role and the project's open work follow: read all of it before you act.";

/**
 * Open feature branches, and those whose pull request is open, with work on them and no review or
 * waiver at their tip, oldest first within each.
 * A branch whose newest review at the tip failed waits for rework, not for a review.
 */
function awaitingReview(store: Store, projectDir: string): string {
  const lines: string[] = [];
  // A branch whose pull request is open takes fix tasks, and its new tip waits for a review too (trustmybot/tmb#168).
  for (const feature of [...store.listFeatures("open"), ...store.listFeatures("pr_open"), ...store.listFeatures("ready")]) {
    const brief = featureBriefOf(store, projectDir, feature);
    if (brief.groups.length === 0 || brief.covered || brief.reviews.some((review) => review.commit === brief.tip)) continue;
    lines.push(`- ${reviewLine(feature.name)} at ${brief.tip.slice(0, 12)}: ${brief.groups.length} task${brief.groups.length === 1 ? "" : "s"} onto ${brief.baseBranch}`);
  }
  const list = lines.length === 0 ? "No feature branch waits for a review now." : lines.join("\n");
  return `${AWAITING_REVIEW_HEADING}\n\nThis host is set up as the project's reviewer: another agent plans and writes, and you judge its work through the record. Take each branch below as your prompt's \`feature=<name>\` line. Report your verdict to the Human, who passes it on to the planner.\n\n${list}`;
}

/** The reviewer host's state: the branches waiting for review. Opens its run, so the verdict it records has one. Never throws. */
function reviewerState(projectDir: string, host: string): string {
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) return `tmb could not read the record: ${oneLine(opened.error)}`;
  try {
    const state = awaitingReview(opened.store, projectDir);
    // A host may raise a session start again on resume, clear or compact: one run per session.
    ensureHostReviewerRun(opened.store, host);
    return state;
  } catch (error) {
    return `tmb could not read the record: ${oneLine(error)}`;
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
 * What the planner is told before its next turn: the issues changed outside its chat since it was
 * last told, or nothing. Empty on a host set up as the reviewer, and when there is no readable
 * record. Never throws.
 */
export function plannerTurnContext(projectDir: string, host?: string): string {
  if (reviewsHere(projectDir, host)) return "";
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) return "";
  try {
    return takeOutsideChanges(opened.store);
  } catch {
    return "";
  } finally {
    opened.store.close();
  }
}

/**
 * How the host takes the session start. `withRole` puts the role in the same text as the state;
 * without it the host takes the role apart, from `sessionRole`. `budget` is the most characters
 * the state's text may have, below the host's cap on one text: tmb shortens its own lists to fit,
 * so the host never cuts it. The adapter names both; with no budget nothing is cut.
 */
export type SessionStartTexts = { withRole: boolean; budget?: number };

/** The role a session in the project takes: the reviewer's on a host set up as the reviewer, else the planner's. Reads only; never throws. */
export function sessionRole(projectDir: string, host?: string): string {
  return namingProgram(reviewsHere(projectDir, host) ? reviewerRole : plannerRole);
}

/**
 * The state of the project, and the role too when `texts.withRole` says so: for the planner the
 * open work, settings, map and findings; for a host set up as the reviewer the branches waiting
 * for review. When `unattended` says no one can answer in this run, the instruction for it comes
 * first, so it is in the head a host shows of a long answer (trustmybot/tmb#281). Nothing about the
 * mode is stored in the project.
 */
export function sessionStartContext(
  projectDir: string,
  unattended: boolean,
  host?: string,
  feedback?: FeedbackEnv,
  refreshed: string | null = null,
  doctor?: (projectDir: string) => string | null,
  texts: SessionStartTexts = { withRole: true },
): string {
  return new SessionStart({ projectDir, unattended, host, feedback, refreshed, doctor }).context(texts);
}

/** The parts that have text, a blank line between each, ending in one newline; empty when none has. */
function joined(parts: readonly string[]): string {
  const kept = parts.map((part) => part.trim()).filter((part) => part !== "");
  return kept.length === 0 ? "" : `${kept.join("\n\n")}\n`;
}

/** How many items each list shows: the open work's lists, and the map's directories. */
type ListSizes = { work: number; dirs: number };

/** The sizes tried, longest first, each half the one before, down to none. */
function listSizes(): ListSizes[] {
  const sizes: ListSizes[] = [{ work: OPEN_WORK_MAX, dirs: PROJECT_MAP_MAX_DIRS }];
  for (let last = sizes[0]!; last.work > 0 || last.dirs > 0; ) {
    last = { work: Math.floor(last.work / 2), dirs: Math.floor(last.dirs / 2) };
    sizes.push(last);
  }
  return sizes;
}

/**
 * The first text, longest first, within the budget. When even the shortest is over, tmb cuts it
 * at the budget and says so, so the host never cuts it and the agent knows which tools list the rest.
 */
function fitted(texts: readonly string[], budget: number | undefined): string {
  const fit = budget === undefined ? texts[0] : texts.find((text) => text.length <= budget);
  if (fit !== undefined || budget === undefined) return fit ?? "";
  const note = `\n\n…cut to fit tmb's budget of ${budget} characters for this text; issue_list, task_list, settings_get and graph_map show the rest.\n`;
  return `${texts[0]!.slice(0, Math.max(0, budget - note.length)).trimEnd()}${note}`;
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

/** What a session start is told: the project, whether anyone can answer, the host, and what the adapter found before it. */
type SessionStartOptions = {
  readonly projectDir: string;
  readonly unattended: boolean;
  readonly host: string | undefined;
  readonly feedback: FeedbackEnv | undefined;
  /** The line on the host files an update refreshed; null when none were. */
  readonly refreshed: string | null;
  readonly doctor: ((projectDir: string) => string | null) | undefined;
};

/** One session start: the texts its host is given, built from the options it was started with. */
class SessionStart {
  constructor(private readonly options: SessionStartOptions) {}

  context(texts: SessionStartTexts): string {
    const { projectDir, unattended, host } = this.options;
    const reviewer = reviewsHere(projectDir, host);
    const head = unattended ? UNATTENDED_INSTRUCTION : "";
    const budget = texts.budget === undefined ? undefined : texts.budget - (head === "" ? 0 : head.length + 2);
    const state = reviewer ? fitted([joined([reviewerState(projectDir, host!), this.hostFilesSection()])], budget) : this.plannerState(budget);
    const role = texts.withRole ? namingProgram(reviewer ? reviewerRole : plannerRole) : "";
    return joined([head, role, state]);
  }

  /**
   * The planner's state, fitted to the budget: the open work, the pull requests that ended, empty
   * settings and the map, at each list size, then the findings. Each step with an effect runs once.
   * Never throws: a missing record gives no state, a bad one a line naming the problem.
   */
  private plannerState(budget: number | undefined): string {
    const { unattended, feedback } = this.options;
    const record = this.recordStates(budget === undefined ? [listSizes()[0]!] : listSizes());
    const findings = [this.hostFilesSection(), this.doctorSection()];
    // Only the planner's attended session tells the Human about the feedback program, once per program on this machine.
    const told = unattended || feedback === undefined ? "" : feedbackSection(feedback);
    return fitted(
      record.map((state) => joined([state, ...findings, told])),
      budget,
    );
  }

  /** The record's part of the planner's state at each list size; one line naming the problem when it cannot be read, none when there is no record. */
  private recordStates(sizes: readonly ListSizes[]): string[] {
    const { projectDir, unattended, host } = this.options;
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) return [opened.error.failure === "missing" ? "" : `tmb could not read the record: ${oneLine(opened.error)}`];
    try {
      tidyClosedTasks(opened.store, projectDir);
      const ended = endedPullRequests(opened.store, projectDir, host);
      const settings = emptySettingsSection(opened.store, projectDir, unattended);
      // Last, as it changes most often: what changed outside the chat since the planner was last told.
      const outside = takeOutsideChanges(opened.store);
      const told = outside === "" ? "" : `\n\n${outside}`;
      return sizes.map((size) => `${openWork(opened.store, size.work)}${ended}${settings}${projectMapSection(projectDir, opened.store, size.dirs)}${told}`);
    } catch (error) {
      return [`tmb could not read the record: ${oneLine(error)}`];
    } finally {
      opened.store.close();
    }
  }

  /**
   * The one line on refreshing the project's host files after an update (trustmybot/tmb#128),
   * which the role tells the Human, or names in its answer when no one can answer.
   */
  private hostFilesSection(): string {
    const { refreshed, unattended } = this.options;
    if (refreshed === null) return "";
    return `${HOST_FILES_HEADING}\n\n${oneLine(refreshed)} ${tellLine(unattended)}`;
  }

  /**
   * The planner's one line on what \`tmb doctor\` finds (trustmybot/tmb#160), run after the session
   * start's own clean-up so it counts only what is left. Never throws.
   */
  private doctorSection(): string {
    const { projectDir, doctor, unattended } = this.options;
    let line: string | null = null;
    try {
      line = doctor?.(projectDir) ?? null;
    } catch {
      line = null;
    }
    if (line === null) return "";
    return `${DOCTOR_HEADING}\n\n${oneLine(line)} ${tellLine(unattended)}`;
  }
}

/** How a finding reaches the Human: told in one line, or named in the answer when no one can answer. */
function tellLine(unattended: boolean): string {
  return unattended ? "Name it in your answer." : "Tell the Human in one line.";
}

export { plannerRole, reviewerRole };
