// A small reader of shell commands for the guards on a command an agent is about to run. It
// splits a command into statements and words, so a rule can find `git push` or `gh pr create`.
// It is a guide, not the gate: it cannot see through every trick a shell allows, which is why
// git's own pre-push hook holds the push whatever was typed. Where it cannot read a git or gh
// command, the rules deny rather than guess.

/** One simple command: its words with quotes removed, and whether a word holds an expansion. */
export type Statement = { words: string[]; expanded: boolean[] };

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")"]);

/**
 * Splits a command line into statements at `;`, `&`, `&&`, `|`, `||`, newlines and parentheses,
 * and each statement into words. Quotes are removed; a word holding `$` or a backquote outside
 * single quotes is marked expanded, its text kept as written.
 */
export function statements(command: string): Statement[] {
  const result: Statement[] = [];
  let words: string[] = [];
  let expanded: boolean[] = [];
  let word = "";
  let inWord = false;
  let wordExpanded = false;
  const endWord = () => {
    if (inWord) {
      words.push(word);
      expanded.push(wordExpanded);
    }
    word = "";
    inWord = false;
    wordExpanded = false;
  };
  const endStatement = () => {
    endWord();
    if (words.length > 0) result.push({ words, expanded });
    words = [];
    expanded = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") {
        word += command[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === "\\" && i + 1 < command.length) word += command[++i];
        else {
          if (command[i] === "$" || command[i] === "`") wordExpanded = true;
          word += command[i];
        }
      }
    } else if (c === "$" && command[i + 1] === "(") {
      // A command substitution is kept whole inside its word; its own commands are read as statements too.
      let depth = 0;
      const start = i;
      for (; i < command.length; i++) {
        if (command[i] === "(") depth++;
        else if (command[i] === ")" && --depth === 0) break;
      }
      word += command.slice(start, i + 1);
      inWord = true;
      wordExpanded = true;
      result.push(...statements(command.slice(start + 2, i)));
    } else if (c === "`") {
      const end = command.indexOf("`", i + 1);
      const stop = end === -1 ? command.length : end;
      result.push(...statements(command.slice(i + 1, stop)));
      word += command.slice(i, stop + 1);
      inWord = true;
      wordExpanded = true;
      i = stop;
    } else if (c === "$") {
      word += c;
      inWord = true;
      wordExpanded = true;
    } else if (SEPARATORS.has(c)) {
      endStatement();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (c === "#" && !inWord) {
      const end = command.indexOf("\n", i);
      i = end === -1 ? command.length : end - 1;
    } else {
      word += c;
      inWord = true;
    }
  }
  endStatement();
  return result;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that run the command after them. */
const PREFIXES = new Set(["command", "exec", "nohup", "time", "env", "sudo", "xargs", "builtin", "then", "do", "else", "if", "while", "until", "!", "{"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** A statement's command and its arguments, past assignments and prefixes such as `env` or `sudo`; null when it runs nothing. */
function commandOf(statement: Statement): { name: string; nameExpanded: boolean; args: string[]; argsExpanded: boolean[] } | null {
  let i = 0;
  while (i < statement.words.length) {
    const w = statement.words[i]!;
    if (ASSIGNMENT.test(w) || PREFIXES.has(w) || (i > 0 && PREFIXES.has(statement.words[i - 1]!) && w.startsWith("-"))) i++;
    else break;
  }
  if (i >= statement.words.length) return null;
  const name = statement.words[i]!;
  return { name: name.split("/").at(-1)!, nameExpanded: statement.expanded[i]!, args: statement.words.slice(i + 1), argsExpanded: statement.expanded.slice(i + 1) };
}

/** git's global options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);

export type ToolCall = {
  tool: "git" | "gh";
  /** The subcommand, and for gh the one after it too, such as `pr create`; null when it is not literal text. */
  subcommand: string | null;
  args: string[];
  /** `-c` and `--config-env` values git was given. */
  config: string[];
};

/** The git and gh commands in a command line, found in every statement and in `sh -c` and `eval` strings. */
export function toolCalls(command: string, depth = 0): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const statement of statements(command)) {
    const found = commandOf(statement);
    if (found === null) continue;
    const { name, args, argsExpanded } = found;
    if (depth < 4 && (name === "eval" || (SHELLS.has(name) && args.includes("-c")))) {
      const script = name === "eval" ? args.join(" ") : args[args.indexOf("-c") + 1];
      if (script !== undefined) calls.push(...toolCalls(script, depth + 1));
      continue;
    }
    if (name === "git") {
      const config: string[] = [];
      let i = 0;
      while (i < args.length && args[i]!.startsWith("-")) {
        const option = args[i]!;
        if (GIT_VALUE_OPTIONS.has(option)) {
          if (option === "-c" || option === "--config-env") config.push(args[i + 1] ?? "");
          i += 2;
        } else {
          if (option.startsWith("--config-env=")) config.push(option.slice("--config-env=".length));
          i++;
        }
      }
      const literal = i < args.length && !argsExpanded[i];
      calls.push({ tool: "git", subcommand: literal ? args[i]! : i < args.length ? null : "", args: args.slice(i + 1), config });
    } else if (name === "gh") {
      const literal = args.length >= 2 && !argsExpanded[0] && !argsExpanded[1];
      calls.push({ tool: "gh", subcommand: literal ? `${args[0]} ${args[1]}` : args.length < 2 ? (args[0] ?? "") : null, args: args.slice(2), config: [] });
    } else if (found.nameExpanded && /\b(git|gh)\b/.test(statement.words.join(" "))) {
      calls.push({ tool: "git", subcommand: null, args, config: [] });
    }
  }
  return calls;
}
