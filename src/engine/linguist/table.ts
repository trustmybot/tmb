// GitHub Linguist's language list and its rules for telling languages apart, read from Linguist's
// own data files (trustmybot/tmb#154): tmb keeps no language list of its own. Each rule here is
// Linguist's, as its Ruby applies it (lib/linguist/strategy/*.rb, shebang.rb, heuristics.rb at the
// release in data/RELEASE.json). tmb runs no Ruby and leaves out Linguist's last step, a statistical
// guess from the file's text: a file those rules cannot settle stays "one of these".

/** One language of Linguist's list, by the fields tmb reads. */
export type LinguistLanguage = {
  name: string;
  /** Linguist's type: programming, data, markup or prose. */
  type: string;
  extensions: string[];
  filenames: string[];
  interpreters: string[];
  /** The names a `.gitattributes` file may give it by: Linguist's default alias, its name in lower case with `-` for each space, and its listed aliases. */
  aliases: string[];
};

/** A heuristic's test of a file's text; null when its pattern is not one JavaScript can evaluate as Ruby does. */
type Test = ((text: string) => boolean) | null;

type Rule = { languages: string[]; test: Test };

type Disambiguation = { extensions: string[]; rules: Rule[] };

/** Linguist reads at most this much of a file's text for its heuristics (heuristics.rb, HEURISTICS_CONSIDER_BYTES). */
export const HEURISTICS_CONSIDER = 50 * 1024;

/** The text of Linguist's data files that tmb reads. */
export type LinguistTexts = { languages: string; heuristics: string; generic: string };

/** What a file's name and text tell of its language, by Linguist's rules. */
export type Detection = {
  /** The languages left, in Linguist's list order: one when the rules settle it, several when they cannot, none when the list knows the file by none. */
  languages: string[];
};

class DataError extends Error {}

function fail(file: string, why: string): never {
  throw new DataError(`Linguist's ${file} could not be read: ${why}`);
}

function parseYaml(file: string, text: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch (error) {
    fail(file, error instanceof Error ? error.message : String(error));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function strings(file: string, where: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(file, `${where} is not a list of names`);
  return value as string[];
}

// Ruby syntax that a JavaScript pattern would read with another meaning and no error: a POSIX
// bracket class (`[[:alpha:]]`), a class intersection (`[a&&[^b]]`), and an inline `m` flag, which in
// Ruby lets `.` match a line break and in JavaScript makes `^` and `$` match at lines.
const RUBY_ONLY: readonly RegExp[] = [/\[:\^?[a-z]+:\]/, /&&/, /\(\?[a-z]*m[a-z]*(?:-[a-z]*)?[:)]/, /\(\?[a-z]*-[a-z]*m[a-z]*[:)]/];

/**
 * Ruby's escapes JavaScript lacks, as the JavaScript that means the same (Onigmo's syntax): `\A` the
 * text's start, `\z` its end, `\Z` its end or before a last line break, `\h` a hexadecimal digit.
 */
const RUBY_ESCAPES: Readonly<Record<string, string>> = {
  A: "(?<![\\s\\S])",
  z: "(?![\\s\\S])",
  Z: "(?=\\n?(?![\\s\\S]))",
  h: "[0-9a-fA-F]",
};

/** A Ruby pattern with RUBY_ESCAPES written as JavaScript; `\h` inside a class is its digits. */
function translate(source: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\" && i + 1 < source.length) {
      const next = source[++i]!;
      const js = RUBY_ESCAPES[next];
      if (js === undefined) out += c + next;
      else if (!inClass) out += js;
      else out += next === "h" ? "0-9a-fA-F" : c + next;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return out;
}

/**
 * A Ruby pattern as JavaScript evaluates it the same way, or null. Ruby's `^` and `$` are always a
 * line's start and end, so the pattern is multiline; the `u` flag makes any other escape JavaScript
 * does not know an error rather than a plain letter, so it is refused, not misread.
 */
function compile(source: string): RegExp | null {
  if (RUBY_ONLY.some((ruby) => ruby.test(source))) return null;
  try {
    return new RegExp(translate(source), "mu");
  } catch {
    return null;
  }
}

/** A pattern or a list of them, which Linguist joins into one (Regexp.union): any of them matches. */
function patternTest(file: string, value: unknown): Test {
  const sources = typeof value === "string" ? [value] : strings(file, "a pattern", value);
  const compiled = sources.map(compile);
  if (compiled.some((re) => re === null)) return null;
  return (text) => compiled.some((re) => re!.test(text));
}

function ruleTest(file: string, rule: Record<string, unknown>, named: Map<string, Test>): Test {
  if (rule.and !== undefined) {
    if (!Array.isArray(rule.and)) fail(file, "an `and` rule is not a list");
    const parts = rule.and.map((part) => (isRecord(part) ? ruleTest(file, part, named) : fail(file, "an `and` rule's part is not a rule")));
    if (parts.some((part) => part === null)) return null;
    return (text) => parts.every((part) => part!(text));
  }
  if (rule.pattern !== undefined) return patternTest(file, rule.pattern);
  if (rule.negative_pattern !== undefined) {
    const test = patternTest(file, rule.negative_pattern);
    return test === null ? null : (text) => !test(text);
  }
  if (rule.named_pattern !== undefined) {
    if (typeof rule.named_pattern !== "string" || !named.has(rule.named_pattern)) fail(file, `named pattern ${String(rule.named_pattern)} is not defined`);
    return named.get(rule.named_pattern)!;
  }
  return () => true;
}

/** The first line's interpreter, as Linguist's Shebang.interpreter reads it; null when there is none. */
export function interpreterOf(text: string): string | null {
  if (!text.startsWith("#!")) return null;
  const lineEnd = text.indexOf("\n");
  const line = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const path = /^#!\s*\S+/.exec(line);
  if (!path) return null;
  let rest = line.slice(path[0].length);
  let script: string | undefined = path[0].split("/").pop();
  if (script === "env") {
    rest = rest.replace(/^\s+/, "");
    // Skip env's options, such as -vS, and its variable assignments, such as foo=bar.
    for (let skipped = /^(?:((-[i0uCSv]*|--\S+)\s+)+|(\S+=\S+\s+)+)/.exec(rest); skipped; skipped = /^(?:((-[i0uCSv]*|--\S+)\s+)+|(\S+=\S+\s+)+)/.exec(rest)) {
      rest = rest.slice(skipped[0].length);
    }
    script = /^\S+/.exec(rest)?.[0];
    if (script !== undefined) rest = rest.slice(script.length);
  }
  if (!script) return null;
  // "python2.6" is "python2".
  script = script.replace(/(\.\d+)$/, "").replace(/^#!\s*/, "");
  // A shell script whose first lines `exec` another interpreter on itself is in that one.
  if (script === "sh") {
    for (const l of text.split("\n").slice(0, 5)) {
      const exec = /exec (\w+)[\s"']+\$0[\s"']+\$@/.exec(l);
      if (exec) {
        script = exec[1]!;
        break;
      }
    }
  }
  // osascript names its language with -l; with it, the interpreter is not known.
  if (script === "osascript" && /-l\s?/.test(rest)) return null;
  return script.split("/").pop() ?? null;
}

/** A file's base name and its extensions, longest first, as Linguist's BlobHelper#extensions: `a.d.ts` gives `.d.ts` and `.ts`; `.bashrc` gives `.bashrc`. */
export function extensionsOf(base: string): string[] {
  const [, ...segments] = base.toLowerCase().split(".");
  return segments.map((_, at) => `.${segments.slice(at).join(".")}`);
}

/** Of `found`, those in `candidates` when there are candidates (Linguist's `candidates & languages`). */
function narrow(candidates: string[], found: readonly string[]): string[] {
  return candidates.length > 0 ? candidates.filter((name) => found.includes(name)) : [...found];
}

export class Linguist {
  readonly languages: ReadonlyMap<string, LinguistLanguage>;
  private readonly byFilename = new Map<string, string[]>();
  private readonly byExtension = new Map<string, string[]>();
  private readonly byInterpreter = new Map<string, string[]>();
  private readonly byAlias = new Map<string, string>();
  private readonly order = new Map<string, number>();
  private readonly generic: string[];
  private readonly disambiguations: Disambiguation[];

  /** Reads Linguist's data files; throws when one cannot be read, so a build without them fails. */
  constructor(texts: LinguistTexts) {
    const table = parseYaml("languages.yml", texts.languages);
    if (!isRecord(table) || Object.keys(table).length === 0) fail("languages.yml", "it holds no languages");
    const languages = new Map<string, LinguistLanguage>();
    for (const [name, value] of Object.entries(table)) {
      if (!isRecord(value) || typeof value.type !== "string") fail("languages.yml", `${name} has no type`);
      const language: LinguistLanguage = {
        name,
        type: value.type,
        extensions: strings("languages.yml", `${name}'s extensions`, value.extensions),
        filenames: strings("languages.yml", `${name}'s filenames`, value.filenames),
        interpreters: strings("languages.yml", `${name}'s interpreters`, value.interpreters),
        aliases: [name.toLowerCase().replace(/\s/g, "-"), ...strings("languages.yml", `${name}'s aliases`, value.aliases)],
      };
      languages.set(name, language);
      this.order.set(name, this.order.size);
      for (const filename of language.filenames) this.byFilename.set(filename, [...(this.byFilename.get(filename) ?? []), name]);
      for (const extension of language.extensions) {
        const key = extension.toLowerCase();
        if (!(this.byExtension.get(key) ?? []).includes(name)) this.byExtension.set(key, [...(this.byExtension.get(key) ?? []), name]);
      }
      for (const interpreter of language.interpreters) this.byInterpreter.set(interpreter, [...(this.byInterpreter.get(interpreter) ?? []), name]);
      for (const alias of language.aliases) this.byAlias.set(alias.toLowerCase(), name);
    }
    this.languages = languages;

    const generic = parseYaml("generic.yml", texts.generic);
    if (!isRecord(generic)) fail("generic.yml", "it holds no extensions");
    this.generic = strings("generic.yml", "extensions", generic.extensions).map((e) => e.toLowerCase());

    const heuristics = parseYaml("heuristics.yml", texts.heuristics);
    if (!isRecord(heuristics) || !Array.isArray(heuristics.disambiguations)) fail("heuristics.yml", "it holds no disambiguations");
    const named = new Map<string, Test>();
    for (const [name, value] of Object.entries(isRecord(heuristics.named_patterns) ? heuristics.named_patterns : {})) named.set(name, patternTest("heuristics.yml", value));
    this.disambiguations = heuristics.disambiguations.map((entry: unknown) => {
      if (!isRecord(entry) || !Array.isArray(entry.rules)) fail("heuristics.yml", "a disambiguation has no rules");
      return {
        extensions: strings("heuristics.yml", "a disambiguation's extensions", entry.extensions).map((e) => e.toLowerCase()),
        rules: entry.rules.map((rule: unknown) => {
          if (!isRecord(rule)) fail("heuristics.yml", "a rule is not a rule");
          const names = typeof rule.language === "string" ? [rule.language] : strings("heuristics.yml", "a rule's language", rule.language);
          return { languages: names, test: ruleTest("heuristics.yml", rule, named) };
        }),
      };
    });
  }

  /** The language a `.gitattributes` `linguist-language` value names, by its alias, as Linguist's Language.find_by_alias; null when none. */
  byAliasName(value: string): string | null {
    return this.byAlias.get(value.toLowerCase()) ?? this.byAlias.get(value.split(",")[0]!.toLowerCase()) ?? null;
  }

  /** Language names in Linguist's list order. */
  private sorted(names: Iterable<string>): string[] {
    return [...new Set(names)].sort((a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0));
  }

  /**
   * The languages of a file by Linguist's strategies, in Linguist's order, each narrowing the
   * languages the one before left, and the first that leaves one deciding: its file name, the
   * interpreter its first line names, its extension (unless Linguist counts the extension too common
   * to tell), then the heuristics for its extension. `text` is asked for only when its name leaves
   * other than one language; with no text the name alone answers.
   */
  detect(relPath: string, text: (() => string) | null): Detection {
    const base = relPath.split(/[\\/]/).pop() ?? "";
    const lower = base.toLowerCase();
    let left: string[] = [];
    const strategies: ((candidates: string[]) => string[])[] = [
      (candidates) => narrow(candidates, this.byFilename.get(base) ?? []),
      (candidates) => {
        const interpreter = text === null ? null : interpreterOf(text());
        return interpreter === null ? [] : narrow(candidates, this.byInterpreter.get(interpreter) ?? []);
      },
      (candidates) => {
        if (this.generic.some((extension) => lower.endsWith(extension))) return candidates;
        const extension = extensionsOf(base).find((e) => this.byExtension.has(e));
        return narrow(candidates, extension === undefined ? [] : this.byExtension.get(extension)!);
      },
      () => (text === null ? [] : this.heuristic(lower, text)),
    ];
    for (const strategy of strategies) {
      const found = strategy(left);
      if (found.length === 1) return { languages: found };
      if (found.length > 1) left = this.sorted(found);
    }
    return { languages: left };
  }

  /**
   * The answer of the first disambiguation for the file's extension: the languages of its first rule
   * that matches. A rule whose pattern JavaScript cannot evaluate as Ruby does stops the search with
   * no answer, so a later rule is never taken in its place.
   */
  private heuristic(lowerName: string, text: () => string): string[] {
    const entry = this.disambiguations.find((d) => d.extensions.some((extension) => lowerName.endsWith(extension)));
    if (!entry) return [];
    const head = text().slice(0, HEURISTICS_CONSIDER);
    for (const rule of entry.rules) {
      if (rule.test === null) return [];
      if (rule.test(head)) return rule.languages.filter((name) => this.languages.has(name));
    }
    return [];
  }
}
