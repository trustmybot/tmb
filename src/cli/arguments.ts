// Reading a command's arguments: its options, its words, and the errors a misspelt call gives.
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { UsageError } from "./command.ts";

/** Parses `args` with `options` and `--json`; a flag or argument the command does not take is a usage error. */
export function parseWithJson<const O extends ParseArgsOptionsConfig>(args: readonly string[], options: O) {
  try {
    return parseArgs({ args: [...args], options: { ...options, json: { type: "boolean" as const } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** The positionals as one text; a usage error when there is none. */
export function words(positionals: readonly string[], what: string): string {
  const text = positionals.join(" ");
  if (text.trim() === "") throw new UsageError(`missing ${what}`);
  return text;
}

/** The one positional; a usage error when there are more or none. */
export function only(positionals: readonly string[], what: string): string {
  if (positionals.length !== 1) throw new UsageError(`expected one ${what}, got ${positionals.length}`);
  return positionals[0]!;
}

/** Throws when a command that takes no arguments was given some. */
export function noArguments(command: string, positionals: readonly string[]): void {
  if (positionals.length > 0) throw new Error(`${command} takes no arguments, got ${positionals.join(" ")}`);
}

/** The value given to a long option in `argv`, as `--repo api` or `--repo=api`; null when it is not given. */
export function optionValue(argv: readonly string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] ?? null;
    if (argv[i]!.startsWith(`${name}=`)) return argv[i]!.slice(name.length + 1);
  }
  return null;
}

/** An error node:util's parseArgs throws for a flag or argument a command does not take. */
export function isParseArgsError(error: unknown): error is Error {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}
