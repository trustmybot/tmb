// `tmb history`: every recorded change to an issue or note.
import type { StoredEvent } from "../../engine/index.ts";
import { only, parseWithJson } from "../arguments.ts";
import { listed } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest, who } from "./record.ts";

export class HistoryCommand extends RecordCommand {
  readonly name = "history";
  readonly summary = "Show every change to an issue or note";
  readonly listing = listed("Work");

  usage(): string {
    return `  tmb history <id>          Show every recorded change to an issue or note
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const { values, positionals } = parseWithJson(args, {});
    return { operation: "history", input: { id: only(positionals, "record id") }, json: values.json === true, format: formatHistory };
  }
}

function formatHistory(events: StoredEvent[]): string {
  return events.map((event) => `${event.at}  ${event.recordKind} ${event.type} by ${who(event.actor)}  ${JSON.stringify(event.data)}`).join("\n");
}
