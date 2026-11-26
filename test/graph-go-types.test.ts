// Way B for Go (trustmybot/tmb#352): Go's own type checker, go/types, run by the helper tmb carries
// with the user's own `go`, makes the links of the graph's calls ("Two ways to make links"). Each
// expectation is read off the page and the Go spec (https://go.dev/ref/spec), call by call: the
// declaration a call names by Go's rules, not what the graph happens to return. Way B runs no code
// of the repo and downloads nothing; a call it cannot prove, it leaves not known. The fixture is a
// small program of its own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../src/engine/graph/build.ts";
import { layerRow, openGraphDb } from "../src/engine/graph/db.ts";

setDefaultTimeout(30_000);

const HAS_GO = spawnSync("go", ["version"]).status === 0;

let project: string;
let modules: string;
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
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-gotypes-")));
  git(project, "init", "-q", "-b", "main");
  // An empty module cache of the test's own: a module the repo needs is not on disk.
  modules = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-gomods-")));
  setEnv("GOMODCACHE", modules);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(modules, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const GO_MOD = lines("module example.test/grove", "", "go 1.22", "", "require example.test/faraway v1.0.0");

const ORCHARD = lines(
  "package orchard", //                                          1
  "", //                                                         2
  'import "strings"', //                                         3
  "", //                                                         4
  "// Fruit is what a tree bears.", //                           5
  "type Fruit interface {", //                                   6
  "\tRipen(days int) bool", //                                   7
  "}", //                                                        8
  "", //                                                         9
  "type Plum struct{ name string }", //                          10
  "", //                                                         11
  "func (p *Plum) Ripen(days int) bool { return days > len(p.name) }", // 12
  "", //                                                         13
  "type Kilos int", //                                           14
  "", //                                                         15
  "func Gather(fs []Fruit) int {", //                            16
  "\tn := 0", //                                                 17
  "\tfor _, f := range fs {", //                                 18
  "\t\tif f.Ripen(3) {", //                                      19
  "\t\t\tn++", //                                                20
  "\t\t}", //                                                    21
  "\t}", //                                                      22
  '\tp := &Plum{name: strings.ToUpper("x")}', //                 23
  "\tp.Ripen(1)", //                                             24
  "\tw := Kilos(n)", //                                          25
  "\tpluck := func() int { return 1 }", //                       26
  "\tpluck()", //                                                27
  "\treturn int(w) + crate()", //                                28
  "}", //                                                        29
);

const CRATES = lines(
  "package orchard", //                                          1
  "", //                                                         2
  "func crate() int { return slat(2) }", //                      3
  "", //                                                         4
  "func slat(n int) int { return n }", //                        5
  "", //                                                         6
  "func split() int { return slat(1, 2) }", //                   7
);

const LEFT_OUT = lines(
  "//go:build ignore", //                                        1
  "", //                                                         2
  "package orchard", //                                          3
  "", //                                                         4
  "func unused() int { return near() }", //                      5
  "", //                                                         6
  "func near() int { return 1 }", //                             7
);

// An interface whose method shares its name: the call names the method, which sits inside the type.
const EASEL = lines(
  "package easel", //                                            1
  "", //                                                         2
  "type Brush interface {", //                                   3
  "\tBrush() string", //                                        4
  "}", //                                                        5
  "", //                                                         6
  "func Stroke(b Brush) string { return b.Brush() }", //         7
);

/** A program that would leave a file behind if any code of the repo ran. */
const press = (marker: string): string =>
  lines(
    "package main", //                                           1
    "", //                                                       2
    "import (", //                                               3
    '\t"os"', //                                                 4
    "", //                                                       5
    '\t"example.test/faraway/far"', //                           6
    '\t"example.test/grove/orchard"', //                         7
    ")", //                                                      8
    "", //                                                       9
    `func init() { os.WriteFile(${JSON.stringify(marker)}, nil, 0o644) }`, // 10
    "", //                                                       11
    "func main() {", //                                          12
    "\torchard.Gather(nil)", //                                  13
    "\tfar.Away()", //                                           14
    "}", //                                                      15
  );

type CallRow = { src: string; dst_name: string; line: number; dst: string | null; call_state: string };

function calls(db: Database, layer: string): CallRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name, e.line, d.path || ':' || d.qualified_name AS dst, e.call_state
         FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
        WHERE e.layer = ? AND e.call_state IS NOT NULL ORDER BY e.pos`,
    )
    .all(layer) as CallRow[];
}

/** The one call named `name` that `src` makes, on `line` when given. */
function call(rows: CallRow[], src: string, name: string, line?: number): CallRow {
  const found = rows.filter((r) => r.src === src && r.dst_name === name && (line === undefined || r.line === line));
  if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}`);
  return found[0]!;
}

const marker = () => path.join(project, "ran.txt");

async function built(links: "language-tool" | "built-in" = "language-tool"): Promise<{ db: Database; note: string | null }> {
  const sha = commit({
    "go.mod": GO_MOD,
    "orchard/orchard.go": ORCHARD,
    "orchard/crates.go": CRATES,
    "orchard/leftout.go": LEFT_OUT,
    "easel/easel.go": EASEL,
    "cmd/press/main.go": press(marker()),
  });
  const db = openGraphDb(project, null);
  const stats = await buildLayer(db, project, sha, "b", { force: true, links });
  return { db, note: stats.linksNote };
}

describe.skipIf(!HAS_GO)("way B for Go", () => {
  test("a call links to the declaration Go's type checker names: in another file, in another package, a method through a value or through an interface", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      const gather = "orchard/orchard.go:Gather";
      expect(call(rows, gather, "crate")).toMatchObject({ dst: "orchard/crates.go:crate", call_state: "linked" });
      expect(call(rows, "cmd/press/main.go:main", "Gather")).toMatchObject({ dst: "orchard/orchard.go:Gather", call_state: "linked" });
      expect(call(rows, gather, "Ripen", 24)).toMatchObject({ dst: "orchard/orchard.go:Plum.Ripen", call_state: "linked" });
      expect(call(rows, gather, "Ripen", 19)).toMatchObject({ dst: "orchard/orchard.go:Fruit.Ripen", call_state: "linked" });
      expect(call(rows, "orchard/crates.go:crate", "slat")).toMatchObject({ dst: "orchard/crates.go:slat", call_state: "linked" });
    } finally {
      db.close();
    }
  });

  test("a call of an interface's method links to the method, not to the type around it of the same name", async () => {
    const { db } = await built();
    try {
      expect(call(calls(db, "b"), "easel/easel.go:Stroke", "Brush")).toMatchObject({ dst: "easel/easel.go:Brush.Brush", call_state: "linked" });
    } finally {
      db.close();
    }
  });

  test("a conversion links to its type; a predeclared name and the standard library are outside", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      const gather = "orchard/orchard.go:Gather";
      expect(call(rows, gather, "Kilos")).toMatchObject({ dst: "orchard/orchard.go:Kilos", call_state: "linked" });
      expect(call(rows, gather, "int")).toMatchObject({ dst: null, call_state: "outside" });
      expect(call(rows, gather, "ToUpper")).toMatchObject({ dst: null, call_state: "outside" });
      expect(call(rows, "orchard/orchard.go:Plum.Ripen", "len")).toMatchObject({ dst: null, call_state: "outside" });
      expect(call(rows, "cmd/press/main.go:init", "WriteFile")).toMatchObject({ dst: null, call_state: "outside" });
    } finally {
      db.close();
    }
  });

  test("a local, a call the type checker reports an error in, a file the build leaves out, and a module not on disk are not known", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      expect(call(rows, "orchard/orchard.go:Gather", "pluck")).toMatchObject({ dst: null, call_state: "not_known" });
      // `slat` takes one argument: Go's type checker reports an error at this call, so its answer is no answer.
      expect(call(rows, "orchard/crates.go:split", "slat")).toMatchObject({ dst: null, call_state: "not_known" });
      // A file `//go:build ignore` leaves out of every build is not loaded, so no call in it is proven.
      expect(call(rows, "orchard/leftout.go:unused", "near")).toMatchObject({ dst: null, call_state: "not_known" });
      // example.test/faraway is required but not in the module cache, and nothing is downloaded.
      expect(call(rows, "cmd/press/main.go:main", "Away")).toMatchObject({ dst: null, call_state: "not_known" });
    } finally {
      db.close();
    }
  });

  test("way B runs no code of the repo and downloads nothing", async () => {
    const { db, note } = await built();
    db.close();
    expect(note).toBeNull();
    expect(existsSync(marker())).toBe(false);
    expect(readdirSync(modules).filter((f) => f !== "cache")).toEqual([]);
  });

  test("the same file read by the built-in rules leaves a call in another file not known, and links one in a file the build leaves out", async () => {
    const { db } = await built("built-in");
    try {
      const rows = calls(db, "b");
      expect(call(rows, "orchard/orchard.go:Gather", "crate")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(call(rows, "orchard/leftout.go:unused", "near")).toMatchObject({ dst: "orchard/leftout.go:near", call_state: "linked" });
    } finally {
      db.close();
    }
  });
});

test("without `go` on PATH, way B for Go does not run: the built-in rules make the links, and the layer names what is missing", async () => {
  const empty = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-nopath-")));
  try {
    // A PATH that holds git alone: the graph reads the commit through it.
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, path.join(empty, "git"));
    const sha = commit({ "go.mod": GO_MOD, "orchard/crates.go": CRATES });
    setEnv("PATH", empty);
    const db = openGraphDb(project, null);
    try {
      const stats = await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
      expect(stats.linksNote).toContain("go: Go's type checker (go/types) cannot run (the `go` command is missing: no `go` on PATH), so the built-in rules");
      expect(layerRow(db, "b")?.links_note).toBe(stats.linksNote);
      const rows = calls(db, "b");
      expect(call(rows, "orchard/crates.go:crate", "slat")).toMatchObject({ dst: "orchard/crates.go:slat", call_state: "linked" });
    } finally {
      db.close();
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
