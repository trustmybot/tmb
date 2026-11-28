// `tmb issue`: list and show issues. The planner records and changes them, with its tools.
import type { Discussion, Issue, IssueDetail, IssueList, IssueSummary } from "../../engine/index.ts";
import { only, parseWithJson } from "../arguments.ts";
import { listed, UsageError } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest, who } from "./record.ts";

export class IssueCommand extends RecordCommand {
  readonly name = "issue";
  readonly summary = "List and show issues";
  readonly listing = listed("Work");
  override readonly actions = ["list", "show"] as const;

  usage(): string {
    return `  tmb issue list [--state open|closed|all] [--limit <n>] [--offset <n>]
                            List issues, newest first: the open ones unless --state
                            names others, one page at a time
  tmb issue show <id>       Show an issue with its notes and decisions
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const [action, ...rest] = args;
    switch (action) {
      case "list": {
        const { values, positionals } = parseWithJson(rest, { state: { type: "string" }, limit: { type: "string" }, offset: { type: "string" } });
        if (positionals.length > 0) throw new UsageError(`issue list takes no arguments, got ${positionals.join(" ")}`);
        const input = { state: values.state, limit: count(values.limit, "--limit"), offset: count(values.offset, "--offset") };
        return { operation: "issue_list", input, json: values.json === true, format: formatList };
      }
      case "show": {
        const { values, positionals } = parseWithJson(rest, {});
        return { operation: "issue_get", input: { id: only(positionals, "issue id") }, json: values.json === true, format: formatDetail };
      }
      default:
        throw this.actionError(action);
    }
  }
}

function issueLine(issue: IssueSummary | Issue): string {
  return `${issue.id}  ${issue.state.padEnd(6)}  ${issue.title}${issue.milestone ? `  [${issue.milestone}]` : ""}`;
}

function count(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} takes a whole number, got ${value}`);
  return Number(value);
}

function formatList({ issues, total, nextOffset }: IssueList): string {
  const lines = issues.length === 0 ? ["No issues."] : issues.map(issueLine);
  if (nextOffset !== undefined) lines.push(`…and ${total - nextOffset} more; run it again with --offset ${nextOffset} for the next ones.`);
  return lines.join("\n");
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
