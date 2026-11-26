// tmb carries the TypeScript compiler and pyright (CODE_GRAPH.md, "Two ways to make links"): each
// is loaded only when way B builds a graph, so no other command starts slower for it. The program is
// bundled the way scripts/build.ts bundles it, from src/cli.ts; the code it parses at start must
// hold none of the compiler's, and the compiler must still be in it, carried as a file that way B
// loads. Way B's links through that path are the tests of graph-link-ways.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pyrightStdlib } from "../src/engine/graph/languages/python/stdlib.ts";

setDefaultTimeout(30_000);

const ROOT = path.resolve(import.meta.dir, "..");
/** The compiler's main file, as its package ships it. */
const COMPILER_FILE = Bun.resolveSync("typescript5/lib/typescript.js", ROOT);
/** A line of the compiler's own code: the version it declares, read from its package. */
const COMPILER_LINE = (() => {
  const version = (JSON.parse(readFileSync(Bun.resolveSync("typescript5/package.json", ROOT), "utf8")) as { version: string }).version;
  return `versionMajorMinor = "${version.split(".").slice(0, 2).join(".")}"`;
})();

let outdir: string;
let outputs: { kind: string; path: string }[];

beforeAll(async () => {
  outdir = mkdtempSync(path.join(tmpdir(), "tmb-carried-"));
  const result = await Bun.build({ entrypoints: [path.join(ROOT, "src", "cli.ts")], target: "bun", outdir, throw: false });
  expect(result.success).toBe(true);
  outputs = result.outputs.map((o) => ({ kind: o.kind, path: o.path }));
});

afterAll(() => rmSync(outdir, { recursive: true, force: true }));

describe("the compiler tmb carries", () => {
  test("no code the program parses at start is the compiler's", () => {
    const code = outputs.filter((o) => o.path.endsWith(".js") && o.kind !== "asset");
    expect(code.length).toBeGreaterThan(0);
    for (const o of code) expect(readFileSync(o.path, "utf8").includes(COMPILER_LINE)).toBe(false);
  });

  test("the program carries the compiler as a file, unchanged", () => {
    const carried = outputs.filter((o) => o.kind === "asset" && readFileSync(o.path, "utf8") === readFileSync(COMPILER_FILE, "utf8"));
    expect(carried.length).toBe(1);
  });
});

/** pyright's files as its package ships them: its entry file and the two parts of its bundle. */
const PYRIGHT_FILES = ["pyright.js", "pyright-internal.js", "vendor.js"].map((f) => Bun.resolveSync(`pyright/dist/${f}`, ROOT));
/** A line of pyright's own code: the name of one of its checks, which only its code spells. */
const PYRIGHT_LINE = "reportUnnecessaryTypeIgnoreComment";

describe("the pyright tmb carries", () => {
  test("no code the program parses at start is pyright's", () => {
    expect(readFileSync(PYRIGHT_FILES[1]!, "utf8").includes(PYRIGHT_LINE)).toBe(true);
    for (const o of outputs.filter((o) => o.path.endsWith(".js") && o.kind !== "asset")) expect(readFileSync(o.path, "utf8").includes(PYRIGHT_LINE)).toBe(false);
  });

  test("the program carries each of pyright's files as a file, unchanged", () => {
    const assets = outputs.filter((o) => o.kind === "asset").map((o) => readFileSync(o.path, "utf8"));
    for (const file of PYRIGHT_FILES) expect(assets.filter((a) => a === readFileSync(file, "utf8")).length).toBe(1);
  });

  test("it carries the standard library's stubs, and no stub of a third-party package", () => {
    const files = Object.keys(pyrightStdlib());
    expect(files).toContain("stdlib/builtins.pyi");
    expect(files).toContain("stdlib/VERSIONS");
    expect(files.filter((f) => !f.startsWith("stdlib/"))).toEqual([]);
  });
});
