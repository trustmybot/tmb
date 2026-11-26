// Way B follows the project's own configs (trustmybot/tmb#324; CODE_GRAPH.md, "Two ways to make
// links"): a file is resolved under the config that owns it, references included, and a file under
// no config uses the compiler's defaults. Which config owns a file is the TypeScript compiler's
// own answer, as its language service finds a file's project:
// - the nearest folder above the file with a tsconfig.json, else a jsconfig.json, names the first
//   config tried;
// - a config owns the file when its `files`, `include` and `exclude` take it in, and no project it
//   references takes it in too;
// - else a project it references, at any depth, that takes the file in;
// - else the next config above the config's own folder, tried the same way;
// - else none: the file is compiled with the compiler's defaults.
// A project's referenced projects are read from their source, each file with its own project's
// settings, as the compiler's editor does. The fixtures are small repos of their own; each
// expectation is read off the rule, not off the graph's output.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../src/engine/graph/build.ts";
import { openGraphDb } from "../src/engine/graph/db.ts";

setDefaultTimeout(30_000);

let project: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(files: Record<string, string>): string {
  for (const [file, text] of Object.entries({ ".gitignore": ".tmb/\nnode_modules/\n", ...files })) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  return git(project, "rev-parse", "HEAD");
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-project-configs-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

type CallRow = { dst: string | null; call_state: string | null; way: string | null };

/** The one call of `name` that `src` makes, in the layer way B builds. */
async function wayB(files: Record<string, string>): Promise<{ db: Database; call: (src: string, name: string) => CallRow }> {
  const sha = commit(files);
  const db = openGraphDb(project, null);
  await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
  const call = (src: string, name: string): CallRow => {
    const found = db
      .query(
        `SELECT d.path || ':' || d.qualified_name AS dst, e.call_state, e.way
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
         WHERE e.layer = 'b' AND s.path || ':' || s.qualified_name = ? AND e.dst_name = ? AND e.call_state IS NOT NULL`,
      )
      .all(src, name) as CallRow[];
    if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}`);
    return found[0]!;
  };
  return { db, call };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const lines = (...l: string[]): string => [...l, ""].join("\n");

const LINKED = { call_state: "linked", way: "language-tool" };

describe("a file is resolved under the config that owns it", () => {
  // Two folders map one alias to two places. The root's config maps it to the shared seeds; the
  // garden's own config, nearer its files, maps it to the garden's seeds. Read under the root's
  // config alone, the garden's call would reach the shared `sow`: a wrong link.
  const GARDEN = {
    "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@seeds/*": ["./shared/seeds/*"] } }, include: ["shared", "garden/loose"] }),
    "shared/seeds/bean.ts": lines("export function sow(): number {", "  return 1;", "}"),
    "garden/tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@seeds/*": ["./seeds/*"] } }, include: ["plot.ts", "seeds"] }),
    "garden/seeds/bean.ts": lines("export function sow(): number {", "  return 2;", "}"),
    "garden/plot.ts": lines('import { sow } from "@seeds/bean";', "export function plant(): number {", "  return sow();", "}"),
    // In the garden's folder, but not in its config's `include`: the config above takes it in.
    "garden/loose/weed.ts": lines('import { sow } from "@seeds/bean";', "export function spread(): number {", "  return sow();", "}"),
    // A JavaScript folder whose own settings are a jsconfig.json.
    "orchard/jsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@seeds/*": ["./pits/*"] } } }),
    "orchard/pits/plum.js": lines("export function sow() {", "  return 3;", "}"),
    "orchard/grove.js": lines('import { sow } from "@seeds/plum";', "export function grow() {", "  return sow();", "}"),
  };

  test("a folder's own config, nearest the file, resolves its alias, not the root's", async () => {
    const { db, call } = await wayB(GARDEN);
    expect(call("garden/plot.ts:plant", "sow")).toMatchObject({ dst: "garden/seeds/bean.ts:sow", ...LINKED });
    db.close();
  });

  test("a jsconfig.json is a folder's config too", async () => {
    const { db, call } = await wayB(GARDEN);
    expect(call("orchard/grove.js:grow", "sow")).toMatchObject({ dst: "orchard/pits/plum.js:sow", ...LINKED });
    db.close();
  });

  test("a file its nearest config leaves out is owned by the config above that takes it in", async () => {
    const { db, call } = await wayB(GARDEN);
    expect(call("garden/loose/weed.ts:spread", "sow")).toMatchObject({ dst: "shared/seeds/bean.ts:sow", ...LINKED });
    db.close();
  });
});

describe("references included", () => {
  // A solution: the root's config owns no file and names its projects. The tools project's config
  // is not named tsconfig.json, so only the reference reaches it; its alias `~/` is its own.
  const WORKSHOP = {
    "tsconfig.json": json({ files: [], references: [{ path: "./tools/tsconfig.lib.json" }, { path: "./bench" }] }),
    "tools/tsconfig.lib.json": json({ compilerOptions: { composite: true, baseUrl: ".", paths: { "~/*": ["./src/*"] } }, include: ["src"] }),
    "tools/src/hammer.ts": lines("export class Hammer {", "  strike(): number {", "    return 1;", "  }", "}", "export function hammer(): Hammer {", "  return new Hammer();", "}"),
    "tools/src/kit/box.ts": lines('import { hammer, type Hammer } from "~/hammer";', "export function pick(): Hammer {", "  return hammer();", "}"),
    // The bench project references tools, and has no alias of its own.
    "bench/tsconfig.json": json({ compilerOptions: { composite: true }, include: ["*.ts"], references: [{ path: "../tools/tsconfig.lib.json" }] }),
    "bench/job.ts": lines('import { pick } from "../tools/src/kit/box";', "export function work(): number {", "  return pick().strike();", "}"),
  };

  test("a file only a referenced project takes in is resolved under that project's config", async () => {
    const { db, call } = await wayB(WORKSHOP);
    expect(call("tools/src/kit/box.ts:pick", "hammer")).toMatchObject({ dst: "tools/src/hammer.ts:hammer", ...LINKED });
    db.close();
  });

  test("a referenced project's files keep their own settings in the project that references it", async () => {
    // `pick` returns a `Hammer` only through the tools project's alias, which bench does not have.
    const { db, call } = await wayB(WORKSHOP);
    expect(call("bench/job.ts:work", "strike")).toMatchObject({ dst: "tools/src/hammer.ts:Hammer.strike", ...LINKED });
    db.close();
  });
});

describe("a file under no config uses the compiler's defaults", () => {
  // The root's config takes in `src` only. A script beside it is under no config: the root's alias
  // is not its, so its import names nothing and its call is not known.
  const SCRIPTED = {
    "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@core/*": ["./src/*"] } }, include: ["src"] }),
    "src/engine.ts": lines("export function start(): number {", "  return 1;", "}"),
    "src/main.ts": lines('import { start } from "@core/engine";', "export function main(): number {", "  return start();", "}"),
    "scripts/launch.ts": lines('import { start } from "@core/engine";', 'import { main } from "../src/main";', "export function launch(): number {", "  return start() + main();", "}"),
  };

  test("a file its config takes in is resolved under it", async () => {
    const { db, call } = await wayB(SCRIPTED);
    expect(call("src/main.ts:main", "start")).toMatchObject({ dst: "src/engine.ts:start", ...LINKED });
    db.close();
  });

  test("a file no config takes in does not get a config's alias, and still links what its own imports name", async () => {
    const { db, call } = await wayB(SCRIPTED);
    expect(call("scripts/launch.ts:launch", "start")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    expect(call("scripts/launch.ts:launch", "main")).toMatchObject({ dst: "src/main.ts:main", ...LINKED });
    db.close();
  });
});

describe("a same-repo package whose entry is build output (trustmybot/tmb#236)", () => {
  // The repo's own package names its entry in `dist`, which git does not hold; its config states
  // where its sources are (`rootDir`) and where output goes (`outDir`). A folder of the repo with a
  // package and config of its own imports it by the package's name. Expected, from the issue and
  // the page's Planned row: the call links to the source declaration in `src`.
  const PANTRY = {
    "package.json": json({ name: "pantry-kit", type: "module", main: "dist/index.js", types: "dist/index.d.ts", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } }),
    "tsconfig.json": json({ compilerOptions: { composite: true, rootDir: "src", outDir: "dist", module: "esnext", moduleResolution: "bundler", declaration: true }, include: ["src"] }),
    "src/index.ts": lines("export function stock(): number {", "  return 1;", "}"),
    "stalls/corner/package.json": json({ name: "corner-stall", type: "module", dependencies: { "pantry-kit": "workspace:*" } }),
    "stalls/corner/tsconfig.json": json({ compilerOptions: { module: "esnext", moduleResolution: "bundler" }, include: ["src"], references: [{ path: "../.." }] }),
    "stalls/corner/src/shelf.ts": lines('import { stock } from "pantry-kit";', "export function restock(): number {", "  return stock();", "}"),
  };

  // Fails today: with nothing installed, the compiler resolves "pantry-kit" to no file. A bare
  // package name is looked up in `node_modules`, and the folder's own package is not "pantry-kit",
  // so the name is not the package's own. The tool's answer stands, so the call is not known.
  test.failing("an import of the package by its name links to the source declaration", async () => {
    const { db, call } = await wayB(PANTRY);
    expect(call("stalls/corner/src/shelf.ts:restock", "stock")).toMatchObject({ dst: "src/index.ts:stock", ...LINKED });
    db.close();
  });

  // The compiler proves it when the package is installed where the folder looks (a workspace link,
  // which git does not hold) and the folder's config references the package's project: it maps the
  // entry in `outDir` back to its source under `rootDir`, as its editor reads a referenced project.
  test("installed as a workspace link and referenced, the compiler maps the entry back to its source", async () => {
    mkdirSync(path.join(project, "node_modules"), { recursive: true });
    symlinkSync(project, path.join(project, "node_modules", "pantry-kit"), "dir");
    const { db, call } = await wayB(PANTRY);
    expect(call("stalls/corner/src/shelf.ts:restock", "stock")).toMatchObject({ dst: "src/index.ts:stock", ...LINKED });
    db.close();
  });
});
