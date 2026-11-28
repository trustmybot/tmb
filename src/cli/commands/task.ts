// `tmb task`: list and brief tasks, and waive a review. The planner and the worker start, close,
// drop and open them, with their tools.
import { markLine, markRequiredLine, type TaskBrief, type TaskCloseResult, type TaskDropResult, type TaskPrResult, type TaskStartResult, type TaskSummary, type TaskWaiveResult } from "../../engine/index.ts";
import { only, parseWithJson } from "../arguments.ts";
import { listed, UsageError } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest, reviewLines, who } from "./record.ts";

export class TaskCommand extends RecordCommand {
  readonly name = "task";
  readonly summary = "List tasks and waive a review";
  readonly listing = listed("Work");
  override readonly actions = ["list", "brief", "waive"] as const;

  usage(): string {
    return `  tmb task list [--state open|in_review|ready|closed|dropped|all]
                            List the open tasks, or those in review, the closed ones, the
                            dropped ones or all
  tmb task brief <id>       Show a task's spec, worktree, branch and checks
  tmb task waive <id> --reason <text>
                            Waive the review of a truest task at its commit (the Human only, on a terminal)
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const [action, ...rest] = args;
    switch (action) {
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
      case "waive": {
        const { values, positionals } = parseWithJson(rest, { reason: { type: "string" } });
        if (values.reason === undefined) throw new UsageError("task waive needs --reason <text>: why the review is waived");
        const format = (waiver: TaskWaiveResult) =>
          [`Waived the review of task ${waiver.task} at ${waiver.commit}; its pull request may open now.`, markLine(waiver.mark)].filter((line) => line !== null).join("\n");
        return { operation: "task_waive", input: { id: only(positionals, "task id"), reason: values.reason }, json: values.json === true, format };
      }
      default:
        throw this.actionError(action);
    }
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

