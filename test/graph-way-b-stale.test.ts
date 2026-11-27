// A way B graph is stale when the tool or the installed packages change (CODE_GRAPH.md, "Two ways
// to make links"; trustmybot/tmb#325). A layer built by the language's tool records what it was
// built with: the tool, as it reports its own version, and the repo's installed packages it read.
// A read that finds either changed rebuilds the layer, as it does a layer an older reader built
// ("The graph keeps itself fresh"), and the answer's freshness says so; a read that finds both
// unchanged answers from the layer it has. A layer built by the built-in rules rests on neither.
// Each language's installed packages are its own:
// - TypeScript and JavaScript: tmb's copy of the compiler in its tools folder, whose version is tmb's
//   pin; the packages are the `node_modules` folders the compiler looks in;
// - Python: tmb's copy of pyright in its tools folder, at tmb's pin; the packages are those of the
//   environment pyright reads;
// - Go: the user's `go`; the packages are the modules the repo's go.sum names, in the module cache;
// - Java: the user's JDK; javac reads no class path, so there are no packages;
// - Rust: the user's rust-analyzer; the packages are the crates the repo's Cargo.lock resolves
//   from a registry, in Cargo's registry on disk;
// - C and C++: the user's clangd; what it reads beyond the commit is the project's compile database,
//   which a build makes and git does not hold, and the headers outside the repo its answers name.
// Each expectation is read off the page's rule, not off the graph's output.
import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { BASE_LAYER, GRAPH_SCHEMA_VERSION, graphDbPath, layerRow, openGraphDb } from "../src/engine/graph/db.ts";
import { type GraphView, openView } from "../src/engine/graph/fresh.ts";
import { openProjectStore, writeSetting } from "../src/engine/index.ts";
import type { Actor, Store } from "../src/engine/store/index.ts";
import { PYRIGHT_PIN } from "../src/engine/graph/languages/python/tool.ts";
import { TYPESCRIPT_PIN } from "../src/engine/graph/languages/typescript/tool.ts";
import { installPinnedTools } from "../tests/lib/pinned-tools.ts";

setDefaultTimeout(30_000);

// Way B loads the TypeScript compiler and pyright from tmb's tools folder; the setup installs them.
beforeAll(installPinnedTools);

const HUMAN: Actor = { kind: "human" };
const HAS_GO = spawnSync("go", ["version"]).status === 0;
const HAS_JAVA = spawnSync("java", ["-version"]).status === 0;
const HAS_CLANGD = spawnSync("clangd", ["--version"]).status === 0;

let project: string;
let bin: string;
let store: Store | undefined;
const saved: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
}

/** Commits the files; the untracked ones (installed packages) are written beside them. */
function commit(files: Record<string, string>, untracked: Record<string, string> = {}): void {
  write({ ".gitignore": ".tmb/\nnode_modules/\n.venv/\n", ...files });
  write(untracked);
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
}

/** Sets an environment variable for one test; afterEach puts it back. */
function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-wayb-stale-")));
  bin = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-wayb-bin-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  store?.close();
  store = undefined;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

/** The project's record, with its base branch and the way set. */
function opened(way: "built-in" | "language-tool" = "language-tool"): Store {
  if (store !== undefined) return store;
  const result = openProjectStore(project, { create: true });
  if (!result.ok) throw result.error;
  store = result.store;
  writeSetting(store, HUMAN, "base_branch", "main");
  writeSetting(store, HUMAN, "graph_links", way);
  return store;
}

/** A read of the graph: when the layer it held was rebuilt, and what the freshness says. */
async function read(way: "built-in" | "language-tool" = "language-tool"): Promise<{ builtAt: string; toolChanged: boolean; builtWith: Record<string, { tool: string }> }> {
  const view: GraphView = await openView(project, opened(way));
  try {
    const row = layerRow(view.db, BASE_LAYER)!;
    const withText = (row as { built_with?: string | null }).built_with ?? null;
    return { builtAt: row.built_at, toolChanged: (view.freshness as { toolChanged?: boolean }).toolChanged ?? false, builtWith: withText === null ? {} : JSON.parse(withText) };
  } finally {
    view.db.close();
  }
}

/** Waits until the clock has moved, so a rebuilt layer's time differs from the one before. */
async function tick(): Promise<void> {
  const now = new Date().toISOString();
  while (new Date().toISOString() === now) await Bun.sleep(1);
}

/** A program on PATH, ahead of the real one: it reports `version` when asked its version, and runs the real one otherwise. */
function shim(name: string, versionArg: string, version: string, toStderr: boolean): void {
  const real = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: { ...process.env, PATH: (saved.PATH ?? process.env.PATH)! } }).stdout.trim();
  const script = `#!/bin/sh\nif [ "$1" = "${versionArg}" ]; then echo '${version}'${toStderr ? " >&2" : ""}; exit 0; fi\nexec "${real}" "$@"\n`;
  writeFileSync(path.join(bin, name), script);
  chmodSync(path.join(bin, name), 0o755);
  if (!("PATH" in saved)) setEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
}

const pkg = (name: string, version: string) => JSON.stringify({ name, version, types: "index.d.ts" });

describe("TypeScript and JavaScript: tmb's copy of the compiler, and the repo's node_modules", () => {
  const SHOP = {
    "src/till.ts": ['import { round } from "rounding";', "export function rounded(n: number): number {", "  return round(n);", "}", ""].join("\n"),
  };
  const ROUNDING = (version: string) => ({
    "node_modules/rounding/package.json": pkg("rounding", version),
    "node_modules/rounding/index.d.ts": "export declare function round(n: number): number;\n",
  });

  test("the layer records the compiler it was built with: the version tmb pins", async () => {
    commit(SHOP, ROUNDING("1.0.0"));
    const { builtWith } = await read();
    expect(builtWith["the TypeScript compiler"]?.tool).toBe(TYPESCRIPT_PIN.version);
  });

  test("nothing changed: the layer is still fresh", async () => {
    commit(SHOP, ROUNDING("1.0.0"));
    const first = await read();
    await tick();
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
    expect(second.toolChanged).toBe(false);
  });

  test("an installed package's version changed: the layer is stale, and the read rebuilds it and says so", async () => {
    commit(SHOP, ROUNDING("1.0.0"));
    const first = await read();
    await tick();
    write(ROUNDING("2.0.0"));
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
    await tick();
    const third = await read();
    expect(third.builtAt).toBe(second.builtAt);
  });

  test("a package installed where none was: the layer is stale", async () => {
    commit(SHOP);
    const first = await read();
    await tick();
    write(ROUNDING("1.0.0"));
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a scoped package added beside the others: the layer is stale", async () => {
    commit(SHOP, ROUNDING("1.0.0"));
    const first = await read();
    await tick();
    write({ "node_modules/@shop/tax/package.json": pkg("@shop/tax", "1.0.0") });
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
  });

  test("a layer recorded with another compiler is stale", async () => {
    commit(SHOP, ROUNDING("1.0.0"));
    const first = await read();
    const db = openGraphDb(project, null);
    const recorded = JSON.parse(layerRow(db, BASE_LAYER)!.built_with!) as Record<string, { tool: string }>;
    recorded["the TypeScript compiler"]!.tool = "0.0.1";
    db.run("UPDATE layers SET built_with = ? WHERE layer = ?", [JSON.stringify(recorded), BASE_LAYER]);
    db.close();
    await tick();
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a layer built by the built-in rules rests on no tool: a package change leaves it fresh", async () => {
    commit(SHOP, ROUNDING("1.0.0"));
    const first = await read("built-in");
    await tick();
    write(ROUNDING("2.0.0"));
    const second = await read("built-in");
    expect(second.builtAt).toBe(first.builtAt);
    expect(second.toolChanged).toBe(false);
  });
});

describe("Python: tmb's copy of pyright, and the repo's environment", () => {
  const ENV = ".venv";
  const SITE = `${ENV}/lib/python3.12/site-packages`;
  const CODE = { "shop/till.py": ["import inkwell", "", "", "def blotted():", "    return inkwell.blot(1)", ""].join("\n") };
  const environment = { [`${ENV}/pyvenv.cfg`]: "home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.12.0\n", [`${SITE}/inkwell/__init__.py`]: "def blot(n):\n    return n\n" };

  test("the layer records the pyright it was built with: the version tmb pins", async () => {
    commit(CODE, environment);
    const { builtWith } = await read();
    expect(builtWith.pyright?.tool).toBe(PYRIGHT_PIN.version);
  });

  test("nothing changed: the layer is still fresh", async () => {
    commit(CODE, environment);
    const first = await read();
    await tick();
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
  });

  test("a package installed in the environment: the layer is stale", async () => {
    commit(CODE, environment);
    const first = await read();
    await tick();
    write({ [`${SITE}/quill-2.0.dist-info/METADATA`]: "Name: quill\nVersion: 2.0\n", [`${SITE}/quill/__init__.py`]: "" });
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("an environment made where there was none: the layer is stale", async () => {
    commit(CODE);
    const first = await read();
    await tick();
    write(environment);
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
  });
});

describe.skipIf(!HAS_GO)("Go: the user's go, and the module cache", () => {
  const GO_MOD = "module example.test/grove\n\ngo 1.22\n\nrequire example.test/faraway v1.0.0\n";
  const GO_SUM = "example.test/faraway v1.0.0 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nexample.test/faraway v1.0.0/go.mod h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n";
  const CODE = { "go.mod": GO_MOD, "go.sum": GO_SUM, "grove/grove.go": 'package grove\n\nimport "example.test/faraway"\n\nfunc Reach() int { return faraway.Far() }\n' };
  let modules: string;

  beforeEach(() => {
    modules = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-wayb-gomods-")));
    setEnv("GOMODCACHE", modules);
  });
  afterEach(() => rmSync(modules, { recursive: true, force: true }));

  test("the layer records the go it was built with, as `go version` reports it", async () => {
    commit(CODE);
    const reported = spawnSync("go", ["version"], { encoding: "utf8" }).stdout.trim();
    const { builtWith } = await read();
    expect(builtWith["Go's type checker (go/types)"]?.tool).toBe(reported);
  });

  test("nothing changed: the layer is still fresh", async () => {
    commit(CODE);
    const first = await read();
    await tick();
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
  });

  test("go reports another version: the layer is stale", async () => {
    commit(CODE);
    const reported = spawnSync("go", ["version"], { encoding: "utf8" }).stdout.trim();
    shim("go", "version", reported, false);
    const first = await read();
    await tick();
    shim("go", "version", "go version go1.99.0 fake/arch", false);
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a module go.sum names arrives in the module cache: the layer is stale", async () => {
    commit(CODE);
    const first = await read();
    await tick();
    const dir = path.join(modules, "example.test", "faraway@v1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "go.mod"), "module example.test/faraway\n\ngo 1.22\n");
    writeFileSync(path.join(dir, "far.go"), "package faraway\n\nfunc Far() int { return 1 }\n");
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a layer recorded with another helper is stale: the helper's key changed", async () => {
    commit(CODE);
    const first = await read();
    const db = openGraphDb(project, null);
    const recorded = JSON.parse(layerRow(db, BASE_LAYER)!.built_with!) as Record<string, { helper?: { key: string } }>;
    expect(recorded["Go's type checker (go/types)"]?.helper?.key).toMatch(/^[0-9a-f]{64}$/);
    recorded["Go's type checker (go/types)"]!.helper!.key = "0".repeat(64);
    db.run("UPDATE layers SET built_with = ? WHERE layer = ?", [JSON.stringify(recorded), BASE_LAYER]);
    db.close();
    await tick();
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a module go.sum does not name arrives in the cache: the layer is still fresh", async () => {
    commit(CODE);
    const first = await read();
    await tick();
    mkdirSync(path.join(modules, "example.test", "elsewhere@v1.0.0"), { recursive: true });
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
  });
});

describe.skipIf(!HAS_JAVA)("Java: the user's JDK, and no packages", () => {
  const CODE = { "src/Till.java": "class Till {\n  int ring() { return weigh(); }\n  int weigh() { return 2; }\n}\n" };

  test("the layer records the JDK it was built with, as `java -version` reports it", async () => {
    commit(CODE);
    const run = spawnSync("java", ["-version"], { encoding: "utf8" });
    const { builtWith } = await read();
    expect(builtWith.javac?.tool).toBe(`${run.stdout}${run.stderr}`.trim());
  });

  test("nothing changed: the layer is still fresh", async () => {
    commit(CODE);
    const first = await read();
    await tick();
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
  });

  test("java reports another version: the layer is stale", async () => {
    commit(CODE);
    shim("java", "-version", 'openjdk version "21.0.0"', true);
    const first = await read();
    await tick();
    shim("java", "-version", 'openjdk version "99.0.0"', true);
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });
});

/**
 * A rust-analyzer on PATH that reports `version` and answers as one that resolves no name: `scip`
 * writes an empty index, and `diagnostics` reports no error. It runs without a real rust-analyzer.
 */
function fakeRustAnalyzer(version: string): void {
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi`,
    'if [ "$1" = "scip" ]; then while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then : > "$2"; fi; shift; done; exit 0; fi',
    'if [ "$1" = "diagnostics" ]; then echo "diagnostic scan complete"; exit 0; fi',
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(path.join(bin, "rust-analyzer"), script);
  chmodSync(path.join(bin, "rust-analyzer"), 0o755);
  if (!("PATH" in saved)) setEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
}

describe("Rust: the user's rust-analyzer, and Cargo's registry", () => {
  const CARGO_TOML = '[package]\nname = "orchard"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nfaraway = "1.0.0"\n';
  const CARGO_LOCK = [
    "version = 3",
    "",
    "[[package]]",
    'name = "faraway"',
    'version = "1.0.0"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'checksum = "0000000000000000000000000000000000000000000000000000000000000000"',
    "",
    "[[package]]",
    'name = "orchard"',
    'version = "0.1.0"',
    'dependencies = ["faraway"]',
    "",
  ].join("\n");
  const CODE = { "Cargo.toml": CARGO_TOML, "Cargo.lock": CARGO_LOCK, "src/lib.rs": "pub fn reach() -> i32 { faraway::far() }\n" };
  let cargoHome: string;

  beforeEach(() => {
    cargoHome = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-wayb-cargo-")));
    setEnv("CARGO_HOME", cargoHome);
  });
  afterEach(() => rmSync(cargoHome, { recursive: true, force: true }));

  /** A crate's sources in Cargo's registry, as Cargo unpacks them: `registry/src/<index>/<name>-<version>`. */
  const unpack = (name: string, version: string) => {
    const dir = path.join(cargoHome, "registry", "src", "index.crates.io-0000000000000000", `${name}-${version}`);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "Cargo.toml"), `[package]\nname = "${name}"\nversion = "${version}"\n`);
    writeFileSync(path.join(dir, "src", "lib.rs"), "pub fn far() -> i32 { 1 }\n");
  };

  test("the layer records the rust-analyzer it was built with, as `rust-analyzer --version` reports it", async () => {
    fakeRustAnalyzer("rust-analyzer 1.95.0 (fake 2026-01-01)");
    commit(CODE);
    const { builtWith } = await read();
    expect(builtWith["rust-analyzer"]?.tool).toBe("rust-analyzer 1.95.0 (fake 2026-01-01)");
  });

  test("nothing changed: the layer is still fresh", async () => {
    fakeRustAnalyzer("rust-analyzer 1.95.0 (fake 2026-01-01)");
    commit(CODE);
    const first = await read();
    await tick();
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
  });

  test("rust-analyzer reports another version: the layer is stale", async () => {
    fakeRustAnalyzer("rust-analyzer 1.95.0 (fake 2026-01-01)");
    commit(CODE);
    const first = await read();
    await tick();
    fakeRustAnalyzer("rust-analyzer 9.9.9 (fake 2026-12-31)");
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a crate Cargo.lock resolves arrives in Cargo's registry: the layer is stale", async () => {
    fakeRustAnalyzer("rust-analyzer 1.95.0 (fake 2026-01-01)");
    commit(CODE);
    const first = await read();
    await tick();
    unpack("faraway", "1.0.0");
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a crate Cargo.lock does not resolve arrives in the registry: the layer is still fresh", async () => {
    fakeRustAnalyzer("rust-analyzer 1.95.0 (fake 2026-01-01)");
    commit(CODE);
    const first = await read();
    await tick();
    unpack("elsewhere", "1.0.0");
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
  });
});

describe.skipIf(!HAS_CLANGD)("C and C++: the user's clangd, the compile database, and the headers outside the repo", () => {
  let outside: string;

  beforeEach(() => {
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-wayb-include-")));
    writeFileSync(path.join(outside, "far.h"), "int far_away(void);\n");
  });
  afterEach(() => rmSync(outside, { recursive: true, force: true }));

  /** The compile database a build would write: one entry, compiling pond/pond.c with `flags`. */
  const database = (flags: string) =>
    JSON.stringify([{ directory: project, file: "pond/pond.c", command: `cc ${flags} -I${outside} -c pond/pond.c -o pond.o` }]);
  const CODE = { ".gitignore": ".tmb/\nbuild/\n", "pond/pond.c": '#include "far.h"\n\nint reach(void) { return far_away(); }\n' };
  const placeDatabase = (flags: string) => write({ "build/compile_commands.json": database(flags) });
  const reported = () => spawnSync("clangd", ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0]!;

  test("the layer records the clangd it was built with, as the first line of `clangd --version` reports it", async () => {
    commit(CODE);
    placeDatabase("-std=c11");
    const { builtWith } = await read();
    expect(builtWith.clangd?.tool).toBe(reported());
  });

  test("nothing changed: the layer is still fresh", async () => {
    commit(CODE);
    placeDatabase("-std=c11");
    const first = await read();
    await tick();
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
  });

  test("clangd reports another version: the layer is stale", async () => {
    commit(CODE);
    placeDatabase("-std=c11");
    shim("clangd", "--version", reported(), false);
    const first = await read();
    await tick();
    shim("clangd", "--version", "clangd version 99.0.0 (fake)", false);
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("the compile database a build made again with other flags: the layer is stale", async () => {
    commit(CODE);
    placeDatabase("-std=c11");
    const first = await read();
    await tick();
    placeDatabase("-std=c17 -DPOND=1");
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a compile database made where there was none: the layer is stale", async () => {
    commit(CODE);
    const first = await read();
    await tick();
    placeDatabase("-std=c11");
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a header outside the repo that an answer names is gone: the layer is stale", async () => {
    commit(CODE);
    placeDatabase("-std=c11");
    const first = await read();
    await tick();
    rmSync(path.join(outside, "far.h"));
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.toolChanged).toBe(true);
  });

  test("a header outside the repo that no answer names arrives: the layer is still fresh", async () => {
    commit(CODE);
    placeDatabase("-std=c11");
    const first = await read();
    await tick();
    writeFileSync(path.join(outside, "near.h"), "int near_by(void);\n");
    const second = await read();
    expect(second.builtAt).toBe(first.builtAt);
  });
});

describe("the graph's store", () => {
  test("a schema-8 graph gains what each layer was built with; a way B layer that predates it is stale and rebuilt", async () => {
    const file = graphDbPath(project, null);
    mkdirSync(path.dirname(file), { recursive: true });
    const old = new Database(file, { create: true });
    old.run(
      "CREATE TABLE layers (layer TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, extractor INTEGER NOT NULL, built_at TEXT NOT NULL, files INTEGER NOT NULL DEFAULT 0, symbols INTEGER NOT NULL DEFAULT 0, edges INTEGER NOT NULL DEFAULT 0, unresolved INTEGER NOT NULL DEFAULT 0, unresolved_imports INTEGER NOT NULL DEFAULT 0, functions INTEGER NOT NULL DEFAULT 0, not_parsed INTEGER NOT NULL DEFAULT 0, not_read TEXT NOT NULL DEFAULT '{}', links TEXT NOT NULL DEFAULT 'built-in', links_note TEXT)",
    );
    old.run("INSERT INTO layers (layer, commit_sha, extractor, built_at, links) VALUES ('base', 'abc', 15, 'then', 'language-tool')");
    old.run("PRAGMA user_version = 8");
    old.close();
    const db = openGraphDb(project, null);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
    expect(GRAPH_SCHEMA_VERSION).toBeGreaterThan(8);
    expect(layerRow(db, "base")).toMatchObject({ links: "language-tool", built_with: null });
    db.close();
  });

  test("a schema-12 graph drops what its layers were built with, which names no helper, so a way B layer is rebuilt", () => {
    const db = openGraphDb(project, null);
    db.run("INSERT INTO layers (layer, commit_sha, extractor, built_at, files, symbols, edges, unresolved, links, built_with) VALUES ('base', 'abc', 1, 'then', 0, 0, 0, 0, 'language-tool', ?)", [
      JSON.stringify({ "Go's type checker (go/types)": { whose: "user", path: "/usr/bin/go", tool: "go version go1.27.4 darwin/arm64", packages: "", places: [] } }),
    ]);
    db.run("PRAGMA user_version = 12");
    db.close();
    const upgraded = openGraphDb(project, null);
    try {
      expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: GRAPH_SCHEMA_VERSION });
      expect(GRAPH_SCHEMA_VERSION).toBeGreaterThan(12);
      expect(layerRow(upgraded, "base")).toMatchObject({ links: "language-tool", built_with: null });
    } finally {
      upgraded.close();
    }
  });

  test("a way B layer that records nothing it was built with is stale and rebuilt", async () => {
    commit({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
    const first = await read();
    const db = openGraphDb(project, null);
    db.run("UPDATE layers SET built_with = NULL WHERE layer = ?", [BASE_LAYER]);
    db.close();
    await tick();
    const second = await read();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(Object.keys(second.builtWith)).toEqual(["the TypeScript compiler"]);
  });
});
