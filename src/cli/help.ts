// The command line's help and usage errors: the short grouped help, a command's detail, the
// closest command on a typo, and their colours. No dependency: the runtime's styleText only
// adds the codes; whether to colour is decided here.
import { styleText } from "node:util";
import { runningName } from "../engine/index.ts";

/** The part of a stream the colour rule reads. */
export type ColourStream = { isTTY?: boolean };

/**
 * Whether to colour what goes to `stream`. `NO_COLOR` set and not empty turns colour off and
 * beats `FORCE_COLOR`, as in uv, commander and picocolors; `FORCE_COLOR` turns it on unless it
 * is `0` or `false`; otherwise colour only a terminal whose `TERM` is not `dumb`.
 */
export function colourOn(stream: ColourStream, env: Record<string, string | undefined> = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

type Format = Parameters<typeof styleText>[0];

/** Paints the parts of help and errors, or leaves them plain. */
export class Paint {
  constructor(readonly on: boolean) {}

  private style(format: Format, text: string): string {
    return this.on ? styleText(format, text, { validateStream: false }) : text;
  }

  /** Headings and `Usage:`. */
  heading(text: string): string {
    return this.style(["bold", "green"], text);
  }

  /** Command names. */
  command(text: string): string {
    return this.style(["bold", "cyan"], text);
  }

  /** Placeholders such as `<COMMAND>`. */
  placeholder(text: string): string {
    return this.style("cyan", text);
  }

  error(text: string): string {
    return this.style(["bold", "red"], text);
  }

  tip(text: string): string {
    return this.style("green", text);
  }

  /** Paints every `<placeholder>` in a line. */
  placeholders(line: string): string {
    return line.replace(/<[^<>\s][^<>]*>/g, (match) => this.placeholder(match));
  }
}

/**
 * The fewest typing mistakes that turn `a` into `b`: a letter added, dropped or changed, or two
 * neighbouring letters swapped, each counting one.
 */
export function typingDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Words other tools use for a command, which name it in a tip but never run it: `tmb upgrade`
 * is not a command, and is three typing mistakes from `update`.
 */
export const OTHER_NAMES: Readonly<Record<string, string>> = { upgrade: "update" };

/**
 * The candidates at most two typing mistakes from `typed`, or that start with it, or that
 * `otherNames` gives for it; sorted, none when none is close.
 */
export function similarCommands(typed: string, candidates: readonly string[], otherNames: Readonly<Record<string, string>> = {}): string[] {
  if (typed === "") return [];
  const close = candidates.filter((candidate) => candidate !== typed && (candidate.startsWith(typed) || typingDistance(typed, candidate) <= 2));
  const other = Object.hasOwn(otherNames, typed) ? otherNames[typed]! : undefined;
  if (other !== undefined && candidates.includes(other)) close.push(other);
  return [...new Set(close)].sort();
}

function tipLine(similar: string[], paint: Paint): string | null {
  if (similar.length === 0) return null;
  const quoted = similar.map((name) => `'${paint.command(name)}'`).join(", ");
  return `  ${paint.tip("tip:")} ${similar.length === 1 ? "a similar command exists" : "some similar commands exist"}: ${quoted}`;
}

/**
 * What a typo prints, in uv's layout: the error, the closest commands, one usage line and where
 * to read more. `program` is the command that was given the typo, such as `tmb` or `tmb task`.
 */
export function unknownCommandText(
  program: string,
  typed: string,
  candidates: readonly string[],
  paint: Paint,
  otherNames: Readonly<Record<string, string>> = {},
): string {
  const tip = tipLine(similarCommands(typed, candidates, otherNames), paint);
  return [
    `${paint.error("error:")} unrecognized command '${typed}'`,
    "",
    ...(tip === null ? [] : [tip, ""]),
    `${paint.heading("Usage:")} ${paint.command(program)} ${paint.placeholder("<COMMAND>")}`,
    "",
    `For more information, try '${paint.command(`${program} --help`)}'.`,
    "",
  ].join("\n");
}

/** Any other usage error of `program`: the error and where to read more. */
export function usageErrorText(program: string, message: string, paint: Paint): string {
  return [`${paint.error("error:")} ${message}`, "", `For more information, try '${paint.command(`${program} --help`)}'.`, ""].join("\n");
}

export type HelpCommand = { name: string; summary: string };
export type HelpGroup = { heading: string; commands: HelpCommand[] };

/** The short help: one line per command, under its group's heading. */
export function shortHelpText(groups: HelpGroup[], paint: Paint): string {
  // Names start in column 2 and summaries in column 14, as in uv, unless a name is longer.
  const width = Math.max(12, ...groups.flatMap((group) => group.commands.map((command) => command.name.length + 2)));
  const lines = [`${paint.heading("Usage:")} ${paint.command(runningName())} ${paint.placeholder("<COMMAND>")}`];
  for (const group of groups) {
    lines.push("", paint.heading(`${group.heading}:`));
    for (const command of group.commands) lines.push(`  ${paint.command(command.name)}${" ".repeat(width - command.name.length)}${command.summary}`);
  }
  lines.push("", `Use \`${paint.command(`${runningName()} help`)} ${paint.placeholder("<command>")}\` for details.`, "");
  return lines.join("\n");
}

/** Whether a usage line starts a command's entry, as `  tmb issue show <id>` does. */
function startsEntry(line: string): boolean {
  return line.startsWith("  tmb ");
}

/**
 * The lines of `usage` for one action, such as `tmb task waive`: that action's entries and the
 * notes that hold for every action. All of `usage` when no action is named.
 */
export function actionUsage(usage: string, command: string, action?: string): string {
  if (action === undefined) return usage;
  const head = `  tmb ${command} ${action}`;
  const kept: string[] = [];
  let keeping = false;
  for (const line of usage.split("\n")) {
    if (startsEntry(line)) keeping = line === head || line.startsWith(`${head} `);
    else if (!line.startsWith("   ")) keeping = true; // a note such as "  Add --json ..." holds for every action
    if (keeping) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * A command's detail: `Usage:` and its entries, with command names and placeholders painted. Each
 * entry's head is written `tmb <command>` and shown under the running program's name.
 */
export function detailHelpText(usage: string, paint: Paint): string {
  const lines = usage.split("\n").map((line) => {
    const named = /^( {2})tmb((?: [a-z][a-z-]*)*)(.*)$/.exec(line);
    if (named) return `${named[1]}${paint.command(`${runningName()}${named[2]!}`)}${paint.placeholders(named[3]!)}`;
    return paint.placeholders(line);
  });
  return [paint.heading("Usage:"), ...lines, ""].join("\n");
}

/** Whether `args` ask for help, before any `--` that ends the options. */
export function asksHelp(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}
