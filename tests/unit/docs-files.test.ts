// Unit: a docs task may change only the prose, data and image types on tmb's fixed list, and the
// list in the reference is the one the engine uses (trustmybot/tmb#185).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DOCS_EXTENSIONS, DOCS_FILENAMES, isDocsFile } from "../../src/engine/docs-files.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

describe("the docs task's file types", () => {
  test("allows prose, data and images, by last extension and without regard to case", () => {
    for (const file of ["docs/guide.md", "README.MD", "notes.txt", "a.rst", "b.adoc", "c.json", "d.yaml", "e.yml", "f.toml", "g.csv", "h.tsv"]) {
      expect(isDocsFile(file)).toBe(true);
    }
    for (const file of ["img/a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "flow.svg", "archive.tar.json"]) expect(isDocsFile(file)).toBe(true);
  });

  test("allows the listed files that carry no extension, in any case, in any folder", () => {
    for (const file of ["LICENSE", "sub/License", "NOTICE", "AUTHORS", "CHANGELOG", "README", "COPYING"]) expect(isDocsFile(file)).toBe(true);
  });

  test("refuses code, markup and query files, and any type the list does not name", () => {
    for (const file of ["src/a.ts", "App.vue", "Card.svelte", "index.html", "q.sql", "Makefile", "build.gradle", "a.mdx", "x.zzunknown", "NOTES"]) {
      expect(isDocsFile(file)).toBe(false);
    }
    // A leading dot starts a hidden file's name, not an extension.
    expect(isDocsFile(".md")).toBe(false);
    expect(isDocsFile("guide.md.ts")).toBe(false);
  });

  test("the reference lists exactly the engine's types", () => {
    const reference = readFileSync(path.join(import.meta.dir, "..", "..", "docs", "reference", "README.md"), "utf8");
    const section = reference.slice(reference.indexOf("### What a docs task may change"), reference.indexOf("## Move a plugin project"));
    const rows = section.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Kind"));
    const listed = rows.flatMap((row) => [...row.split("|")[2]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
    expect(listed.toSorted()).toEqual([...DOCS_EXTENSIONS, ...DOCS_FILENAMES].toSorted());
  });
});
