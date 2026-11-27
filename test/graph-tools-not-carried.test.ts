// The TypeScript compiler and pyright are not in the tmb program (CODE_GRAPH.md, "Where a
// language's tool comes from"; trustmybot/tmb#395): a developer who writes neither language carries
// neither tool. Each is installed on ask into tmb's tools folder and loaded from there. The program
// is bundled the way scripts/build.ts bundles it, from src/cli.ts; no file of it, code or a file it
// carries, holds the compiler's code, pyright's, or the language files each reads.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

setDefaultTimeout(30_000);

const ROOT = path.resolve(import.meta.dir, "..");

/** A line of the compiler's own code: the version it declares, read from the reference package of the same version. */
const COMPILER_LINE = (() => {
  const version = (JSON.parse(readFileSync(Bun.resolveSync("typescript5/package.json", ROOT), "utf8")) as { version: string }).version;
  return `versionMajorMinor = "${version.split(".").slice(0, 2).join(".")}"`;
})();
/** A line of the compiler's default library, which only that library spells. */
const LIBRARY_LINE = "interface ReadonlyArray<T> {";
/** A line of pyright's own code: the name of one of its checks, which only its code spells. */
const PYRIGHT_LINE = "reportUnnecessaryTypeIgnoreComment";
/** A line of typeshed's stubs of Python's built-ins. */
const TYPESHED_LINE = "class object:";

let outdir: string;
let texts: string[];

beforeAll(async () => {
  outdir = mkdtempSync(path.join(tmpdir(), "tmb-not-carried-"));
  const result = await Bun.build({ entrypoints: [path.join(ROOT, "src", "cli.ts")], target: "bun", outdir, throw: false });
  expect(result.success).toBe(true);
  texts = result.outputs.filter((o) => !o.path.endsWith(".wasm")).map((o) => readFileSync(o.path, "utf8"));
});

afterAll(() => rmSync(outdir, { recursive: true, force: true }));

describe("the tmb program", () => {
  test("holds none of the TypeScript compiler's code and none of its default library", () => {
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.includes(COMPILER_LINE)).toBe(false);
      expect(text.includes(LIBRARY_LINE)).toBe(false);
    }
  });

  test("holds none of pyright's code and none of typeshed's stubs", () => {
    for (const text of texts) {
      expect(text.includes(PYRIGHT_LINE)).toBe(false);
      expect(text.includes(TYPESHED_LINE)).toBe(false);
    }
  });
});
