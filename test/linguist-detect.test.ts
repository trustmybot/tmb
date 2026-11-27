// A file's language comes from GitHub Linguist's list (trustmybot/tmb#154): Linguist's strategies
// (file name, extension, interpreter, then its heuristics) name it, a project's `.gitattributes`
// wins over them, and the build fails when Linguist's data cannot be read.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileLanguages, languageOf, moduleOfLanguages } from "../src/engine/graph/extract.ts";
import { LANGUAGES } from "../src/engine/graph/languages/registry.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import { GitAttributes } from "../src/engine/linguist/gitattributes.ts";
import { interpreterOf, Linguist, LINGUIST_RELEASE } from "../src/engine/linguist/index.ts";
import { unreadLanguage } from "../src/engine/graph/languages/unread.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const LINGUIST_DIR = path.resolve(import.meta.dir, "../src/engine/linguist");

describe("each language a module reads keeps its files", () => {
  test.each([
    ["web/shop.ts", "export const total = 1;\n", "typescript"],
    ["web/Cart.tsx", "export const Cart = () => <div/>;\n", "tsx"],
    ["web/basket.js", "module.exports = {};\n", "javascript"],
    ["web/basket.mjs", "export default 1;\n", "javascript"],
    ["web/basket.cjs", "module.exports = 1;\n", "javascript"],
    ["web/Row.jsx", "export const Row = () => <tr/>;\n", "javascript"],
    ["tools/sorter.py", "def sort_all():\n    pass\n", "python"],
    ["cmd/meter/main.go", "package main\n", "go"],
    ["src/org/acme/Meter.java", "class Meter {}\n", "java"],
    ["crates/meter/src/lib.rs", "pub fn read() {}\n", "rust"],
    ["native/meter.c", "int read(void) { return 0; }\n", "c"],
    ["native/meter.h", "int read(void);\n", "c"],
    ["native/meter_cxx.h", "namespace meter { class Gauge {}; }\n", "cpp"],
    ["native/gauge.cpp", "int main() {}\n", "cpp"],
    ["native/gauge.hpp", "class Gauge {};\n", "cpp"],
    ["ops/deploy.sh", "echo hi\n", "bash"],
    ["ops/deploy", "#!/usr/bin/env bash\necho hi\n", "bash"],
    ["ops/rotate", "#!/bin/sh\nexit 0\n", "bash"],
    ["perl/report.pl", "use strict;\nprint 1;\n", "perl"],
    ["perl/Report.pm", "package Report;\nuse strict;\n1;\n", "perl"],
    ["db/ledger.sql", "CREATE TABLE ledger (id INTEGER);\n", "sql"],
  ])("%s", (file, text, lang) => {
    expect(languageOf(file, () => text)).toBe(lang);
  });
});

describe("files no module reads get their Linguist language", () => {
  test.each([
    ["idl/meter.thrift", "Thrift"],
    ["idl/meter.proto", "Protocol Buffer"],
    ["config/meter.toml", "TOML"],
    ["api/meter.graphql", "GraphQL"],
  ])("%s is %s", (file, name) => {
    expect(fileLanguages(file, () => "")).toEqual([name]);
    expect(languageOf(file, () => "")).toBeNull();
  });

  test("a header with Objective-C in it is Objective-C, read by no module", () => {
    const text = "@interface Gauge : NSObject\n@end\n";
    expect(fileLanguages("ios/Gauge.h", () => text)).toEqual(["Objective-C"]);
    expect(languageOf("ios/Gauge.h", () => text)).toBeNull();
  });
});

describe("Linguist's order: file name, interpreter, ending, then the rules for a shared ending", () => {
  test("a name settles a file before anything else", () => {
    expect(fileLanguages("build/Makefile", () => "#!/usr/bin/env python3\n")).toEqual(["Makefile"]);
  });

  test("the interpreter comes before the ending", () => {
    expect(fileLanguages("tools/report.ts", () => "#!/usr/bin/env python3\nprint(1)\n")).toEqual(["Python"]);
    expect(languageOf("tools/report.ts", () => "#!/usr/bin/env python3\nprint(1)\n")).toBe("python");
  });

  test("an interpreter several languages share is narrowed by the ending", () => {
    expect(fileLanguages("tools/serve.ts", () => "#!/usr/bin/env bun\nexport {};\n")).toEqual(["TypeScript"]);
    expect(fileLanguages("tools/serve.js", () => "#!/usr/bin/env bun\nexport {};\n")).toEqual(["JavaScript"]);
  });

  test("with no name and no ending, the interpreter names it", () => {
    expect(languageOf("bin/run", () => "#!/usr/bin/env python3\nprint(1)\n")).toBe("python");
  });

  test("the ending names it, then a shared ending's rules", () => {
    expect(fileLanguages("api/meter.proto", () => "")).toEqual(["Protocol Buffer"]);
    expect(languageOf("legacy/report.pl", () => "use strict;\nprint 1;\n")).toBe("perl");
  });
});

describe("a file Linguist's rules settle nothing for", () => {
  test("is read as the language of a module among its languages", () => {
    const mod = "/*!\nShell completions.\n*/\n\npub(super) mod bash;\npub(super) mod fish;\n";
    expect(fileLanguages("crates/cli/src/complete/mod.rs", () => mod).length).toBeGreaterThan(1);
    expect(languageOf("crates/cli/src/complete/mod.rs", () => mod)).toBe("rust");
    expect(languageOf("legacy/sums.pl", () => "sub total {\n  return 0;\n}\n")).toBe("perl");
  });

  test("whose ending no module names as its own is named as one of its languages and not parsed", () => {
    for (const [file, text] of [
      ["web/header.inc", "x\n"],
      ["pkg/meter.spec", "x\n"],
      ["t/basic.t", "x\n"],
      ["cgi/form.cgi", "x\n"],
    ] as const) {
      const languages = fileLanguages(file, () => text);
      expect(languages.length).toBeGreaterThan(1);
      expect(languageOf(file, () => text)).toBeNull();
      expect(unreadLanguage(languages, file)).toBe(`one of ${languages.join(", ")}`);
    }
  });

  test("is read by the module that names its ending as its own, not by Linguist's first language", () => {
    expect(moduleOfLanguages("native/gauge.h", ["C++", "C"])).toBe("c");
    expect(moduleOfLanguages("native/gauge.hpp", ["C", "C++"])).toBe("cpp");
    expect(moduleOfLanguages("cgi/form.cgi", ["Perl", "Python", "Shell"])).toBeNull();
  });

  test("each ending belongs to one module", () => {
    const owners = new Map<string, string>();
    for (const module of LANGUAGES) {
      for (const ending of module.endings) {
        expect(owners.get(ending)).toBeUndefined();
        owners.set(ending, module.name);
      }
    }
    expect(owners.get(".rs")).toBe("rust");
    expect(owners.get(".ts")).toBe("typescript");
    expect(owners.get(".py")).toBe("python");
  });

  test("with no module among its languages, is named as one of them, never guessed", () => {
    const languages = fileLanguages("lib/facts.ecl", () => "x\n");
    expect(languages).toEqual(["ECL", "ECLiPSe"]);
    expect(languageOf("lib/facts.ecl", () => "x\n")).toBeNull();
    expect(unreadLanguage(languages, "lib/facts.ecl")).toBe("one of ECL, ECLiPSe");
  });
});

describe("a dialect keeps its module", () => {
  test.each([
    ["db/fn.sql", "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql;\n", "PLpgSQL"],
    ["db/proc.sql", "CREATE PROCEDURE p AS\nGO\n", "TSQL"],
    ["db/seq.sql", "SELECT ledger_seq.nextval FROM dual;\n", "PLSQL"],
    ["db/mod.sql", "ALTER MODULE ledger ADD PROCEDURE p();\n", "SQLPL"],
    ["db/plain.sql", "CREATE TABLE ledger (id INTEGER);\n", "SQL"],
  ])("%s is %s, read by the SQL module", (file, text, name) => {
    expect(fileLanguages(file, () => text)).toEqual([name]);
    expect(languageOf(file, () => text)).toBe("sql");
  });

  test("a dialect's other endings are not read", () => {
    expect(fileLanguages("db/fn.pgsql", () => "")).toEqual(["PLpgSQL"]);
    expect(languageOf("db/fn.pgsql", () => "")).toBeNull();
    expect(languageOf("db/body.pls", () => "")).toBeNull();
  });
});

describe("a file's interpreter", () => {
  test.each([
    ["#!/usr/bin/env bash\n", "bash"],
    ["#!/usr/bin/env -S python3 -u\n", "python3"],
    ["#!/usr/bin/python2.7\n", "python2"],
    ["#!/bin/sh\nexec ruby \"$0\" \"$@\"\n", "ruby"],
    ["echo no shebang\n", null],
  ])("%j", (text, interpreter) => {
    expect(interpreterOf(text)).toBe(interpreter);
  });
});

describe(".gitattributes", () => {
  const attributes = new GitAttributes(
    new Map([
      [".gitattributes", "*.tpl linguist-language=Python\nthird_party/** linguist-vendored\n"],
      ["web/.gitattributes", "*.js linguist-language=TypeScript\n"],
    ]),
  );

  test("linguist-language names a file's language", () => {
    expect(languageOf("views/page.tpl", () => "def page():\n    pass\n", attributes.of("views/page.tpl"))).toBe("python");
    expect(languageOf("web/app.js", () => "", attributes.of("web/app.js"))).toBe("typescript");
    expect(languageOf("app.js", () => "", attributes.of("app.js"))).toBe("javascript");
  });

  test("a deeper file and a later line win", () => {
    const deeper = new GitAttributes(
      new Map([
        [".gitattributes", "*.inc linguist-language=C\n*.inc linguist-language=Perl\n"],
        ["sub/.gitattributes", "*.inc linguist-language=Python\n"],
      ]),
    );
    expect(deeper.of("a.inc")["linguist-language"]).toBe("Perl");
    expect(deeper.of("sub/b.inc")["linguist-language"]).toBe("Python");
  });
});

describe("indexing a project", () => {
  const HUMAN: Actor = { kind: "human" };
  let project: string;
  let store: Store;

  function git(...args: string[]): void {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project, encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }

  beforeEach(() => {
    project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-linguist-")));
    git("init", "-q", "-b", "main");
  });

  afterEach(() => {
    store?.close();
    rmSync(project, { recursive: true, force: true });
  });

  /** Commits `files`, indexes the project, and returns each file's module and its count of symbols other than the file's own. */
  async function indexed(files: Record<string, string>): Promise<{ langs: Record<string, string | null>; symbols: Record<string, number>; notRead: { name: string; files: number }[] }> {
    for (const [file, text] of Object.entries({ ".gitignore": ".tmb/\n", ...files })) {
      mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      writeFileSync(path.join(project, file), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    store = opened.store;
    writeSetting(store, HUMAN, "base_branch", "main");
    const stats = await indexProject(project, store, { rebuild: false });
    const view = await openView(project, store);
    try {
      const rows = view.db.query("SELECT path, lang FROM files WHERE layer = ?").all(view.layer) as { path: string; lang: string | null }[];
      const counts = view.db.query("SELECT path, COUNT(*) AS n FROM symbols WHERE layer = ? AND kind != 'file' GROUP BY path").all(view.layer) as { path: string; n: number }[];
      return { langs: Object.fromEntries(rows.map((r) => [r.path, r.lang])), symbols: Object.fromEntries(counts.map((c) => [c.path, c.n])), notRead: stats.notRead.languages };
    } finally {
      view.db.close();
    }
  }

  test("a `.ts` file that holds a Qt `TS` tag is XML, as on GitHub, and a linguist-language line makes it TypeScript", async () => {
    // Written in two parts, so this file does not hold the tag itself and stays TypeScript.
    const qt = `const nodes: Array${"<"}TS.Node> = [];\nexport function walk() { return nodes; }\n`;
    const { langs } = await indexed({
      ".gitattributes": "src/typed.ts linguist-language=TypeScript\n",
      "src/strings.ts": qt,
      "src/typed.ts": qt,
    });
    expect(langs["src/strings.ts"]).toBeNull();
    expect(langs["src/typed.ts"]).toBe("typescript");
  });

  test("a `.pyi` stub is Python, kept as a file with no symbols (trustmybot/tmb#390)", async () => {
    const { langs, symbols, notRead } = await indexed({
      "pkg/meter.py": "def reading():\n    return 1\n",
      "pkg/meter.pyi": "def reading() -> int: ...\n",
    });
    expect(fileLanguages("pkg/meter.pyi", () => "")).toEqual(["Python"]);
    expect(langs["pkg/meter.py"]).toBe("python");
    expect(langs["pkg/meter.pyi"]).toBeNull();
    expect(symbols["pkg/meter.pyi"]).toBeUndefined();
    expect(notRead).toEqual([]);
  });

  test("an undecided file no module reads is counted as one of its languages", async () => {
    const { langs, notRead } = await indexed({ "lib/facts.ecl": "x\n", "lib/main.py": "def main():\n    pass\n" });
    expect(langs["lib/facts.ecl"]).toBeNull();
    expect(notRead).toEqual([{ name: "one of ECL, ECLiPSe", files: 1 }]);
  });

  test("a .gitattributes override changes a file's language and takes a vendored folder out", async () => {
    const files: Record<string, string> = {
      ".gitignore": ".tmb/\n",
      ".gitattributes": "*.tpl linguist-language=Python\nthird_party/** linguist-vendored\ndist/** -linguist-vendored\n",
      "views/page.tpl": "def render_page():\n    return 1\n",
      "third_party/zlib/inflate.py": "def inflate_block():\n    return 2\n",
      "dist/bundle.py": "def bundled_entry():\n    return 3\n",
      "app/main.py": "def run_app():\n    return 4\n",
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      writeFileSync(path.join(project, file), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    const opened = openProjectStore(project, { create: true });
    if (!opened.ok) throw opened.error;
    store = opened.store;
    writeSetting(store, HUMAN, "base_branch", "main");
    await indexProject(project, store, { rebuild: false });
    const view = await openView(project, store);
    try {
      const rows = view.db.query("SELECT path, lang FROM files WHERE layer = ? ORDER BY path").all(view.layer) as { path: string; lang: string }[];
      const langs = Object.fromEntries(rows.map((r) => [r.path, r.lang]));
      expect(langs["views/page.tpl"]).toBe("python");
      expect(langs["app/main.py"]).toBe("python");
      expect(langs["dist/bundle.py"]).toBe("python");
      expect(langs["third_party/zlib/inflate.py"]).toBeUndefined();
    } finally {
      view.db.close();
    }
  });
});

describe("Linguist's data", () => {
  test("is a pinned MIT release, and each file is the one the release names", () => {
    expect(LINGUIST_RELEASE.repo).toBe("github-linguist/linguist");
    expect(LINGUIST_RELEASE.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(LINGUIST_RELEASE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(LINGUIST_RELEASE.licence).toBe("MIT");
    for (const [name, sha] of Object.entries(LINGUIST_RELEASE.files)) {
      expect(createHash("sha256").update(readFileSync(path.join(LINGUIST_DIR, "data", name))).digest("hex")).toBe(sha);
    }
  });

  test("a rule JavaScript cannot run as Ruby does gives no answer, and no later rule answers in its place", () => {
    const languages = "Alpha:\n  type: programming\n  extensions: [\".zq\"]\nBeta:\n  type: programming\n  extensions: [\".zq\"]\n";
    const heuristics = "disambiguations:\n- extensions: ['.zq']\n  rules:\n  - language: Alpha\n    pattern: '[[:alpha:]]+;'\n  - language: Beta\n";
    const table = new Linguist({ languages, heuristics, generic: "extensions: []\n" });
    expect(table.detect("x.zq", () => "abc;\n").languages).toEqual(["Alpha", "Beta"]);
  });

  test("a list that cannot be read stops tmb with Linguist's file named", () => {
    expect(() => new Linguist({ languages: "Gauge: [", heuristics: "disambiguations: []\n", generic: "{}\n" })).toThrow(/languages\.yml/);
  });

  test("the build fails when a data file is missing", async () => {
    const copy = mkdtempSync(path.join(tmpdir(), "tmb-linguist-build-"));
    try {
      cpSync(LINGUIST_DIR, copy, { recursive: true });
      rmSync(path.join(copy, "data", "languages.yml"));
      const built = await Bun.build({ entrypoints: [path.join(copy, "index.ts")], target: "bun", throw: false });
      expect(built.success).toBe(false);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
