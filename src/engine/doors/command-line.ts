// The record commands of the command line: the Human's way into the record. Each command
// calls the same operation an agent's tool call does, acting as the Human.
import { repoOfRow, workingRepos, workspaceRepos } from "../repos.ts";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  type FeatureBrief,
  type FeaturePrResult,
  type FeatureSummary,
  type FeatureUpdateResult,
  type GraphAnswer,
  HandlerError,
  type IssueDetail,
  markLine,
  markRequiredLine,
  type IssueUpdateResult,
  OPERATIONS,
  type OperationName,
  type TaskBrief,
  type TaskCloseResult,
  type TaskPrResult,
  type TaskStartResult,
  type TaskSummary,
  type TaskDropResult,
  type TaskWaiveResult,
  type WaiveResult,
} from "../handlers/index.ts";
import type { Concept } from "../graph/concepts.ts";
import { indexProject } from "../graph/fresh.ts";
import { Paint, unknownCommandText, usageErrorText } from "./help.ts";
import type { Hit, MapResult, ScopeResult, SymbolCard } from "../graph/lookups.ts";
import { openProjectStore } from "../project.ts";
import { readSettings, settingLines } from "../settings.ts";
import type { Actor, Discussion, Issue, IssueSummary, SearchHit, StoredEvent } from "../store/index.ts";

export const RECORD_COMMANDS = ["issue", "note", "search", "history", "feature", "task", "graph"] as const;
export type RecordCommand = (typeof RECORD_COMMANDS)[number];

const JSON_NOTE = "  Add --json for JSON output.";

/** Each record command's detail, as `tmb help <command>` shows it. */
export const RECORD_USAGE: Record<RecordCommand, string> = {
  issue: `  tmb issue create <title> [--body <text>] [--milestone <name>]
                            Record a new issue
  tmb issue list [--state open|closed]
                            List issues
  tmb issue show <id>       Show an issue with its notes and decisions
  tmb issue close <id>      Close an issue
  tmb issue reopen <id>     Reopen an issue
${JSON_NOTE}`,
  note: `  tmb note <issue-id> <text> [--decision]
                            Add a note, or with --decision a decision, to an issue
${JSON_NOTE}`,
  search: `  tmb search <query>        Search issues, notes and decisions
${JSON_NOTE}`,
  history: `  tmb history <id>          Show every recorded change to an issue or note
${JSON_NOTE}`,
  feature: `  tmb feature start <name> [--repo <name>]
                            Cut a feature branch from the base branch and record it; in a
                            workspace of several repos, --repo names the repo it is cut in
  tmb feature update <name> Bring the base branch into the feature branch with a merge commit,
                            fetched from origin first; a conflict changes nothing and names the files
  tmb feature list          List the feature branches with their base, state and tasks
  tmb feature brief <name>  Show a feature branch's tip, its task groups, reviews and waivers
  tmb feature waive <name> --reason <text>
                            Waive the review of the feature branch at its tip (the Human only)
  tmb feature pr <name> --title <text> [--body <text>]
                            Open the feature branch's pull request into the base branch, once
                            the reviewer passed its tip or the Human waived the review
${JSON_NOTE}`,
  task: `  tmb task start <issue-id> --kind code|docs [--feature <name>] [--repo <name>] --intent <text>
                 --file <path>... --criterion <text>... [--check <command>]... [--replaces <id>]
                            Start a task: cut its branch and worktree from the feature
                            branch and record its spec; --replaces names the dropped task
                            it takes over from
  tmb task list [--state open|in_review|closed|dropped|all]
                            List the open tasks, or those in review, the closed ones, the
                            dropped ones or all
  tmb task brief <id>       Show a task's spec, worktree, branch and checks
  tmb task close <id>       Run the checks on the task's commit; when all pass, close it,
                            fold it into its feature branch and push that to origin
                            (in truest mode: put it in review at that commit)
  tmb task drop <id> --reason <text>
                            Drop a task whose approach is wrong or that nobody will finish;
                            its worktree goes unless it holds uncommitted work
  tmb task waive <id> --reason <text>
                            Waive the review of a truest task at its commit (the Human only)
  tmb task pr <id> --title <text> [--body <text>]
                            Open a truest task's pull request into the base branch, once
                            the reviewer passed it or the Human waived the review
${JSON_NOTE}`,
  graph: `  tmb graph map [<dir>] [--depth <n>]
                            Show the project's directories and files with their summaries
  tmb graph find <words>    Find where a symbol, file or topic lives in the code
  tmb graph symbol <name> [--path <file>]
                            Show a symbol's (or a file's) callers, importers, callees and tests
  tmb graph scope <objective> [--anchor <symbol-or-path>]...
                            Draft a task's files and tests from the code graph
  tmb graph concepts [<words>]
                            List the concepts recorded in the code graph
  Add --task <id> to a lookup to read as that task sees the code, or --feature <name> to read a
  feature branch at its tip. scope reads the only open feature branch when neither is given.
${JSON_NOTE}`,
};

/** The actions of the record commands that take one, in the order the help lists them. */
export const RECORD_ACTIONS: Partial<Record<RecordCommand, readonly string[]>> = {
  issue: ["create", "list", "show", "close", "reopen"],
  feature: ["start", "update", "list", "brief", "waive", "pr"],
  task: ["start", "list", "brief", "close", "drop", "waive", "pr"],
  graph: ["map", "find", "symbol", "scope", "concepts"],
};

const HUMAN: Actor = { kind: "human" };

export class UsageError extends Error {
  override name = "UsageError";
}

/** An action the command does not have, such as `tmb task clsoe`. */
export class UnknownActionError extends UsageError {
  override name = "UnknownActionError";
  constructor(
    readonly command: RecordCommand,
    readonly action: string,
  ) {
    super(`unrecognized command '${action}'`);
  }
}

/** The error for a missing or unknown action of `command`. */
function actionError(command: RecordCommand, action: string | undefined): UsageError {
  if (action !== undefined) return new UnknownActionError(command, action);
  const actions = RECORD_ACTIONS[command]!;
  return new UsageError(`${command} needs an action: ${actions.slice(0, -1).join(", ")} or ${actions.at(-1)}`);
}

export function isRecordCommand(command: string | undefined): command is RecordCommand {
  return RECORD_COMMANDS.includes(command as RecordCommand);
}

type Request = { operation: OperationName; input: Record<string, unknown>; json: boolean; format: (result: never) => string };

function who(actor: Actor): string {
  return actor.kind === "human" ? "the Human" : `${actor.role} on ${actor.host}`;
}

function issueLine(issue: IssueSummary | Issue): string {
  return `${issue.id}  ${issue.state.padEnd(6)}  ${issue.title}${issue.milestone ? `  [${issue.milestone}]` : ""}`;
}

function formatList(issues: IssueSummary[]): string {
  return issues.length === 0 ? "No issues." : issues.map(issueLine).join("\n");
}

function discussionLine(discussion: Discussion): string {
  return `- ${discussion.createdAt} ${discussion.kind} by ${who(discussion.createdBy)} (${discussion.id}):\n  ${discussion.body.replace(/\n/g, "\n  ")}`;
}

function formatDetail({ issue, discussions, newestDecision }: IssueDetail): string {
  const lines = [issueLine(issue), `Created by ${who(issue.createdBy)} at ${issue.createdAt}; updated ${issue.updatedAt}.`];
  if (issue.body.trim() !== "") lines.push("", issue.body.trimEnd());
  if (newestDecision) lines.push("", `Decision in force: ${newestDecision.body}`);
  if (discussions.length > 0) lines.push("", "Discussion, oldest first:", ...discussions.map(discussionLine));
  return lines.join("\n");
}

function formatUpdate(verb: "Closed" | "Reopened", state: string) {
  return ({ issue, changed }: IssueUpdateResult) =>
    changed.length === 0 ? `Issue ${issue.id} is already ${state}.` : `${verb} issue ${issue.id}: ${issue.title}`;
}

function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No matches.";
  return hits.map((hit) => `${hit.issueId}  ${hit.state.padEnd(6)}  ${hit.title}\n  ${hit.kind === "issue" ? "" : `${hit.kind} ${hit.id}: `}${hit.snippet}`).join("\n");
}

function formatHistory(events: StoredEvent[]): string {
  return events.map((event) => `${event.at}  ${event.recordKind} ${event.type} by ${who(event.actor)}  ${JSON.stringify(event.data)}`).join("\n");
}

function words(positionals: string[], what: string): string {
  const text = positionals.join(" ");
  if (text.trim() === "") throw new UsageError(`missing ${what}`);
  return text;
}

function only(positionals: string[], what: string): string {
  if (positionals.length !== 1) throw new UsageError(`expected one ${what}, got ${positionals.length}`);
  return positionals[0]!;
}

function parse<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs({ args, options: { ...options, json: { type: "boolean" as const } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function issueRequest(args: string[]): Request {
  const [action, ...rest] = args;
  switch (action) {
    case "create": {
      const { values, positionals } = parse(rest, { body: { type: "string" }, milestone: { type: "string" } });
      const input = { title: words(positionals, "title"), body: values.body, milestone: values.milestone };
      return { operation: "issue_create", input, json: values.json === true, format: (issue: Issue) => `Created issue ${issue.id}: ${issue.title}` };
    }
    case "list": {
      const { values, positionals } = parse(rest, { state: { type: "string" } });
      if (positionals.length > 0) throw new UsageError(`issue list takes no arguments, got ${positionals.join(" ")}`);
      return { operation: "issue_list", input: { state: values.state }, json: values.json === true, format: formatList };
    }
    case "show": {
      const { values, positionals } = parse(rest, {});
      return { operation: "issue_get", input: { id: only(positionals, "issue id") }, json: values.json === true, format: formatDetail };
    }
    case "close":
    case "reopen": {
      const { values, positionals } = parse(rest, {});
      const closing = action === "close";
      return {
        operation: "issue_update",
        input: { id: only(positionals, "issue id"), state: closing ? "closed" : "open" },
        json: values.json === true,
        format: closing ? formatUpdate("Closed", "closed") : formatUpdate("Reopened", "open"),
      };
    }
    default:
      throw actionError("issue", action);
  }
}

/** A truest task's review: what to review, each verdict and waiver, and whether its pull request may open. */
function truestReviewLines(brief: TaskBrief): string[] {
  const review = brief.review!;
  const cover =
    review.to === null
      ? "not in review: its work is not closed yet"
      : review.coveredBy === null
        ? "not yet: the reviewer has not passed this commit and no waiver holds it"
        : `yes, by a ${review.coveredBy}`;
  return [
    ...(review.to === null ? [] : [`Review the diff: ${review.from ?? "?"}..${review.to}`]),
    "Reviews:",
    ...(review.reviews.length === 0
      ? ["  (none)"]
      : review.reviews.flatMap((each) => [
          `  ${each.verdict.padEnd(4)}  at ${(each.commit ?? "?").slice(0, 12)}  by ${who(each.by)}  ${each.at}`,
          ...each.findings.map((finding) => `    ${finding.blocking ? "blocking" : "note"}: ${finding.text}`),
        ])),
    ...review.waivers.map((waiver) => `Waived at ${waiver.commit.slice(0, 12)} by the Human: ${waiver.reason}`),
    ...review.carries.map((carry) => `Review carried from ${carry.from.slice(0, 12)} to ${carry.to.slice(0, 12)} by a rebase that kept the patch`),
    `Covered for its pull request: ${cover}`,
    ...(review.prUrl ? [`Pull request: ${review.prUrl}`] : []),
    `A reviewer's start prompt carries: ${review.reviewLine}`,
  ];
}

function briefLines(brief: TaskBrief): string[] {
  const list = (items: string[]) => (items.length === 0 ? ["  (none)"] : items.map((item) => `  - ${item}`));
  return [
    `Task ${brief.id}  ${brief.state}  on issue ${brief.issueId}`,
    `Kind: ${brief.kind ?? "(not recorded)"}`,
    ...(brief.repo ? [`Repo: ${brief.repo}`] : []),
    `Feature branch: ${brief.feature ?? "(none)"}`,
    `Branch: ${brief.branch ?? "(none)"}`,
    `Worktree: ${brief.worktree ?? "(none)"}`,
    ...(brief.commitSha ? [`Closed at commit: ${brief.commitSha}`] : []),
    ...(brief.reviewMode ? [`Review mode: ${brief.reviewMode}`] : []),
    ...(brief.push ? [`Push: ${brief.push.result}, ${brief.push.detail}`] : []),
    ...(brief.review ? truestReviewLines(brief) : []),
    ...(brief.dropReason === null ? [] : [`Dropped: ${brief.dropReason}`]),
    ...(brief.replaces === null ? [] : [`Replaces task: ${brief.replaces}`]),
    ...(brief.replacedBy.length === 0 ? [] : [`Replaced by: ${brief.replacedBy.join(", ")}`]),
    "",
    brief.spec.intent.trimEnd(),
    "",
    "Files it may touch:",
    ...list(brief.spec.files),
    "Success criteria:",
    ...list(brief.spec.criteria),
    "Checks that run at close:",
    ...list(brief.checks),
    "",
    `A worker's start prompt carries: ${brief.startLine}`,
  ];
}

function taskLine(task: TaskSummary, withState: boolean): string {
  const state = withState ? `  ${task.state.padEnd(6)}` : "";
  const commit = task.commitSha ? `\n  closed at: ${task.commitSha}` : "";
  const dropped = task.dropReason === null ? "" : `\n  dropped: ${task.dropReason}`;
  const replaces = task.replaces === null ? "" : `\n  replaces: ${task.replaces}`;
  const repo = task.repo ? `${task.repo}  ` : "";
  return `${task.id}${state}  ${repo}${task.branch ?? ""}  ${task.title}\n  files: ${task.files.join(", ")}${commit}${dropped}${replaces}`;
}

/** The open list keeps its plain form; a list that may mix states shows each task's state. */
function formatTasks(state: string | undefined) {
  const which = state === undefined || state === "open" ? "open " : state === "closed" || state === "dropped" ? `${state} ` : "";
  return (tasks: TaskSummary[]) =>
    tasks.length === 0 ? `No ${which}tasks.` : tasks.map((task) => taskLine(task, which !== "open ")).join("\n");
}

function formatClose({ brief, checks, fold, push, cleanupProblems, cleanedUp, next, notes }: TaskCloseResult): string {
  return [
    next === undefined ? `Closed task ${brief.id} at commit ${brief.commitSha}.` : `The checks passed at ${brief.commitSha}; ${next}.`,
    ...checks.map((check) => `  passed: ${check.command}`),
    ...(fold ? [`Folded into ${fold.feature}${fold.rebased ? `, rebased onto ${fold.from} and checked again` : ""}.`] : []),
    ...(push ? [`Push: ${push.result}, ${push.detail}`] : []),
    ...cleanupProblems.map((problem) => `Not cleaned up: ${problem}`),
    ...cleanedUp,
    ...notes,
  ].join("\n");
}

function featureLine(feature: FeatureSummary): string {
  const tasks = feature.tasks.length === 0 ? "no tasks" : `tasks: ${feature.tasks.join(", ")}`;
  const repo = feature.repo ? ` in ${feature.repo}` : "";
  return `${feature.name}  ${feature.state.padEnd(6)}${repo}  from ${feature.baseBranch} at ${feature.baseCommit}\n  ${tasks}`;
}

function featureBriefLines(brief: FeatureBrief): string[] {
  const cover = brief.coveredBy === null ? "not yet: the reviewer has not passed this tip and no waiver holds it" : `yes, by a ${brief.coveredBy}`;
  return [
    `Feature branch ${brief.name}  ${brief.state}  into ${brief.baseBranch}`,
    `Tip: ${brief.tip}  (review the diff from ${brief.mergeBase})`,
    `Holds the base: ${brief.base === null ? "unknown: git cannot read the base branch" : brief.holdsBase ? `yes, ${brief.baseBranch} at ${brief.base}` : `no, ${brief.baseBranch} is at ${brief.base}; bring it in with feature_update before the review`}`,
    `Covered at the tip: ${cover}`,
    ...(brief.prUrl === null ? [] : [`Pull request: ${brief.prUrl}`]),
    "Task groups:",
    ...(brief.groups.length === 0 ? ["  (none)"] : brief.groups.map((group) => `  ${group.task}  ${group.from.slice(0, 12)}..${group.to.slice(0, 12)}  ${group.title}`)),
    "Reviews:",
    ...(brief.reviews.length === 0
      ? ["  (none)"]
      : brief.reviews.flatMap((review) => [
          `  ${review.verdict.padEnd(4)}  at ${(review.commit ?? "?").slice(0, 12)}  by ${who(review.by)}  ${review.at}`,
          ...review.findings.map((finding) => `    ${finding.blocking ? "blocking" : "note"}: ${finding.text}`),
        ])),
    "Waivers:",
    ...(brief.waivers.length === 0 ? ["  (none)"] : brief.waivers.map((waiver) => `  at ${waiver.commit.slice(0, 12)}  ${waiver.at}  ${waiver.reason}`)),
  ];
}

function featureRequest(args: string[]): Request {
  const [action, ...rest] = args;
  switch (action) {
    case "start": {
      const { values, positionals } = parse(rest, { repo: { type: "string" } });
      const format = (feature: FeatureSummary) =>
        `Started feature branch ${feature.name}${feature.repo ? ` in ${feature.repo}` : ""} from ${feature.baseBranch} at ${feature.baseCommit}.`;
      const input = { name: only(positionals, "feature branch name"), ...(values.repo === undefined ? {} : { repo: values.repo }) };
      return { operation: "feature_start", input, json: values.json === true, format };
    }
    case "update": {
      const { values, positionals } = parse(rest, {});
      const format = (update: FeatureUpdateResult) => {
        if (update.how === "none") return `${update.feature} already holds ${update.baseBranch} at ${update.base}; nothing changed.`;
        const how = update.how === "merged" ? `merged into it at ${update.to}` : `fast-forwarded to it`;
        const push = update.push === null ? "" : ` Backup push: ${update.push.result} (${update.push.detail}).`;
        return `Brought ${update.baseBranch} at ${update.base} into ${update.feature}: ${how}.${push}`;
      };
      return { operation: "feature_update", input: { feature: only(positionals, "feature branch name") }, json: values.json === true, format };
    }
    case "list": {
      const { values, positionals } = parse(rest, {});
      if (positionals.length > 0) throw new UsageError(`feature list takes no arguments, got ${positionals.join(" ")}`);
      const format = (features: FeatureSummary[]) => (features.length === 0 ? "No feature branches." : features.map(featureLine).join("\n"));
      return { operation: "feature_list", input: {}, json: values.json === true, format };
    }
    case "brief": {
      const { values, positionals } = parse(rest, {});
      const format = (brief: FeatureBrief) => featureBriefLines(brief).join("\n");
      return { operation: "feature_brief", input: { feature: only(positionals, "feature branch name") }, json: values.json === true, format };
    }
    case "waive": {
      const { values, positionals } = parse(rest, { reason: { type: "string" } });
      if (values.reason === undefined) throw new UsageError("feature waive needs --reason <text>: why the review is waived");
      const format = (waiver: WaiveResult) =>
        [`Waived the review of ${waiver.feature} at ${waiver.commit}; its pull request may open now.`, markLine(waiver.mark)].filter((line) => line !== null).join("\n");
      return { operation: "feature_waive", input: { feature: only(positionals, "feature branch name"), reason: values.reason }, json: values.json === true, format };
    }
    case "pr": {
      const { values, positionals } = parse(rest, { title: { type: "string" }, body: { type: "string" } });
      if (values.title === undefined) throw new UsageError("feature pr needs --title <text>");
      const input = { feature: only(positionals, "feature branch name"), title: values.title, ...(values.body === undefined ? {} : { body: values.body }) };
      const format = (pr: FeaturePrResult) =>
        [`Opened the pull request of ${pr.feature} into ${pr.base} at ${pr.tip} (${pr.coveredBy}): ${pr.url}`, markRequiredLine(pr.base, pr.markRequired)]
          .filter((line) => line !== null)
          .join("\n");
      return { operation: "feature_pr", input, json: values.json === true, format };
    }
    default:
      throw actionError("feature", action);
  }
}

function taskRequest(args: string[]): Request {
  const [action, ...rest] = args;
  switch (action) {
    case "start": {
      const { values, positionals } = parse(rest, {
        kind: { type: "string" },
        feature: { type: "string" },
        intent: { type: "string" },
        file: { type: "string", multiple: true },
        criterion: { type: "string", multiple: true },
        check: { type: "string", multiple: true },
        repo: { type: "string" },
        replaces: { type: "string" },
      });
      const input = {
        issue_id: only(positionals, "issue id"),
        kind: values.kind,
        feature: values.feature,
        repo: values.repo,
        intent: values.intent,
        files: values.file ?? [],
        criteria: values.criterion ?? [],
        checks: values.check,
        ...(values.replaces === undefined ? {} : { replaces: values.replaces }),
      };
      const format = (started: TaskStartResult) => {
        const shared = started.sharedFiles.map((s) => `  - ${s.file} with ${s.theirs} of open task ${s.task} (${s.title})`);
        const note = shared.length === 0 ? [] : ["Shares files with other open tasks (git merges them; a clash reopens the later task):", ...shared, ""];
        return [`Started task ${started.id}.`, "", ...note, ...briefLines(started.brief)].join("\n");
      };
      return { operation: "task_start", input, json: values.json === true, format };
    }
    case "list": {
      const { values, positionals } = parse(rest, { state: { type: "string" } });
      if (positionals.length > 0) throw new UsageError(`task list takes no arguments, got ${positionals.join(" ")}`);
      return { operation: "task_list", input: { state: values.state }, json: values.json === true, format: formatTasks(values.state) };
    }
    case "brief": {
      const { values, positionals } = parse(rest, {});
      const format = (brief: TaskBrief) => briefLines(brief).join("\n");
      return { operation: "task_brief", input: { id: only(positionals, "task id") }, json: values.json === true, format };
    }
    case "close": {
      const { values, positionals } = parse(rest, {});
      return { operation: "task_close", input: { id: only(positionals, "task id") }, json: values.json === true, format: formatClose };
    }
    case "drop": {
      const { values, positionals } = parse(rest, { reason: { type: "string" } });
      if (values.reason === undefined) throw new UsageError("task drop needs --reason <text>: why the task is dropped");
      const format = (dropped: TaskDropResult) =>
        [
          `Dropped task ${dropped.brief.id}: ${dropped.brief.dropReason}`,
          ...dropped.cleanupProblems.map((problem) => `Not cleaned up: ${problem}`),
          ...dropped.cleanedUp,
          ...(dropped.keptBranch === null ? [] : [`Kept: ${dropped.keptBranch}`]),
        ].join("\n");
      return { operation: "task_drop", input: { id: only(positionals, "task id"), reason: values.reason }, json: values.json === true, format };
    }
    case "waive": {
      const { values, positionals } = parse(rest, { reason: { type: "string" } });
      if (values.reason === undefined) throw new UsageError("task waive needs --reason <text>: why the review is waived");
      const format = (waiver: TaskWaiveResult) =>
        [`Waived the review of task ${waiver.task} at ${waiver.commit}; its pull request may open now.`, markLine(waiver.mark)].filter((line) => line !== null).join("\n");
      return { operation: "task_waive", input: { id: only(positionals, "task id"), reason: values.reason }, json: values.json === true, format };
    }
    case "pr": {
      const { values, positionals } = parse(rest, { title: { type: "string" }, body: { type: "string" } });
      if (values.title === undefined) throw new UsageError("task pr needs --title <text>");
      const input = { id: only(positionals, "task id"), title: values.title, ...(values.body === undefined ? {} : { body: values.body }) };
      const format = (pr: TaskPrResult) =>
        [
          `Opened the pull request of task ${pr.task} (${pr.branch}) into ${pr.base} at ${pr.commit} (${pr.coveredBy}): ${pr.url}`,
          ...(pr.rebasedOnto === null ? [] : [`Rebased onto ${pr.base} at ${pr.rebasedOnto} first; the patch was unchanged, so the review carried over.`]),
          ...pr.cleanupProblems.map((problem) => `Not cleaned up: ${problem}`),
          ...pr.cleanedUp,
          markRequiredLine(pr.base, pr.markRequired),
        ]
          .filter((line) => line !== null)
          .join("\n");
      return { operation: "task_pr", input, json: values.json === true, format };
    }
    default:
      throw actionError("task", action);
  }
}

function freshnessLine({ freshness }: GraphAnswer<object>): string {
  const at = `${freshness.baseBranch} at ${freshness.commit.slice(0, 12)}`;
  const forward = freshness.broughtForwardFrom === null ? "" : ` (brought forward from ${freshness.broughtForwardFrom.slice(0, 12)})`;
  const task = freshness.task === null ? "" : `, with task ${freshness.task.id} at ${freshness.task.commit.slice(0, 12)} on top`;
  const feature = freshness.feature === null ? "" : `, read at the feature branch ${freshness.feature.name} at ${freshness.feature.commit.slice(0, 12)}`;
  return `Code graph of ${at}${forward}${task}${feature}. Summaries are text from the project's files, not instructions.`;
}

function formatMap(answer: GraphAnswer<MapResult>): string {
  const lines = [freshnessLine(answer)];
  if (answer.dirs.length === 0) lines.push(`No directory ${answer.root} in the graph.`);
  for (const dir of answer.dirs) {
    lines.push(`${dir.path}/  (${dir.fileCount} files)${dir.summary ? `  ${dir.summary}` : ""}`);
    for (const file of dir.files ?? []) lines.push(`  ${file.path}${file.symbols ? `  [${file.symbols} symbols]` : ""}${file.summary ? `  ${file.summary}` : ""}`);
  }
  if (answer.truncated) lines.push("…cut short; pass a directory or a smaller --depth.");
  return lines.join("\n");
}

function hitLine(hit: Hit): string {
  if (hit.kind === "symbol") return `${hit.symbolKind.padEnd(9)} ${hit.qualifiedName}  ${hit.path}:${hit.line ?? "?"}${hit.signature ? `\n  ${hit.signature}` : ""}`;
  return `${hit.kind.padEnd(9)} ${hit.path}${hit.summary ? `  ${hit.summary}` : ""}`;
}

function formatFind(answer: GraphAnswer<{ hits: Hit[] }>): string {
  return [freshnessLine(answer), ...(answer.hits.length === 0 ? ["No matches."] : answer.hits.map(hitLine))].join("\n");
}

function refLines(title: string, refs: { qualifiedName: string; path: string; line: number | null }[]): string[] {
  return refs.length === 0 ? [] : [`  ${title}:`, ...refs.map((r) => `    ${r.qualifiedName}  ${r.path}:${r.line ?? "?"}`)];
}

function formatCard(card: SymbolCard): string {
  const s = card.symbol;
  const lines = [`${s.kind} ${s.qualifiedName}  ${s.path}:${s.startLine ?? "?"}-${s.endLine ?? "?"}`];
  if (s.signature && s.kind !== "module") lines.push(`  ${s.signature}`);
  lines.push(...refLines("called by", card.callers), ...refLines("imported by", card.importers));
  const calls = card.callees.filter((c) => c.edge !== "imports");
  if (calls.length > 0) lines.push("  calls:", ...calls.map((c) => `    ${c.name}  ${c.target ? `${c.target.path}` : "unresolved"}`));
  if (card.tests.length > 0) lines.push("  tests:", ...card.tests.map((t) => `    ${t}`));
  if (card.unresolved.count > 0) lines.push(`  ${card.unresolved.count} unresolved references name it but are not proven to mean it.`);
  if (card.concepts.length > 0) lines.push(`  concepts: ${card.concepts.map((c) => `${c.name} (${c.status})`).join(", ")}`);
  return lines.join("\n");
}

function formatSymbol(answer: GraphAnswer<{ cards: SymbolCard[]; more: number }>): string {
  const lines = [freshnessLine(answer), ...(answer.cards.length === 0 ? ["No such symbol or file."] : answer.cards.map(formatCard))];
  if (answer.more > 0) lines.push(`…and ${answer.more} more with that name; pass --path.`);
  return lines.join("\n");
}

function formatScope(answer: GraphAnswer<ScopeResult>): string {
  const lines = [freshnessLine(answer)];
  const fileLine = (f: { path: string; via: string[] }) => `  ${f.path}  (${f.via.join(", ")})`;
  lines.push(answer.files.length === 0 ? "No files in scope." : "Files:", ...answer.files.map(fileLine));
  if (answer.tests.length > 0) lines.push("Tests:", ...answer.tests.map(fileLine));
  if (answer.unresolvedAnchors.length > 0) lines.push(`Not found: ${answer.unresolvedAnchors.join(", ")}`);
  if (answer.concepts.length > 0) lines.push(`Concepts: ${answer.concepts.map((c) => `${c.name} (${c.status})`).join(", ")}`);
  return lines.join("\n");
}

function formatConcepts(answer: GraphAnswer<{ concepts: Concept[] }>): string {
  if (answer.concepts.length === 0) return "No concepts.";
  return answer.concepts
    .map((c) => `${c.name}  ${c.kind}  ${c.status}${c.statusReason ? ` (${c.statusReason})` : ""}\n  ${c.body}\n  anchors: ${c.anchors.map((a) => (a.qualifiedName ? `${a.path}#${a.qualifiedName}` : a.path)).join(", ")}`)
    .join("\n");
}

function graphRequest(args: string[]): Request {
  const [action, ...rest] = args;
  switch (action) {
    case "map": {
      const { values, positionals } = parse(rest, { depth: { type: "string" }, task: { type: "string" }, feature: { type: "string" } });
      if (positionals.length > 1) throw new UsageError(`graph map takes at most one directory, got ${positionals.length}`);
      const depth = values.depth === undefined ? undefined : Number(values.depth);
      if (depth !== undefined && !Number.isInteger(depth)) throw new UsageError(`--depth must be a whole number, got ${values.depth}`);
      return { operation: "graph_map", input: { path: positionals[0], depth, task_id: values.task, feature: values.feature }, json: values.json === true, format: formatMap };
    }
    case "find": {
      const { values, positionals } = parse(rest, { task: { type: "string" }, feature: { type: "string" } });
      return { operation: "graph_find", input: { query: words(positionals, "search words"), task_id: values.task, feature: values.feature }, json: values.json === true, format: formatFind };
    }
    case "symbol": {
      const { values, positionals } = parse(rest, { path: { type: "string" }, task: { type: "string" }, feature: { type: "string" } });
      return {
        operation: "graph_symbol",
        input: { name: only(positionals, "symbol name or file path"), path: values.path, task_id: values.task, feature: values.feature },
        json: values.json === true,
        format: formatSymbol,
      };
    }
    case "scope": {
      const { values, positionals } = parse(rest, { anchor: { type: "string", multiple: true }, task: { type: "string" }, feature: { type: "string" } });
      return {
        operation: "graph_scope",
        input: { objective: positionals.join(" "), anchors: values.anchor, task_id: values.task, feature: values.feature },
        json: values.json === true,
        format: formatScope,
      };
    }
    case "concepts": {
      const { values, positionals } = parse(rest, {});
      return {
        operation: "graph_concepts",
        input: { query: positionals.length === 0 ? undefined : positionals.join(" ") },
        json: values.json === true,
        format: formatConcepts,
      };
    }
    default:
      throw actionError("graph", action);
  }
}

function toRequest(command: RecordCommand, args: string[]): Request {
  switch (command) {
    case "issue":
      return issueRequest(args);
    case "feature":
      return featureRequest(args);
    case "task":
      return taskRequest(args);
    case "graph":
      return graphRequest(args);
    case "note": {
      const { values, positionals } = parse(args, { decision: { type: "boolean" } });
      const [issueId, ...text] = positionals;
      if (issueId === undefined) throw new UsageError("note needs an issue id and the text");
      const kind = values.decision === true ? "decision" : "note";
      return {
        operation: "discussion_append",
        input: { issue_id: issueId, kind, body: words(text, `${kind} text`) },
        json: values.json === true,
        format: (discussion: Discussion) => `Added a ${discussion.kind} to issue ${discussion.issueId}: ${discussion.id}`,
      };
    }
    case "search": {
      const { values, positionals } = parse(args, {});
      return { operation: "search", input: { query: words(positionals, "search query") }, json: values.json === true, format: formatHits };
    }
    case "history": {
      const { values, positionals } = parse(args, {});
      return { operation: "history", input: { id: only(positionals, "record id") }, json: values.json === true, format: formatHistory };
    }
  }
}

/** Where a command writes; `colour` says whether what goes to `err` may be coloured. */
export type Output = { out: (text: string) => void; err: (text: string) => void; colour?: boolean };

/** Writes a usage error of `tmb <command>`: the closest actions on a typo, else the error and where to read more. */
function writeUsageError(command: string, error: UsageError, output: Output): void {
  const paint = new Paint(output.colour === true);
  const program = `tmb ${command}`;
  const text =
    error instanceof UnknownActionError
      ? unknownCommandText(program, error.action, RECORD_ACTIONS[error.command] ?? [], paint)
      : usageErrorText(program, error.message, paint);
  output.err(text.trimEnd());
}

/** Runs one record command in the project as the Human; resolves to the exit code. */
export async function runRecordCommand(command: RecordCommand, args: string[], projectDir: string, output: Output): Promise<number> {
  let request: Request;
  try {
    request = toRequest(command, args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    writeUsageError(command, error, output);
    return 2;
  }

  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    output.err(
      opened.error.failure === "missing"
        ? `tmb: no tmb record in ${projectDir}; run \`tmb init\` there first.`
        : `tmb: cannot use the record: ${opened.error.message}`,
    );
    return 1;
  }
  try {
    const result = await OPERATIONS[request.operation].run(opened.store, HUMAN, request.input, { projectDir });
    output.out(request.json ? JSON.stringify(result, null, 2) : request.format(result as never));
    return 0;
  } catch (error) {
    if (!(error instanceof HandlerError)) throw error;
    output.err(`tmb ${command}: ${error.message}`);
    return 1;
  } finally {
    opened.store.close();
  }
}

export const CONFIG_USAGE = `  tmb config [--json]       Print the project's settings`;

/** Prints the project's settings, as `tmb config` does; returns the exit code. */
export function runConfigCommand(args: string[], projectDir: string, output: Output): number {
  let json: boolean;
  try {
    const { values, positionals } = parse(args, {});
    if (positionals.length > 0) throw new UsageError(`config takes no arguments, got ${positionals.join(" ")}`);
    json = values.json === true;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    writeUsageError("config", error, output);
    return 2;
  }

  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    output.err(
      opened.error.failure === "missing"
        ? `tmb: tmb init has not run in ${projectDir}, so it has no settings; run \`tmb init\` there first.`
        : `tmb: cannot use the record: ${opened.error.message}`,
    );
    return 1;
  }
  try {
    const settings = readSettings(opened.store);
    // A single-repo project has no repos, and prints its settings as it always has.
    const { repos, ...rest } = settings;
    const printed = repos === null ? rest : settings;
    output.out(json ? JSON.stringify(printed, null, 2) : settingLines(settings).join("\n"));
    return 0;
  } finally {
    opened.store.close();
  }
}

export const INDEX_USAGE = `  tmb index [--rebuild]     Index the base branch into the code graph now, or in a workspace
                            each repo's; reads keep it current on their own. --rebuild
                            reparses every file`;

/** Indexes the project's base branch, as `tmb index` does; resolves to the exit code. */
export async function runIndexCommand(args: string[], projectDir: string, output: Output): Promise<number> {
  let rebuild: boolean;
  let json: boolean;
  try {
    const { values, positionals } = parse(args, { rebuild: { type: "boolean" } });
    if (positionals.length > 0) throw new UsageError(`index takes no arguments, got ${positionals.join(" ")}`);
    rebuild = values.rebuild === true;
    json = values.json === true;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    writeUsageError("index", error, output);
    return 2;
  }
  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    output.err(
      opened.error.failure === "missing" ? `tmb: no tmb record in ${projectDir}; run \`tmb init\` there first.` : `tmb: cannot use the record: ${opened.error.message}`,
    );
    return 1;
  }
  const line = (stats: Awaited<ReturnType<typeof indexProject>>) =>
    `Indexed ${stats.repo ? `${stats.repo} from ` : ""}${stats.baseBranch} at ${stats.commit.slice(0, 12)}: ${stats.files} files, ${stats.symbols} symbols, ${stats.functions} functions, ${stats.edges} references (${stats.unresolved} unresolved); parsed ${stats.parsed}, reused ${stats.reused}; ${stats.notParsed} ${stats.notParsed === 1 ? "file" : "files"} not parsed.`;
  try {
    const repos = workspaceRepos(opened.store);
    if (repos !== null) {
      // Each repo is indexed on its own; one that cannot be indexed yet says why, and the run goes on.
      const all: unknown[] = [];
      let failed = false;
      for (const name of workingRepos(repos)) {
        try {
          const stats = await indexProject(projectDir, opened.store, { rebuild, repo: repoOfRow(opened.store, projectDir, { repo: name }) });
          all.push(stats);
          if (!json) output.out(line(stats));
        } catch (error) {
          if (!(error instanceof HandlerError)) throw error;
          failed = true;
          all.push({ repo: name, error: error.message });
          if (!json) output.err(`tmb index: ${name}: ${error.message}`);
        }
      }
      if (json) output.out(JSON.stringify(all, null, 2));
      else if (all.length === 0) output.out("This workspace has no repo tmb works in; `tmb init` finds its repos.");
      return failed ? 1 : 0;
    }
    const stats = await indexProject(projectDir, opened.store, { rebuild });
    output.out(json ? JSON.stringify(stats, null, 2) : line(stats));
    return 0;
  } catch (error) {
    if (!(error instanceof HandlerError)) throw error;
    output.err(`tmb index: ${error.message}`);
    return 1;
  } finally {
    opened.store.close();
  }
}
