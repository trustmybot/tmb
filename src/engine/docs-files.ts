// The file types a docs task may change: a fixed list of prose, data and image types, and the
// few files that carry no extension. Anything else is refused at the docs task's close, so a
// type tmb has not listed counts as code (trustmybot/tmb#185). The same list is in the
// reference, docs/reference/README.md, and a test keeps the two equal.

/** Extensions, lowercase and with their dot. */
export const DOCS_EXTENSIONS: readonly string[] = [
  // Prose
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".adoc",
  // Data
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
];

/** Whole file names with no extension of their own, as a project names them, matched without regard to case. */
export const DOCS_FILENAMES: readonly string[] = ["LICENSE", "NOTICE", "AUTHORS", "CHANGELOG", "README", "COPYING"];

const filenames = new Set(DOCS_FILENAMES.map((name) => name.toLowerCase()));

/** Whether a docs task may change this file: its base name is listed, or its last extension is. */
export function isDocsFile(filePath: string): boolean {
  const base = (filePath.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (filenames.has(base)) return true;
  const dot = base.lastIndexOf(".");
  // A leading dot starts a hidden file's name, not an extension.
  return dot > 0 && DOCS_EXTENSIONS.includes(base.slice(dot));
}
