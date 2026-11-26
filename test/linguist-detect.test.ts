// A file's language comes from GitHub Linguist's list (trustmybot/tmb#154): Linguist's strategies
// (file name, extension, interpreter, then its heuristics) name it, a project's `.gitattributes`
// wins over them, and the build fails when Linguist's data cannot be read.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileLanguages, languageOf } from "../src/engine/graph/extract.ts";
import { indexProject, openView } from "../src/engine/graph/fresh.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import { GitAttributes } from "../src/engine/linguist/gitattributes.ts";
import { interpreterOf, Linguist, LINGUIST_RELEASE } from "../src/engine/linguist/index.ts";
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

  test("an extension the heuristics cannot settle stays undecided", () => {
    const languages = fileLanguages("logic/facts.pl", () => "likes(mary, wine).\n");
    expect(languages.length).toBeGreaterThan(1);
    expect(languageOf("logic/facts.pl", () => "likes(mary, wine).\n")).toBeNull();
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
