// Go's helper is built once, from source tmb carries (CODE_GRAPH.md, "Where a language's tool comes
// from"; trustmybot/tmb#394). Each expectation is read off the page's rule:
// - it is built the first time a Go repo is indexed, into tmb's tools folder under its name and its
//   key, `<state>/tools/<helper>/<key>/<helper>`, and every later build of a graph runs it;
// - it is built with the user's `go`, the same one that then runs its `go list`; it is rebuilt when
//   its key changes (the user's `go`, tmb's source or the machine's kind), and the old one is removed;
// - the build takes none of the user's Go settings; the run takes them as before;
// - a failed build means the built-in rules for Go, with a note that names the error;
// - a package the helper cannot check at all, such as a repo that needs a newer Go, is an error and
//   the built-in rules are used; an ordinary type error leaves its calls not known, and counted;
// - `tmb tools` lists the helper with Go.
// Each test has a state folder of its own, so the helper is built there afresh.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILT_IN_RULES, buildLayer } from "../src/engine/graph/build.ts";
import { layerRow, openGraphDb } from "../src/engine/graph/db.ts";
import { goTypeChecker, HELPER, helperKey } from "../src/engine/graph/languages/go/tool.ts";
import { TOOL_PATHS_FILE, toolsFolder } from "../src/engine/graph/tool-copy.ts";
import { toolLine, toolRows } from "../src/engine/graph/tool-report.ts";

setDefaultTimeout(30_000);

const HAS_GO = spawnSync("go", ["version"]).status === 0;
const REAL_GO = spawnSync("sh", ["-c", "command -v go"], { encoding: "utf8" }).stdout.trim();
const TOOL = goTypeChecker.name;
const SOURCE = readFileSync(path.join(import.meta.dir, "..", "src", "engine", "graph", "languages", "go", "gotypes.go"));

let project: string;
let state: string;
let scratch: string;
const saved: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(files: Record<string, string>): string {
  for (const [file, text] of Object.entries({ ".gitignore": ".tmb/\n", ...files })) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  return git(project, "rev-parse", "HEAD");
}

/** Sets an environment variable for one test; afterEach puts it back. */
function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-gohelper-")));
  state = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-gohelper-state-")));
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-gohelper-scratch-")));
  git(project, "init", "-q", "-b", "main");
  setEnv("TMB_STATE_DIR", state);
  // An empty module cache of the test's own: nothing the repo needs is on disk.
  setEnv("GOMODCACHE", path.join(scratch, "modules"));
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  for (const dir of [project, state, scratch]) rmSync(dir, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const GO_MOD = (version: string) => lines("module example.test/loom", "", `go ${version}`);

const SHUTTLE = lines(
  "package shuttle", //                                          1
  "", //                                                         2
  "func Weave(n int) int { return thread(n) + knot() }", //      3
  "", //                                                         4
  "func thread(n int) int { return n }", //                      5
  "", //                                                         6
  "func Tangle() int { return thread(1, 2) }", //                7
);

const SPOOL = lines(
  "package shuttle", //                                          1
  "", //                                                         2
  "func knot() int { return 3 }", //                             3
);

const LOOM = { "go.mod": GO_MOD("1.22"), "shuttle/shuttle.go": SHUTTLE, "shuttle/spool.go": SPOOL };

/** A `go` the setting names: it logs each command it is given, then runs the real `go`, or does what `on` says for one command. */
function namedGo(on: Record<string, string> = {}): { log: string } {
  const dir = path.join(scratch, "named");
  mkdirSync(dir, { recursive: true });
  const log = path.join(scratch, "go.log");
  const cases = Object.entries(on)
    .map(([command, body]) => `  ${command}) ${body} ;;\n`)
    .join("");
  const script = `#!/bin/sh\necho "$1" >> "${log}"\ncase "$1" in\n${cases}  *) exec "${REAL_GO}" "$@" ;;\nesac\n`;
  writeFileSync(path.join(dir, "go"), script);
  chmodSync(path.join(dir, "go"), 0o755);
  writeFileSync(path.join(state, TOOL_PATHS_FILE), JSON.stringify({ paths: { go: path.join(dir, "go") } }));
  return { log };
}

const commands = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

/** The helper's folders in the tools folder: one per key. */
const keys = (): string[] => {
  const dir = path.join(toolsFolder(state), HELPER);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

const binaryOf = (key: string): string => path.join(toolsFolder(state), HELPER, key, process.platform === "win32" ? `${HELPER}.exe` : HELPER);

type CallRow = { src: string; dst_name: string; dst: string | null; call_state: string; way: string | null };

function calls(db: Database, layer: string): CallRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name, d.path || ':' || d.qualified_name AS dst, e.call_state, e.way
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state IS NOT NULL ORDER BY s.path, e.pos`,
    )
    .all(layer) as CallRow[];
}

function call(rows: CallRow[], src: string, name: string): CallRow {
  const found = rows.filter((r) => r.src === src && r.dst_name === name);
  if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}`);
  return found[0]!;
}

async function index(sha: string, layer = "b"): Promise<{ db: Database; note: string | null }> {
  const db = openGraphDb(project, null);
  const stats = await buildLayer(db, project, sha, layer, { force: true, links: "language-tool" });
  return { db, note: stats.linksNote };
}

describe.skipIf(!HAS_GO)("Go's helper is built once", () => {
  test("the first index of a Go repo builds it into tmb's tools folder under its name and key; the next build runs it, not a new build", async () => {
    const { log } = namedGo();
    const sha = commit(LOOM);
    expect(keys()).toEqual([]);
    const first = await index(sha);
    first.db.close();
    expect(first.note).toBeNull();
    const built = keys();
    expect(built).toHaveLength(1);
    expect(built[0]).toMatch(/^[0-9a-f]{64}$/);
    const binary = binaryOf(built[0]!);
    expect(existsSync(binary)).toBe(true);
    const made = statSync(binary);
    expect(commands(log).filter((c) => c === "build")).toHaveLength(1);

    const second = await index(sha, "c");
    try {
      expect(second.note).toBeNull();
      expect(call(calls(second.db, "c"), "shuttle/shuttle.go:Weave", "knot")).toMatchObject({ dst: "shuttle/spool.go:knot", call_state: "linked" });
    } finally {
      second.db.close();
    }
    expect(keys()).toEqual(built);
    expect(statSync(binary).mtimeMs).toBe(made.mtimeMs);
    expect(statSync(binary).ino).toBe(made.ino);
    expect(commands(log).filter((c) => c === "build")).toHaveLength(1);
  });

  test("the built helper's `go list` runs the `go` that was found, not the one first on PATH", async () => {
    const { log } = namedGo();
    const sha = commit(LOOM);
    const { db, note } = await index(sha);
    db.close();
    expect(note).toBeNull();
    expect(commands(log)).toContain("list");
  });

  test("a helper of another key is removed once the new one is built", async () => {
    namedGo();
    const sha = commit(LOOM);
    const old = "0".repeat(64);
    mkdirSync(path.dirname(binaryOf(old)), { recursive: true });
    writeFileSync(binaryOf(old), "an older helper");
    const { db, note } = await index(sha);
    db.close();
    expect(note).toBeNull();
    const now = keys();
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(old);
    expect(existsSync(path.dirname(binaryOf(old)))).toBe(false);
  });

  test("the key changes with the source, the build's go.mod and recipe, the Go version, and the machine's kind; not with where `go` is", () => {
    const base = { source: "package main\n", goMod: "module m\n\ngo 1.22\n", recipe: "-trimpath", goVersion: "go1.27.4", host: "darwin/arm64" };
    const key = helperKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(helperKey({ ...base })).toBe(key);
    for (const [part, other] of Object.entries({ source: "package main\n\n", goMod: "module m\n\ngo 1.23\n", recipe: "", goVersion: "go1.27.5", host: "linux/arm64" })) {
      expect(helperKey({ ...base, [part]: other })).not.toBe(key);
    }
  });

  test("the build takes none of the user's Go settings: another target system and other flags still build a helper for this machine", async () => {
    const other = process.platform === "linux" ? "windows" : "linux";
    setEnv("GOOS", other);
    // A link flag the linker does not know: honoured, it fails the build. `go list` takes it and ignores it.
    setEnv("GOFLAGS", "-ldflags=-tmbnosuchflag");
    const sha = commit(LOOM);
    const { db, note } = await index(sha);
    try {
      expect(note).toBeNull();
      expect(call(calls(db, "b"), "shuttle/shuttle.go:Weave", "knot")).toMatchObject({ dst: "shuttle/spool.go:knot", call_state: "linked" });
    } finally {
      db.close();
    }
    expect(keys()).toHaveLength(1);
  });

  test("a failed build means the built-in rules for Go, with a note that names the error", async () => {
    namedGo({ build: 'echo "tmb-test: the compiler broke" >&2; exit 2' });
    const sha = commit(LOOM);
    const { db, note } = await index(sha);
    try {
      expect(note).toContain(`go: ${TOOL} cannot run`);
      expect(note).toContain("tmb-test: the compiler broke");
      expect(note).toContain(BUILT_IN_RULES);
      const rows = calls(db, "b");
      // The built-in rules link a name the same file declares, and leave one in another file not known.
      expect(call(rows, "shuttle/shuttle.go:Weave", "thread")).toMatchObject({ dst: "shuttle/shuttle.go:thread", call_state: "linked", way: "built-in" });
      expect(call(rows, "shuttle/shuttle.go:Weave", "knot")).toMatchObject({ dst: null, call_state: "not_known" });
    } finally {
      db.close();
    }
    expect(keys().filter((key) => existsSync(binaryOf(key)))).toEqual([]);
  });
});

describe.skipIf(!HAS_GO)("a package the helper cannot check at all", () => {
  test("a repo that needs a newer Go than the user's: the built-in rules make the links, with a note; never every call not known", async () => {
    const sha = commit({ ...LOOM, "go.mod": GO_MOD("1.999") });
    const { db, note } = await index(sha);
    try {
      expect(note).toContain(`go: ${TOOL} failed`);
      expect(note).toContain("could not check");
      expect(note).toContain(BUILT_IN_RULES);
      expect(call(calls(db, "b"), "shuttle/shuttle.go:Weave", "thread")).toMatchObject({ dst: "shuttle/shuttle.go:thread", call_state: "linked", way: "built-in" });
    } finally {
      db.close();
    }
  });

  test("a package whose Go version is newer than the type checker knows: the built-in rules, with a note naming the package", async () => {
    // A `go list` newer than the helper's go/types: it lists the module at a Go version the type
    // checker does not know yet, as a helper built by an older Go would meet it.
    namedGo({ list: `"${REAL_GO}" "$@" | sed 's/"GoVersion": "1.22"/"GoVersion": "1.999"/'` });
    const sha = commit(LOOM);
    const { db, note } = await index(sha);
    try {
      expect(note).toContain(`go: ${TOOL} failed`);
      expect(note).toContain("could not check example.test/loom/shuttle");
      expect(note).toContain(BUILT_IN_RULES);
      expect(call(calls(db, "b"), "shuttle/shuttle.go:Weave", "knot")).toMatchObject({ dst: null, call_state: "not_known", way: "built-in" });
    } finally {
      db.close();
    }
  });

  test("an ordinary type error is not that case: way B makes the links, and the call with the error is not known", async () => {
    const sha = commit(LOOM);
    const { db, note } = await index(sha);
    try {
      expect(note).toBeNull();
      const rows = calls(db, "b");
      // `thread` takes one argument: the type checker reports an error at this call.
      expect(call(rows, "shuttle/shuttle.go:Tangle", "thread")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(call(rows, "shuttle/shuttle.go:Weave", "knot")).toMatchObject({ dst: "shuttle/spool.go:knot", call_state: "linked" });
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!HAS_GO)("the record and `tmb tools`", () => {
  test("the layer records the user's `go` and the helper: its key, its source and the Go that built it", async () => {
    const sha = commit(LOOM);
    const { db } = await index(sha);
    try {
      const record = JSON.parse(layerRow(db, "b")!.built_with!) as Record<string, { whose: string; path: string; tool: string; helper?: Record<string, string> }>;
      const goVersion = spawnSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).stdout.trim();
      expect(record[TOOL]).toMatchObject({ whose: "user", path: REAL_GO, tool: spawnSync("go", ["version"], { encoding: "utf8" }).stdout.trim() });
      expect(record[TOOL]!.helper).toEqual({ key: keys()[0]!, source: new Bun.CryptoHasher("sha256").update(SOURCE).digest("hex"), builtBy: goVersion });
    } finally {
      db.close();
    }
  });

  test("`tmb tools` lists the helper with Go: not built yet, then built, where it is kept", async () => {
    const before = toolRows(["go"]);
    expect(before[0]).toMatchObject({ language: "go", tool: TOOL, whose: "user", helper: { name: HELPER, built: false } });
    expect(toolLine(before[0]!)).toContain(`helper ${HELPER}`);
    expect(toolLine(before[0]!)).toContain("not built yet");
    const sha = commit(LOOM);
    const { db } = await index(sha);
    db.close();
    const after = toolRows(["go"]);
    expect(after[0]).toMatchObject({ helper: { name: HELPER, built: true, path: binaryOf(keys()[0]!) } });
    expect(toolLine(after[0]!)).toContain(binaryOf(keys()[0]!));
  });
});
