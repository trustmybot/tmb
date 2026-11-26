// A project's own `.gitattributes` wins over Linguist's rules, as it does on GitHub
// (trustmybot/tmb#154): `linguist-language` names a file's language, and `linguist-vendored` and
// `linguist-generated` say whether a file is third-party code or made by a tool. Patterns and
// precedence are git's (gitattributes(5)): a pattern with no slash matches a name at any depth below
// its file's folder, one with a slash matches the path from that folder; a deeper file wins over a
// shallower one, and a later line over an earlier one. A pattern never matches the files inside a
// folder it names, so `dir/` matches nothing and `dir/**` matches all of it.

/** The Linguist attributes tmb reads (Linguist's LazyBlob::GIT_ATTR). */
export const LINGUIST_ATTRIBUTES = ["linguist-language", "linguist-vendored", "linguist-generated"] as const;
export type LinguistAttribute = (typeof LINGUIST_ATTRIBUTES)[number];

/** An attribute's state for a path: set (true), unset (false), a value, or absent when unspecified. */
export type AttributeValue = true | false | string;
export type Attributes = Partial<Record<LinguistAttribute, AttributeValue>>;

/** The name of the files git reads attributes from. */
export const GITATTRIBUTES = ".gitattributes";

type Line = { dir: string; match: RegExp; attributes: [LinguistAttribute, AttributeValue | null][] };

/** A glob of gitattributes as a pattern over the path relative to the file's folder. */
function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes("/");
  const body = glob.replace(/^\//, "");
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "*" && body[i + 1] === "*") {
      const before = i === 0 || body[i - 1] === "/";
      const after = body[i + 2] === "/" || i + 2 === body.length;
      if (before && after) {
        // `**/` is any number of folders, `/**` everything inside.
        if (body[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
        continue;
      }
      out += "[^/]*";
      i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const close = body.indexOf("]", i + 2);
      if (close < 0) out += "\\[";
      else {
        out += `[${body.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else if (c === "\\" && i + 1 < body.length) out += `\\${body[++i]}`;
    else out += /[.+^${}()|\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(anchored ? `^${out}$` : `(?:^|/)${out}$`);
}

/** The lines of one `.gitattributes` file at `dir` ("" for the repo's root) that set a Linguist attribute. */
export function parseGitattributes(dir: string, text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // A blank line, a comment, and a macro's definition set no file's attributes.
    if (line === "" || line.startsWith("#") || line.startsWith("[attr]")) continue;
    const [pattern, ...words] = line.split(/\s+/);
    // A negative pattern is forbidden in gitattributes; git ignores the line.
    if (!pattern || pattern.startsWith("!")) continue;
    const attributes: [LinguistAttribute, AttributeValue | null][] = [];
    for (const word of words) {
      const [, prefix = "", name = "", value] = /^([-!]?)([^=]+)(?:=(.*))?$/.exec(word) ?? [];
      if (!(LINGUIST_ATTRIBUTES as readonly string[]).includes(name)) continue;
      attributes.push([name as LinguistAttribute, prefix === "-" ? false : prefix === "!" ? null : value ?? true]);
    }
    if (attributes.length > 0 && !pattern.endsWith("/")) lines.push({ dir, match: globToRegExp(pattern), attributes });
  }
  return lines;
}

/** The Linguist attributes of each path, from every `.gitattributes` file of a tree. */
export class GitAttributes {
  private readonly lines: Line[];

  /** `files` maps each `.gitattributes` file's path to its text. */
  constructor(files: ReadonlyMap<string, string>) {
    const parsed = [...files].map(([path, text]) => {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      return { depth: dir === "" ? 0 : dir.split("/").length, lines: parseGitattributes(dir, text) };
    });
    // Shallower files first, so a deeper file's line, read later, wins.
    this.lines = parsed.sort((a, b) => a.depth - b.depth).flatMap((p) => p.lines);
  }

  /** Whether any file sets a Linguist attribute. */
  get empty(): boolean {
    return this.lines.length === 0;
  }

  /** The Linguist attributes of a path; an attribute no line names is absent. */
  of(relPath: string): Attributes {
    const out: Attributes = {};
    for (const line of this.lines) {
      if (line.dir !== "" && !relPath.startsWith(`${line.dir}/`)) continue;
      const rel = line.dir === "" ? relPath : relPath.slice(line.dir.length + 1);
      if (!line.match.test(rel)) continue;
      for (const [name, value] of line.attributes) {
        if (value === null) delete out[name];
        else out[name] = value;
      }
    }
    return out;
  }
}

/** A boolean attribute's meaning, as Linguist's boolean_attribute: anything but unset or `false` is true; null when unspecified. */
export function attributeFlag(value: AttributeValue | undefined): boolean | null {
  if (value === undefined) return null;
  return value !== false && value !== "false";
}

/** No `.gitattributes` file. */
export const NO_ATTRIBUTES = new GitAttributes(new Map());
