// The record commands of the command line: the Human's way into the record. Each command
// calls the same operation an agent's tool call does, acting as the Human.
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  type FeatureSummary,
  HandlerError,
  type IssueDetail,
  type IssueUpdateResult,
  OPERATIONS,
  type OperationName,
  type TaskBrief,
  type TaskCloseResult,
  type TaskStartResult,
  type TaskSummary,
} from "../handlers/index.ts";
import { openProjectStore } from "../project.ts";
import { readSettings, settingLines } from "../settings.ts";
import type { Actor, Discussion, Issue, IssueSummary, SearchHit, StoredEvent } from "../store/index.ts";

export const RECORD_COMMANDS = ["issue", "note", "search", "history", "feature", "task"] as const;
export type RecordCommand = (typeof RECORD_COMMANDS)[number];

export const RECORD_USAGE = `  tmb issue create <title> [--body <text>] [--milestone <name>]
                            Record a new issue
  tmb issue list [--state open|closed]
                            List issues
  tmb issue show <id>       Show an issue with its notes and decisions
  tmb issue close <id>      Close an issue
  tmb issue reopen <id>     Reopen an issue
  tmb note <issue-id> <text> [--decision]
                            Add a note, or with --decision a decision, to an issue
  tmb search <query>        Search issues, notes and decisions
  tmb history <id>          Show every recorded change to an issue or note
  tmb feature start <name>  Cut a feature branch from the base branch and record it
  tmb feature list          List the feature branches with their base, state and tasks
  tmb task start <issue-id> --kind code|docs [--feature <name>] --intent <text> --file <path>...
                 --criterion <text>... [--check <command>]...
                            Start a task: cut its branch and worktree from the feature
                            branch and record its spec
  tmb task list [--state open|closed|all]
                            List the open tasks, or the closed ones or all
  tmb task brief <id>       Show a task's spec, worktree, branch and checks
  tmb task close <id>       Run the checks on the task's commit; when all pass, close it,
                            fold it into its feature branch and push that to origin
  Add --json to any of these for JSON output.`;

const HUMAN: Actor = { kind: "human" };

export class UsageError extends Error {
  override name = "UsageError";
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
      throw new UsageError(action === undefined ? "issue needs an action: create, list, show, close or reopen" : `unknown issue action '${action}'`);
  }
}

function briefLines(brief: TaskBrief): string[] {
  const list = (items: string[]) => (items.length === 0 ? ["  (none)"] : items.map((item) => `  - ${item}`));
  return [
    `Task ${brief.id}  ${brief.state}  on issue ${brief.issueId}`,
    `Kind: ${brief.kind ?? "(not recorded)"}`,
    `Feature branch: ${brief.feature ?? "(none)"}`,
    `Branch: ${brief.branch ?? "(none)"}`,
    `Worktree: ${brief.worktree ?? "(none)"}`,
    ...(brief.commitSha ? [`Closed at commit: ${brief.commitSha}`] : []),
    ...(brief.reviewMode ? [`Review mode: ${brief.reviewMode}`] : []),
    ...(brief.push ? [`Push: ${brief.push.result}, ${brief.push.detail}`] : []),
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
  return `${task.id}${state}  ${task.branch ?? ""}  ${task.title}\n  files: ${task.files.join(", ")}${commit}`;
}

/** The open list keeps its plain form; a list that may mix states shows each task's state. */
function formatTasks(state: string | undefined) {
  const which = state === undefined || state === "open" ? "open " : state === "closed" ? "closed " : "";
  return (tasks: TaskSummary[]) =>
    tasks.length === 0 ? `No ${which}tasks.` : tasks.map((task) => taskLine(task, which !== "open ")).join("\n");
}

function formatClose({ brief, checks, fold, push, cleanupProblems }: TaskCloseResult): string {
  return [
    `Closed task ${brief.id} at commit ${brief.commitSha}.`,
    ...checks.map((check) => `  passed: ${check.command}`),
    ...(fold ? [`Folded into ${fold.feature}${fold.rebased ? `, rebased onto ${fold.from} and checked again` : ""}.`] : []),
    ...(push ? [`Push: ${push.result}, ${push.detail}`] : []),
    ...cleanupProblems.map((problem) => `Not cleaned up: ${problem}`),
  ].join("\n");
}

function featureLine(feature: FeatureSummary): string {
  const tasks = feature.tasks.length === 0 ? "no tasks" : `tasks: ${feature.tasks.join(", ")}`;
  return `${feature.name}  ${feature.state.padEnd(6)}  from ${feature.baseBranch} at ${feature.baseCommit}\n  ${tasks}`;
}

function featureRequest(args: string[]): Request {
  const [action, ...rest] = args;
  switch (action) {
    case "start": {
      const { values, positionals } = parse(rest, {});
      const format = (feature: FeatureSummary) => `Started feature branch ${feature.name} from ${feature.baseBranch} at ${feature.baseCommit}.`;
      return { operation: "feature_start", input: { name: only(positionals, "feature branch name") }, json: values.json === true, format };
    }
    case "list": {
      const { values, positionals } = parse(rest, {});
      if (positionals.length > 0) throw new UsageError(`feature list takes no arguments, got ${positionals.join(" ")}`);
      const format = (features: FeatureSummary[]) => (features.length === 0 ? "No feature branches." : features.map(featureLine).join("\n"));
      return { operation: "feature_list", input: {}, json: values.json === true, format };
    }
    default:
      throw new UsageError(action === undefined ? "feature needs an action: start or list" : `unknown feature action '${action}'`);
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
      });
      const input = {
        issue_id: only(positionals, "issue id"),
        kind: values.kind,
        feature: values.feature,
        intent: values.intent,
        files: values.file ?? [],
        criteria: values.criterion ?? [],
        checks: values.check,
      };
      const format = (started: TaskStartResult) => [`Started task ${started.id}.`, "", ...briefLines(started.brief)].join("\n");
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
    default:
      throw new UsageError(action === undefined ? "task needs an action: start, list, brief or close" : `unknown task action '${action}'`);
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

export type Output = { out: (text: string) => void; err: (text: string) => void };

/** Runs one record command in the project as the Human; resolves to the exit code. */
export async function runRecordCommand(command: RecordCommand, args: string[], projectDir: string, output: Output): Promise<number> {
  let request: Request;
  try {
    request = toRequest(command, args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    output.err(`tmb ${command}: ${error.message}\n\n${RECORD_USAGE}`);
    return 2;
  }

  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    output.err(
      opened.error.failure === "missing"
        ? `tmb: no tmb record in ${projectDir}; run \`tmb setup\` there first.`
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
    output.err(`tmb config: ${error.message}\n\n${CONFIG_USAGE}`);
    return 2;
  }

  const opened = openProjectStore(projectDir, { create: false });
  if (!opened.ok) {
    output.err(
      opened.error.failure === "missing"
        ? `tmb: setup has not run in ${projectDir}, so it has no settings; run \`tmb setup\` there first.`
        : `tmb: cannot use the record: ${opened.error.message}`,
    );
    return 1;
  }
  try {
    const settings = readSettings(opened.store);
    output.out(json ? JSON.stringify(settings, null, 2) : settingLines(settings).join("\n"));
    return 0;
  } finally {
    opened.store.close();
  }
}
