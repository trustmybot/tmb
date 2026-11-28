// `tmb task`: start, list, brief, close, drop, waive and open tasks.
import { markLine, markRequiredLine, type TaskBrief, type TaskCloseResult, type TaskDropResult, type TaskPrResult, type TaskStartResult, type TaskSummary, type TaskWaiveResult } from "../../engine/index.ts";
import { only, parseWithJson } from "../arguments.ts";
import { listed, UsageError } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest, reviewLines, who } from "./record.ts";

export class TaskCommand extends RecordCommand {
  readonly name = "task";
  readonly summary = "Start, close and review tasks";
  readonly listing = listed("Work");
  override readonly actions = ["start", "list", "brief", "close", "drop", "waive", "pr"] as const;

  usage(): string {
    return `  tmb task start <issue-id> --kind code|docs [--feature <name>] [--repo <name>] --intent <text>
                 --file <path>... --criterion <text>... [--check <command>]... [--replaces <id>]
                            Start a task: cut its branch and worktree from the feature
                            branch and record its spec; --replaces names the dropped task
                            it takes over from
  tmb task list [--state open|in_review|ready|closed|dropped|all]
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
                            Waive the review of a truest task at its commit (the Human only, on a terminal)
  tmb task pr <id> --title <text> [--body <text>]
                            Open a truest task's pull request into the base branch, once
                            the reviewer passed it or the Human waived the review
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const [action, ...rest] = args;
    switch (action) {
      case "start": {
        const { values, positionals } = parseWithJson(rest, {
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
        return { operation: "task_start", input, json: values.json === true, format: formatStart };
      }
      case "list": {
        const { values, positionals } = parseWithJson(rest, { state: { type: "string" } });
        if (positionals.length > 0) throw new UsageError(`task list takes no arguments, got ${positionals.join(" ")}`);
        return { operation: "task_list", input: { state: values.state }, json: values.json === true, format: formatTasks(values.state) };
      }
      case "brief": {
        const { values, positionals } = parseWithJson(rest, {});
        const format = (brief: TaskBrief) => briefLines(brief).join("\n");
        return { operation: "task_brief", input: { id: only(positionals, "task id") }, json: values.json === true, format };
      }
      case "close": {
        const { values, positionals } = parseWithJson(rest, {});
        return { operation: "task_close", input: { id: only(positionals, "task id") }, json: values.json === true, format: formatClose };
      }
      case "drop": {
        const { values, positionals } = parseWithJson(rest, { reason: { type: "string" } });
        if (values.reason === undefined) throw new UsageError("task drop needs --reason <text>: why the task is dropped");
        return { operation: "task_drop", input: { id: only(positionals, "task id"), reason: values.reason }, json: values.json === true, format: formatDrop };
      }
      case "waive": {
        const { values, positionals } = parseWithJson(rest, { reason: { type: "string" } });
        if (values.reason === undefined) throw new UsageError("task waive needs --reason <text>: why the review is waived");
        const format = (waiver: TaskWaiveResult) =>
          [`Waived the review of task ${waiver.task} at ${waiver.commit}; its pull request may open now.`, markLine(waiver.mark)].filter((line) => line !== null).join("\n");
        return { operation: "task_waive", input: { id: only(positionals, "task id"), reason: values.reason }, json: values.json === true, format };
      }
      case "pr": {
        const { values, positionals } = parseWithJson(rest, { title: { type: "string" }, body: { type: "string" } });
        if (values.title === undefined) throw new UsageError("task pr needs --title <text>");
        const input = { id: only(positionals, "task id"), title: values.title, ...(values.body === undefined ? {} : { body: values.body }) };
        return { operation: "task_pr", input, json: values.json === true, format: formatPr };
      }
      default:
        throw this.actionError(action);
    }
  }
}

function formatStart(started: TaskStartResult): string {
  const shared = started.sharedFiles.map((s) => `  - ${s.file} with ${s.theirs} of open task ${s.task} (${s.title})`);
  const note = shared.length === 0 ? [] : ["Shares files with other open tasks (git merges them; a clash reopens the later task):", ...shared, ""];
  return [`Started task ${started.id}.`, "", ...note, ...briefLines(started.brief)].join("\n");
}

function formatDrop(dropped: TaskDropResult): string {
  return [
    `Dropped task ${dropped.brief.id}: ${dropped.brief.dropReason}`,
    ...dropped.cleanupProblems.map((problem) => `Not cleaned up: ${problem}`),
    ...dropped.cleanedUp,
    ...(dropped.keptBranch === null ? [] : [`Kept: ${dropped.keptBranch}`]),
  ].join("\n");
}

function formatPr(pr: TaskPrResult): string {
  return [
    pr.localMerge === null
      ? `Opened the pull request of task ${pr.task} (${pr.branch}) into ${pr.base} at ${pr.commit} (${pr.coveredBy}): ${pr.url}`
      : `Task ${pr.task} (${pr.branch}) is ready at ${pr.commit} (${pr.coveredBy}). The repository has no remote, so nothing was pushed and no pull request opened. Merge it locally, in ${pr.localMerge.dir}:\n  ${pr.localMerge.command}\n${pr.localMerge.otherwise}`,
    ...(pr.rebasedOnto === null ? [] : [`Rebased onto ${pr.base} at ${pr.rebasedOnto} first; the patch was unchanged, so the review carried over.`]),
    ...pr.cleanupProblems.map((problem) => `Not cleaned up: ${problem}`),
    ...pr.cleanedUp,
    markRequiredLine(pr.base, pr.markRequired),
  ]
    .filter((line) => line !== null)
    .join("\n");
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
    ...reviewLines(review.reviews),
    ...review.waivers.map((waiver) => `Waived at ${waiver.commit.slice(0, 12)} by ${who(waiver.by)}: ${waiver.reason}`),
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
  return (tasks: TaskSummary[]) => (tasks.length === 0 ? `No ${which}tasks.` : tasks.map((task) => taskLine(task, which !== "open ")).join("\n"));
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
