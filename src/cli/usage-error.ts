// How a usage error is written: the closest actions on a typo, else the error and where to read more.
import { runningName } from "../engine/index.ts";
import { type Command, type Output, UnknownActionError } from "./command.ts";
import { Paint, unknownCommandText, usageErrorText } from "./help.ts";

/** Writes a usage error of `tmb <command>` (with exit code 2 for the caller to return). */
export function writeUsageError(command: Pick<Command, "name" | "actions">, error: Error, output: Output): void {
  const paint = new Paint(output.colour === true);
  const program = `${runningName()} ${command.name}`;
  const text = error instanceof UnknownActionError ? unknownCommandText(program, error.action, command.actions ?? [], paint) : usageErrorText(program, error.message, paint);
  output.err(text.trimEnd());
}
