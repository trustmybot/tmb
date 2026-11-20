// Unit: the engine tells a file written in a programming language from prose, markup and data by
// its name alone, with Linguist's language table, and does not refuse a file the table does not know.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { isProgrammingFile, LINGUIST_SOURCE, languageOf } from "../src/engine/linguist/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

describe("Linguist's language table", () => {
  test("names the Linguist commit it came from", () => {
    expect(LINGUIST_SOURCE).toMatch(/^github-linguist\/linguist@[0-9a-f]{40}$/);
  });

  test.each([
    ["src/app.ts", "TypeScript"],
    ["scripts/install.sh", "Shell"],
    ["Dockerfile", "Dockerfile"],
    ["Makefile", "Makefile"],
    ["web/App.tsx", "TSX"],
    ["lib/main.py", "Python"],
    ["src\\win\\main.rs", "Rust"],
  ])("refuses %s, written in %s", (file, language) => {
    expect(languageOf(file)).toMatchObject({ programming: true });
    expect(languageOf(file)!.languages).toContain(language);
    expect(isProgrammingFile(file)).toBe(true);
  });

  test.each([
    ["docs/README.md", "Markdown"],
    ["notes.txt", "Text"],
    ["site/index.html", "HTML"],
    ["site/style.css", "CSS"],
    ["package.json", "JSON"],
    ["config.yml", "YAML"],
    ["Cargo.toml", "TOML"],
    ["schema.sql", "SQL"],
  ])("does not refuse %s, which is %s", (file, language) => {
    expect(languageOf(file)!.languages).toContain(language);
    expect(isProgrammingFile(file)).toBe(false);
  });

  test("an extension several data languages share is still not refused", () => {
    expect(isProgrammingFile("config.yaml")).toBe(false);
  });

  test("a file the table does not know is not refused", () => {
    expect(languageOf("data/blob.zzunknown")).toBeNull();
    expect(isProgrammingFile("data/blob.zzunknown")).toBe(false);
  });

  test("a file name with no extension is matched by its whole name, or not at all", () => {
    expect(isProgrammingFile("GNUmakefile")).toBe(true);
    expect(isProgrammingFile("LICENSE")).toBe(false);
    expect(languageOf("NOTES")).toBeNull();
    expect(isProgrammingFile("NOTES")).toBe(false);
  });

  test("a leading dot is a name, not an extension", () => {
    expect(isProgrammingFile(".bashrc")).toBe(true);
    expect(languageOf(".zzunknown")).toBeNull();
  });

  test("an extension is matched without regard to case, longest first", () => {
    expect(isProgrammingFile("src/APP.TS")).toBe(true);
    expect(languageOf("types/index.d.ts")).toMatchObject({ programming: true });
  });

  test("an extension the table cannot settle without the file's content is not refused", () => {
    // .md is Markdown and GCC Machine Description; .sql is SQL and several programming dialects.
    expect(languageOf("guide.md")!.languages).toEqual(expect.arrayContaining(["Markdown", "GCC Machine Description"]));
    expect(isProgrammingFile("guide.md")).toBe(false);
    expect(isProgrammingFile("query.sql")).toBe(false);
    // .ts is also listed by XML, but it is TypeScript's own first extension, not XML's.
    expect(languageOf("app.ts")!.languages).toEqual(["TypeScript"]);
  });
});
