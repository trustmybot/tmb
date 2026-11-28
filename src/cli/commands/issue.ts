// `tmb issue`: create, list, show, close and reopen issues.
import type { Discussion, Issue, IssueDetail, IssueSummary, IssueUpdateResult } from "../../engine/index.ts";
import { only, parseWithJson, words } from "../arguments.ts";
import { listed, UsageError } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest, who } from "./record.ts";

export class IssueCommand extends RecordCommand {
  readonly name = "issue";
  readonly summary = "Create, list, show, close and reopen issues";
  readonly listing = listed("Work");
  override readonly actions = ["create", "list", "show", "close", "reopen"] as const;

  usage(): string {
    return `  tmb issue create <title> [--body <text>] [--milestone <name>]
                            Record a new issue
  tmb issue list [--state open|closed]
                            List issues
  tmb issue show <id>       Show an issue with its notes and decisions
  tmb issue close <id>      Close an issue
  tmb issue reopen <id>     Reopen an issue
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const [action, ...rest] = args;
    switch (action) {
      case "create": {
        const { values, positionals } = parseWithJson(rest, { body: { type: "string" }, milestone: { type: "string" } });
        const input = { title: words(positionals, "title"), body: values.body, milestone: values.milestone };
        return { operation: "issue_create", input, json: values.json === true, format: (issue: Issue) => `Created issue ${issue.id}: ${issue.title}` };
      }
      case "list": {
        const { values, positionals } = parseWithJson(rest, { state: { type: "string" } });
        if (positionals.length > 0) throw new UsageError(`issue list takes no arguments, got ${positionals.join(" ")}`);
        return { operation: "issue_list", input: { state: values.state }, json: values.json === true, format: formatList };
      }
      case "show": {
        const { values, positionals } = parseWithJson(rest, {});
        return { operation: "issue_get", input: { id: only(positionals, "issue id") }, json: values.json === true, format: formatDetail };
      }
      case "close":
      case "reopen": {
        const { values, positionals } = parseWithJson(rest, {});
        const closing = action === "close";
        return {
          operation: "issue_update",
          input: { id: only(positionals, "issue id"), state: closing ? "closed" : "open" },
          json: values.json === true,
          format: closing ? formatUpdate("Closed", "closed") : formatUpdate("Reopened", "open"),
        };
      }
      default:
        throw this.actionError(action);
    }
  }
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
  return ({ issue, changed }: IssueUpdateResult) => (changed.length === 0 ? `Issue ${issue.id} is already ${state}.` : `${verb} issue ${issue.id}: ${issue.title}`);
}
