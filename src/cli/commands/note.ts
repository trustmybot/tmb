// `tmb note`: add a note or a decision to an issue.
import type { Discussion } from "../../engine/index.ts";
import { parseWithJson, words } from "../arguments.ts";
import { listed, UsageError } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest } from "./record.ts";

export class NoteCommand extends RecordCommand {
  readonly name = "note";
  readonly summary = "Add a note or a decision to an issue";
  readonly listing = listed("Work");

  usage(): string {
    return `  tmb note <issue-id> <text> [--decision]
                            Add a note, or with --decision a decision, to an issue
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const { values, positionals } = parseWithJson(args, { decision: { type: "boolean" } });
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
}
