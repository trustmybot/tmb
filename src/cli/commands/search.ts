// `tmb search`: search issues, notes and decisions.
import type { SearchHit } from "../../engine/index.ts";
import { parseWithJson, words } from "../arguments.ts";
import { listed } from "../command.ts";
import { JSON_NOTE, RecordCommand, type RecordRequest } from "./record.ts";

export class SearchCommand extends RecordCommand {
  readonly name = "search";
  readonly summary = "Search issues, notes and decisions";
  readonly listing = listed("Work");

  usage(): string {
    return `  tmb search <query>        Search issues, notes and decisions
${JSON_NOTE}`;
  }

  protected parse(args: readonly string[]): RecordRequest {
    const { values, positionals } = parseWithJson(args, {});
    return { operation: "search", input: { query: words(positionals, "search query") }, json: values.json === true, format: formatHits };
  }
}

function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No matches.";
  return hits.map((hit) => `${hit.issueId}  ${hit.state.padEnd(6)}  ${hit.title}\n  ${hit.kind === "issue" ? "" : `${hit.kind} ${hit.id}: `}${hit.snippet}`).join("\n");
}
