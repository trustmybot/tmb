// The record commands: the Human's way into the record. Each one parses its call into one
// operation, the same an agent's tool call runs, and runs it as the Human.
import { type Actor, HandlerError, type OperationName, OPERATIONS, openProjectStore, projectRootOf, runningName, type Store } from "../../engine/index.ts";
import { HUMAN, ParsedCommand, type Output } from "../command.ts";

/** A parsed record call: the operation, its input, and how its result is printed. */
export type RecordRequest = {
  readonly operation: OperationName;
  readonly input: Record<string, unknown>;
  readonly json: boolean;
  readonly format: (result: never) => string;
};

/** The help's note that every record command takes `--json`. */
export const JSON_NOTE = "  Add --json for JSON output.";

/** What a record command works with: where it writes, and the folder it was typed in. */
export type RecordContext = { readonly output: Output; cwd(): string };

export abstract class RecordCommand extends ParsedCommand<RecordRequest> {
  constructor(protected readonly context: RecordContext) {
    super();
  }

  /**
   * Runs the request in the project holding the folder the command was typed in, which may be
   * below the project folder, such as one repo of a workspace.
   */
  protected async execute(request: RecordRequest): Promise<number> {
    const cwd = this.context.cwd();
    const projectDir = projectRootOf(cwd);
    const { output } = this.context;
    const opened = openProjectStore(projectDir, { create: false });
    if (!opened.ok) {
      output.err(cannotOpenLine(projectDir, opened.error));
      return 1;
    }
    try {
      const input = this.inputIn(opened.store, projectDir, cwd, request.input);
      const result = await OPERATIONS[request.operation].run(opened.store, HUMAN, input, { projectDir });
      output.out(request.json ? JSON.stringify(result, null, 2) : request.format(result as never));
      return 0;
    } catch (error) {
      if (!(error instanceof HandlerError)) throw error;
      // The handlers name the tool's `repo` input; on the command line it is the --repo option.
      output.err(`tmb ${this.name}: ${error.message.replace(/ with repo$/, " with --repo")}`);
      return 1;
    } finally {
      opened.store.close();
    }
  }

  /** The input as the operation gets it, once the record is open; as parsed unless a command adds to it. */
  protected inputIn(_store: Store, _projectDir: string, _cwd: string, input: Record<string, unknown>): Record<string, unknown> {
    return input;
  }
}

/** Why the record cannot be used: none was made here, or it cannot be opened. */
export function cannotOpenLine(projectDir: string, error: { readonly failure: string; readonly message: string }): string {
  return error.failure === "missing" ? `tmb: no tmb record in ${projectDir}; run \`${runningName()} init\` there first.` : `tmb: cannot use the record: ${error.message}`;
}

/** Who an entry names as its author. */
export function who(actor: Actor): string {
  if (actor.kind === "human") return "the Human";
  return actor.kind === "tmb" ? `tmb (${actor.source})` : `${actor.role} on ${actor.host}`;
}

type Review = { verdict: string; commit: string | null; by: Actor; at: string; findings: readonly { blocking: boolean; text: string }[] };

/** A review list's lines, or `(none)`. */
export function reviewLines(reviews: readonly Review[]): string[] {
  if (reviews.length === 0) return ["  (none)"];
  return reviews.flatMap((review) => [
    `  ${review.verdict.padEnd(4)}  at ${(review.commit ?? "?").slice(0, 12)}  by ${who(review.by)}  ${review.at}`,
    ...review.findings.map((finding) => `    ${finding.blocking ? "blocking" : "note"}: ${finding.text}`),
  ]);
}
