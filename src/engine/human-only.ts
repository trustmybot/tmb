// The Human's own steps from the command line: the rows of the permission table the Human may
// take that change something (both waivers, setting the review mode, `tmb remove` and `tmb purge`).
// The command line records its caller as the Human, so it runs one only on a terminal, after the
// Human types yes, as an agent's shell has none; and the host's guard reads an agent's shell
// command and denies one, with the reason, on a host that can deny a shell command.
import path from "node:path";
import { type Action, ACTIONS } from "./permissions.ts";
import { runningName } from "./program.ts";

/** One of the Human's own steps, as the command line was asked to run it. */
export type HumanOnlyStep = {
  /** The action in the permission table. */
  action: Action;
  /** The command, as `tmb task waive`; a message names the running program in its place. */
  command: string;
  /** What it does, in a few words: "waive a task's review". */
  what: string;
};

/** The word a person types to go on with a Human-only step. */
export const HUMAN_YES = "yes";

const REVIEW_MODE_FLAG = "--review-mode";

function step(action: Action, command: string): HumanOnlyStep {
  return { action, command, what: ACTIONS[action] };
}

/**
 * The Human-only step `args` asks for, or null. `args` is what follows the program's name, as
 * `["task", "waive", "T-3", "--reason", "x"]`. `tmb update` is not one.
 */
export function humanOnlyStep(args: readonly string[]): HumanOnlyStep | null {
  const [command, action] = args;
  if (command === "feature" && action === "waive") return step("feature.waive", "tmb feature waive");
  if (command === "task" && action === "waive") return step("task.waive", "tmb task waive");
  if (command === "remove") return step("project.remove", "tmb remove");
  if (command === "purge") return step("project.purge", "tmb purge");
  if (command === "onboard" && args.some((arg) => arg === REVIEW_MODE_FLAG || arg.startsWith(`${REVIEW_MODE_FLAG}=`))) {
    return step("settings.review-mode", "tmb onboard --review-mode");
  }
  return null;
}

/** The step's command as a message names it: under the running program's name, as `tmb-dev task waive`. */
function spoken(step: HumanOnlyStep): string {
  return step.command.replace(/^tmb /, `${runningName()} `);
}

/** The refusal of a Human-only step run with no terminal: nothing was done, and the Human runs it in their own terminal. */
export function noTerminalRefusal(step: HumanOnlyStep): string {
  return (
    `${spoken(step)} is a step only the Human may take (to ${step.what}): it runs only on a terminal, where the Human types ${HUMAN_YES}. ` +
    "There is no terminal here, so nothing was done. An agent asks the Human to run it in their own terminal."
  );
}

/**
 * The refusal of an unattended run with no terminal that would change a review mode already set
 * (trustmybot/tmb#223): unattended mode only sets one where none is set, as for a fresh project in CI.
 */
export function unattendedChangeRefusal(mode: string): string {
  return (
    `the review mode is already ${mode}, and unattended mode only sets one where none is set, so nothing was done. ` +
    `Changing it is a step only the Human may take: it runs only on a terminal, where the Human types ${HUMAN_YES}.`
  );
}

/** The question a Human-only step asks on a terminal before it runs. */
export function humanYesQuestion(step: HumanOnlyStep, args: readonly string[], folder?: string): string {
  const where = folder === undefined ? "" : ` Project folder: ${folder}.${step.action === "project.purge" ? ` Its record there cannot be recovered.` : ""}`;
  return `Only the Human may ${step.what}.${where} Type ${HUMAN_YES} to run ${runningName()} ${args.join(" ")}: `;
}

/** The refusal of a Human-only step whose question was answered with anything but yes. */
export function notConfirmedRefusal(step: HumanOnlyStep): string {
  return `${spoken(step)} needs ${HUMAN_YES} typed on the terminal; nothing was done.`;
}

/** The guard's deny of a Human-only step in an agent's shell command. */
export function shellDenyReason(step: HumanOnlyStep): string {
  return (
    `${spoken(step)} is a step only the Human may take (to ${step.what}), and an agent's shell may not run it. ` +
    "Ask the Human to run it in their own terminal, and say why."
  );
}

// --- reading a shell command ---------------------------------------------------------------

/** A program tmb is installed as: tmb, tmb-rc, tmb-dev or tmb-<version>, with .exe on Windows. */
const TMB_PROGRAM = /^tmb(?:-[0-9A-Za-z.+-]+)?$/;

/** Shells whose `-c` argument is a command of its own, read the same way. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** A word of a shell command, with whether any of it was quoted. */
type Word = { text: string; quoted: boolean };

const ESCAPABLE = /[\s'"\\$`;&|()<>{}*?#~!]/;

const OPERATOR_CHARS = new Set([";", "&", "|", "\n", "(", ")", "`", "{", "}"]);

/** Drops each here-document's body: its lines are data, not commands. */
function withoutHereDocBodies(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  const pending: { delimiter: string; tabs: boolean }[] = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const head = pending[0]!;
      if ((head.tabs ? line.replace(/^\t+/, "") : line) === head.delimiter) pending.shift();
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) pending.push({ delimiter: match[3]!, tabs: match[1] === "-" });
  }
  return kept.join("\n");
}

/** The simple commands of a shell text, each as its words; quotes are taken off, and a quoted word stays one word. */
function simpleCommands(text: string): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let current = "";
  let quoted = false;
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push({ text: current, quoted });
    current = "";
    quoted = false;
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      current += text.slice(i + 1, stop);
      quoted = true;
      inWord = true;
      i = stop;
    } else if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          current += text[j + 1];
          j += 2;
        } else {
          current += text[j];
          j += 1;
        }
      }
      quoted = true;
      inWord = true;
      i = j;
    } else if (char === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1]!)) {
      // A backslash before a letter is kept, as in a Windows path; before a shell character it escapes it.
      if (text[i + 1] !== "\n") current += text[i + 1];
      inWord = true;
      i += 1;
    } else if (char === "$" && text[i + 1] === "(") {
      endCommand();
      i += 1;
    } else if (OPERATOR_CHARS.has(char)) {
      endCommand();
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      current += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

function programName(word: string): string {
  return path.basename(word.replace(/\\/g, "/")).replace(/\.exe$/i, "");
}

function stepInCommand(words: Word[], depth: number): HumanOnlyStep | null {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    // A quoted word holding spaces is text, such as a commit message, and runs nothing.
    if (!(word.quoted && /\s/.test(word.text)) && TMB_PROGRAM.test(programName(word.text))) {
      const step = humanOnlyStep(words.slice(i + 1).map((next) => next.text));
      if (step !== null) return step;
    }
    // `sh -c '<command>'`, `bash -lc '<command>'` and `eval '<command>'` run their text as a command.
    const runsText = (SHELLS.has(programName(word.text)) && /^-[a-z]*c$/.test(words[i + 1]?.text ?? "")) || word.text === "eval";
    if (runsText && depth < 3) {
      const inner = word.text === "eval" ? words.slice(i + 1).map((next) => next.text).join(" ") : (words[i + 2]?.text ?? "");
      const step = humanOnlyInShell(inner, depth + 1);
      if (step !== null) return step;
    }
  }
  return null;
}

/**
 * The Human-only step a shell command runs, or null. It reads the words of each command, so a
 * tmb program run through `env`, `sudo`, a path or `sh -c` is found, and text such as a commit
 * message or a here-document is not. The terminal rule still holds for whatever this misses.
 */
export function humanOnlyInShell(command: string, depth = 0): HumanOnlyStep | null {
  for (const words of simpleCommands(withoutHereDocBodies(command))) {
    const step = stepInCommand(words, depth);
    if (step !== null) return step;
  }
  return null;
}
