// What every command of the command line is: a name, its help, its argument parsing and its run.
// The command table lists them; the entry and the help both read that table.
import type { Actor } from "../engine/index.ts";
import { asksHelp } from "./help.ts";

/** The short help's groups, most used first. */
export const GROUP_HEADINGS = ["Project", "Work", "Code", "Program"] as const;
export type GroupHeading = (typeof GROUP_HEADINGS)[number];

/** The heading `tmb help --all` lists the hidden commands under. */
export const HIDDEN_HEADING = "Called by a host or git";

/** Where the help lists a command: under a group, or only with `--all` when only a host or git calls it. */
export type Listing = { readonly kind: "listed"; readonly group: GroupHeading } | { readonly kind: "hidden" };

export const listed = (group: GroupHeading): Listing => ({ kind: "listed", group });
export const HIDDEN: Listing = { kind: "hidden" };

/** The actor every command acts as: the Human at the command line. */
export const HUMAN: Actor = { kind: "human" };

/** Where a command writes; `colour` says whether what goes to `err` may be coloured. */
export type Output = { readonly out: (text: string) => void; readonly err: (text: string) => void; readonly colour?: boolean };

export interface Command {
  readonly name: string;
  /** The short help's line. */
  readonly summary: string;
  readonly listing: Listing;
  /** The actions it takes, in the order its help lists them; a typo of one is told the closest. */
  readonly actions?: readonly string[];
  /** False when a call always runs in this build, never in the build a running session pinned the project to. */
  readonly handsOver: boolean;
  /** The project a call names itself, such as the tool server's `--project`; null or absent when it works in the one holding its folder. */
  projectOf?(args: readonly string[]): string | null;
  /** Its detail, as `tmb help <command>` shows it; each entry's head is written `tmb <command>`. */
  usage(): string;
  /** Whether `args` ask for its detail rather than a run. */
  asksHelp(args: readonly string[]): boolean;
  /** Runs it; resolves to the exit code. */
  run(args: readonly string[]): Promise<number>;
}

/** A command that parses its arguments into its options, then runs with them. */
export abstract class ParsedCommand<Options> implements Command {
  abstract readonly name: string;
  abstract readonly summary: string;
  abstract readonly listing: Listing;
  readonly actions?: readonly string[];
  readonly handsOver: boolean = true;

  abstract usage(): string;

  asksHelp(args: readonly string[]): boolean {
    return asksHelp([...args]);
  }

  async run(args: readonly string[]): Promise<number> {
    return this.execute(this.parse(args));
  }

  protected abstract parse(args: readonly string[]): Options;
  protected abstract execute(options: Options): Promise<number> | number;

  /** The error for a missing or unknown action. */
  protected actionError(action: string | undefined): UsageError {
    if (action !== undefined) return new UnknownActionError(action);
    const actions = this.actions ?? [];
    return new UsageError(`${this.name} needs an action: ${actions.slice(0, -1).join(", ")} or ${actions.at(-1)}`);
  }
}

/** A call the command does not take: written as a usage error, with exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** An action the command does not have, such as `tmb task clsoe`. */
export class UnknownActionError extends UsageError {
  override name = "UnknownActionError";
  constructor(readonly action: string) {
    super(`unrecognized command '${action}'`);
  }
}
