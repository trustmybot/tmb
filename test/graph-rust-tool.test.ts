// Way B for Rust (trustmybot/tmb#354): rust-analyzer, the user's own, makes the links of the graph's
// calls ("Two ways to make links"). Each expectation is read off the page and the Rust Reference
// (https://doc.rust-lang.org/reference/), call by call: the definition a call names by Rust's rules,
// not what the graph happens to return. Way B runs no code of the repo and downloads nothing; a call
// it cannot prove, it leaves not known. The fixture is a small crate of its own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../src/engine/graph/build.ts";
import { layerRow, openGraphDb } from "../src/engine/graph/db.ts";
import { readAnswers, runRustAnalyzer } from "../src/engine/graph/languages/rust/tool.ts";
import { loadParsers } from "../src/engine/graph/loader.ts";
import { referenceCounts, rustReference } from "../tests/benchmark/rust.ts";

setDefaultTimeout(30_000);

const HAS_RUST_ANALYZER = spawnSync("rust-analyzer", ["--version"]).status === 0;

let project: string;
let cargoHome: string;
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
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-rust-analyzer-")));
  git(project, "init", "-q", "-b", "main");
  // An empty Cargo home of the test's own: the crate the repo depends on is not on disk.
  cargoHome = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-cargo-")));
  setEnv("CARGO_HOME", cargoHome);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(project, { recursive: true, force: true });
  rmSync(cargoHome, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const CARGO_TOML = lines(
  "[package]",
  'name = "grove"',
  'version = "0.1.0"',
  'edition = "2021"',
  'build = "build.rs"',
  "",
  "[dependencies]",
  'faraway = "1"',
);

const LIB = lines(
  "pub mod orchard;", //                                         1
  "mod crates;", //                                              2
  "// `cfg(any())` holds for no build, so this file is never compiled (The Rust Reference, \"Conditional compilation\").", // 3
  "#[cfg(any())]", //                                            4
  "mod leftout;", //                                             5
  "pub mod sieve;", //                                           6
);

const ORCHARD = lines(
  "pub trait Fruit {", //                                        1
  "    fn ripen(&self, days: u32) -> bool;", //                  2
  "}", //                                                        3
  "", //                                                         4
  "pub struct Plum {", //                                        5
  "    pub name: String,", //                                    6
  "}", //                                                        7
  "", //                                                         8
  "impl Fruit for Plum {", //                                    9
  "    fn ripen(&self, days: u32) -> bool {", //                 10
  "        days as usize > self.name.len()", //                  11
  "    }", //                                                    12
  "}", //                                                        13
  "", //                                                         14
  "pub struct Kilos(pub u32);", //                               15
  "", //                                                         16
  "impl Kilos {", //                                             17
  "    pub fn zero() -> Self {", //                              18
  "        Self(0)", //                                          19
  "    }", //                                                    20
  "}", //                                                        21
  "", //                                                         22
  "pub enum Crop {", //                                          23
  "    Bushel(u32),", //                                         24
  "    Empty,", //                                               25
  "}", //                                                        26
  "", //                                                         27
  "pub mod inner {", //                                          28
  "    pub fn deep() -> u32 {", //                               29
  "        1", //                                                30
  "    }", //                                                    31
  "}", //                                                        32
  "", //                                                         33
  "pub fn gather(fs: &[&dyn Fruit]) -> u32 {", //                34
  "    let mut n = 0;", //                                       35
  "    for f in fs {", //                                        36
  "        if f.ripen(3) {", //                                  37
  "            n += 1;", //                                      38
  "        }", //                                                39
  "    }", //                                                    40
  '    let p = Plum { name: String::from("x") };', //            41
  "    p.ripen(1);", //                                          42
  "    let w = Kilos(n);", //                                    43
  "    let _c = Crop::Bushel(2);", //                            44
  "    let pluck = || 1;", //                                    45
  "    pluck();", //                                             46
  "    w.0 + crate::crates::stack() + inner::deep()", //         47
  "}", //                                                        48
);

const CRATES = lines(
  "pub fn stack() -> u32 {", //                                  1
  "    slat(2)", //                                              2
  "}", //                                                        3
  "", //                                                         4
  "fn slat(n: u32) -> u32 {", //                                 5
  "    n", //                                                    6
  "}", //                                                        7
  "", //                                                         8
  "pub fn split() -> u32 {", //                                  9
  "    slat(1, 2)", //                                           10
  "}", //                                                        11
  "", //                                                         12
  "pub fn r#yield() -> u32 {", //                                13
  "    1", //                                                    14
  "}", //                                                        15
  "", //                                                         16
  "pub fn lift() -> u32 {", //                                   17
  "    r#yield() + crate::crates::r#yield()", //                 18
  "}", //                                                        19
);

const LEFT_OUT = lines(
  "fn unused() -> u32 {", //                                     1
  "    near()", //                                               2
  "}", //                                                        3
  "", //                                                         4
  "fn near() -> u32 {", //                                       5
  "    1", //                                                    6
  "}", //                                                        7
);

// Calls written in a macro's input (CODE_GRAPH.md, "Inside a macro, the tool says what is a call").
// The parser sees tokens there; rust-analyzer expands the macro and says what each name is.
const SIEVE = lines(
  "macro_rules! both {", //                                      1
  "    ($a:expr, $b:expr) => {", //                              2
  "        $a + $b", //                                          3
  "    };", //                                                   4
  "}", //                                                        5
  "", //                                                         6
  "macro_rules! named {", //                                     7
  "    ($f:ident) => {", //                                      8
  "        $f()", //                                             9
  "    };", //                                                   10
  "}", //                                                        11
  "", //                                                         12
  "pub struct Grain(pub u32);", //                               13
  "", //                                                         14
  "pub fn weigh(n: u32) -> u32 {", //                            15
  "    n", //                                                    16
  "}", //                                                        17
  "", //                                                         18
  "pub fn tare() -> u32 {", //                                   19
  "    0", //                                                    20
  "}", //                                                        21
  "", //                                                         22
  "pub fn sift(xs: Vec<u32>) -> u32 {", //                       23
  "    let a = both!(weigh(1), tare());", //                     24
  "    assert_eq!(weigh(2), xs.len() as u32);", //               25
  "    let g = vec![Grain(3)];", //                              26
  "    let b = named!(tare);", //                                27
  "    assert!(matches!(Some(1), Some(_)));", //                 28
  "    let s = stringify!(weigh(9));", //                        29
  "    let each = |x: u32| format!(\"{}\", weigh(x));", //        30
  "    let w = vec![format!(\"{}\", tare())];", //                31
  "    assert_eq!(weigh(1, 2), 0);", //                          32
  "    a + b + g.len() as u32 + s.len() as u32 + each(1).len() as u32 + w.len() as u32", // 33
  "}", //                                                        34
  "", //                                                         35
  "macro_rules! make {", //                                      36
  "    ($v:expr) => {", //                                       37
  "        pub fn made() -> u32 {", //                           38
  "            $v", //                                           39
  "        }", //                                                40
  "    };", //                                                   41
  "}", //                                                        42
  "", //                                                         43
  "make!(tare());", //                                           44
  "", //                                                         45
  "pub struct Bran;", //                                         46
  "impl Bran {", //                                              47
  "    pub fn default() -> u32 {", //                            48
  "        1", //                                                49
  "    }", //                                                    50
  "}", //                                                        51
  "", //                                                         52
  "pub fn chaff() -> u32 {", //                                  53
  "    assert_eq!(Bran::default(), 1);", //                      54
  "    0", //                                                    55
  "}", //                                                        56
);

const MAIN = lines(
  "fn main() {", //                                              1
  "    grove::orchard::gather(&[]);", //                         2
  "    faraway::away();", //                                     3
  "}", //                                                        4
);

/** A build script that would leave a file behind if it ran. */
const buildScript = (marker: string): string => lines(`fn main() { std::fs::write(${JSON.stringify(marker)}, "ran").unwrap(); }`);

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
    "Cargo.toml": CARGO_TOML,
    "build.rs": buildScript(marker()),
    "src/lib.rs": LIB,
    "src/orchard.rs": ORCHARD,
    "src/crates.rs": CRATES,
    "src/leftout.rs": LEFT_OUT,
    "src/sieve.rs": SIEVE,
    "src/main.rs": MAIN,
  });
  const db = openGraphDb(project, null);
  const stats = await buildLayer(db, project, sha, "b", { force: true, links });
  return { db, note: stats.linksNote };
}

const GATHER = "src/orchard.rs:gather";

describe.skipIf(!HAS_RUST_ANALYZER)("way B for Rust", () => {
  test("a call links to the definition rust-analyzer names: in another file, in another crate of the package, a method through a value, through a trait object, and a function of a module by its path", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      expect(call(rows, GATHER, "stack")).toMatchObject({ dst: "src/crates.rs:stack", call_state: "linked" });
      expect(call(rows, "src/main.rs:main", "gather")).toMatchObject({ dst: GATHER, call_state: "linked" });
      expect(call(rows, GATHER, "ripen", 42)).toMatchObject({ dst: "src/orchard.rs:Plum.ripen", call_state: "linked" });
      // Through `dyn Fruit`, the call names the trait's method, a declaration with no body: a node.
      expect(call(rows, GATHER, "ripen", 37)).toMatchObject({ dst: "src/orchard.rs:Fruit.ripen", call_state: "linked" });
      expect(call(rows, GATHER, "deep")).toMatchObject({ dst: "src/orchard.rs:inner.deep", call_state: "linked" });
      expect(call(rows, "src/crates.rs:stack", "slat")).toMatchObject({ dst: "src/crates.rs:slat", call_state: "linked" });
      // A raw identifier, `r#yield`, is the name `yield` (The Rust Reference, "Identifiers"): both
      // calls link to the function it names, by its bare name and by its path.
      const lift = rows.filter((r) => r.src === "src/crates.rs:lift");
      expect(lift).toHaveLength(2);
      const target = db.query("SELECT path || ':' || qualified_name AS dst FROM symbols WHERE layer = 'b' AND path = 'src/crates.rs' AND start_line = 13").get() as { dst: string };
      for (const r of lift) expect(r).toMatchObject({ dst: target.dst, call_state: "linked" });
    } finally {
      db.close();
    }
  });

  test("a tuple struct's constructor and an enum's variant link to their type; the standard library is outside", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      expect(call(rows, GATHER, "Kilos")).toMatchObject({ dst: "src/orchard.rs:Kilos", call_state: "linked" });
      expect(call(rows, GATHER, "Bushel")).toMatchObject({ dst: "src/orchard.rs:Crop", call_state: "linked" });
      expect(call(rows, GATHER, "from")).toMatchObject({ dst: null, call_state: "outside" });
      expect(call(rows, "src/orchard.rs:Plum.ripen", "len")).toMatchObject({ dst: null, call_state: "outside" });
    } finally {
      db.close();
    }
  });

  test("a local, a call rust-analyzer reports an error in, a file `cfg` leaves out, and a crate not on disk are not known", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      expect(call(rows, GATHER, "pluck")).toMatchObject({ dst: null, call_state: "not_known" });
      // rust-analyzer answers `Self(0)` with the implementation, which declares no node; it names no
      // type for it, so the call is not known ("The tool's answer stands").
      expect(call(rows, "src/orchard.rs:Kilos.zero", "Self")).toMatchObject({ dst: null, call_state: "not_known" });
      // `slat` takes one argument: rust-analyzer reports an error in this call, so its answer is no answer.
      expect(call(rows, "src/crates.rs:split", "slat")).toMatchObject({ dst: null, call_state: "not_known" });
      // `cfg(any())` leaves leftout.rs out of every build, so no call in it is proven.
      expect(call(rows, "src/leftout.rs:unused", "near")).toMatchObject({ dst: null, call_state: "not_known" });
      // The crate `faraway` is a dependency, not on disk, and nothing is downloaded.
      expect(call(rows, "src/main.rs:main", "away")).toMatchObject({ dst: null, call_state: "not_known" });
    } finally {
      db.close();
    }
  });

  test("way B runs no code of the repo and downloads nothing", async () => {
    const { db, note } = await built();
    db.close();
    expect(note).toBeNull();
    expect(existsSync(marker())).toBe(false);
    // Cargo's home holds no crate it fetched.
    const fetched = ["registry/cache", "registry/src", "git/db"].filter((dir) => existsSync(path.join(cargoHome, dir)) && readdirSync(path.join(cargoHome, dir)).length > 0);
    expect(fetched).toEqual([]);
  });

  test("the same files read by the built-in rules leave a call through a path not known, and link one in a file `cfg` leaves out", async () => {
    const { db } = await built("built-in");
    try {
      const rows = calls(db, "b");
      expect(call(rows, GATHER, "stack")).toMatchObject({ dst: null, call_state: "not_known" });
      expect(call(rows, "src/leftout.rs:unused", "near")).toMatchObject({ dst: "src/leftout.rs:near", call_state: "linked" });
    } finally {
      db.close();
    }
  });
});

const SIEVE_FILE = "src/sieve.rs";
const SIFT = `${SIEVE_FILE}:sift`;
const WEIGH = `${SIEVE_FILE}:weigh`;
const TARE = `${SIEVE_FILE}:tare`;

/** The calls of src/sieve.rs on a line, as `name state`. */
const onLine = (rows: CallRow[], line: number): string[] =>
  rows.filter((r) => r.src.startsWith(`${SIEVE_FILE}:`) && r.line === line).map((r) => `${r.dst_name} ${r.call_state}`);

// CODE_GRAPH.md, "Inside a macro, the tool says what is a call": the parser cannot see into a
// macro's input; way B asks the tool about each name there, and a name the tool does not answer as
// a call is dropped. A name written as a call there (the name, then a parenthesized group: The Rust
// Reference, "Call expressions" and "Method-call expressions") is a call when rust-analyzer says the
// name is a function or a method. A tuple struct or a variant is written the same way in a pattern
// (`matches!(x, Some(_))`), so the tool's answer does not make it a call.
describe.skipIf(!HAS_RUST_ANALYZER)("way B for Rust: a call in a macro's input", () => {
  test("a function or a method written as a call in a macro's input is a call, linked or outside as the tool answers, in the function the macro is written in", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      expect(call(rows, SIFT, "weigh", 24)).toMatchObject({ dst: WEIGH, call_state: "linked" });
      expect(call(rows, SIFT, "tare", 24)).toMatchObject({ dst: TARE, call_state: "linked" });
      expect(call(rows, SIFT, "weigh", 25)).toMatchObject({ dst: WEIGH, call_state: "linked" });
      expect(call(rows, SIFT, "len", 25)).toMatchObject({ dst: null, call_state: "outside" });
      // A macro in a macro's input: `format!` inside `vec!`.
      expect(call(rows, SIFT, "tare", 31)).toMatchObject({ dst: TARE, call_state: "linked" });
      // A weak keyword is a name (The Rust Reference, "Keywords"): `default` is no strict keyword.
      expect(call(rows, `${SIEVE_FILE}:chaff`, "default", 54)).toMatchObject({ dst: `${SIEVE_FILE}:Bran.default`, call_state: "linked" });
    } finally {
      db.close();
    }
  });

  test("a call in a macro's input belongs to the nearest callable around the macro: a closure, else the file", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      expect(call(rows, `${SIEVE_FILE}:function at line 30`, "weigh", 30)).toMatchObject({ dst: WEIGH, call_state: "linked" });
      expect(call(rows, `${SIEVE_FILE}:${SIEVE_FILE}`, "tare", 44)).toMatchObject({ dst: TARE, call_state: "linked" });
    } finally {
      db.close();
    }
  });

  test("a name the tool does not answer as a call is dropped: a tuple struct or a variant, a name not written as a call, a name the macro does not make code of", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      expect(onLine(rows, 26)).toEqual([]);
      expect(onLine(rows, 27)).toEqual([]);
      expect(onLine(rows, 28)).toEqual([]);
      expect(onLine(rows, 29)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a call in a macro's input that rust-analyzer reports an error in is not known", async () => {
    const { db } = await built();
    try {
      expect(call(calls(db, "b"), SIFT, "weigh", 32)).toMatchObject({ dst: null, call_state: "not_known" });
    } finally {
      db.close();
    }
  });

  // CODE_GRAPH.md, Benchmark: calls accounted for, "linked plus outside plus not known equals the
  // calls the compiler finds", counts the calls in a macro's input the tool answers as calls.
  test("the benchmark's reference counts the calls in a macro's input the tool answers as calls, in their functions, and way B has each one", async () => {
    const { db } = await built();
    try {
      const texts = new Map<string, string>();
      for (const file of git(project, "ls-files", "*.rs").split("\n")) texts.set(file, readFileSync(path.join(project, file), "utf8"));
      const parser = (await loadParsers(["rust"])).get("rust")!;
      const ra = runRustAnalyzer({ files: texts, configs: new Map(), read: (file) => (file === "Cargo.toml" ? CARGO_TOML : undefined) });
      const answers = readAnswers(texts, ra, parser);
      try {
        const want = referenceCounts(rustReference(texts), answers).calls;
        // sift's own: `each`, `len` four times on line 33; in macros, `weigh` and `tare` on 24,
        // `weigh` and `len` on 25, `tare` on 31, `weigh` on 32.
        expect(want.get(`${SIEVE_FILE}:23-34`)).toBe(11);
        // `Bran::default()` in `assert_eq!`.
        expect(want.get(`${SIEVE_FILE}:53-56`)).toBe(1);
        expect(want.get(`${SIEVE_FILE}:30-30`)).toBe(1);
        expect(want.get(`${SIEVE_FILE}:`)).toBe(1);
        const rows = db
          .query("SELECT s.path AS path, s.kind AS kind, s.start_line AS start, s.end_line AS end FROM edges e JOIN symbols s ON s.id = e.src_id WHERE e.layer = 'b' AND e.call_state IS NOT NULL")
          .all() as { path: string; kind: string; start: number; end: number }[];
        const graph = new Map<string, number>();
        for (const r of rows) {
          const key = `${r.path}:${r.kind === "function" || r.kind === "method" ? `${r.start}-${r.end}` : ""}`;
          graph.set(key, (graph.get(key) ?? 0) + 1);
        }
        expect(Object.fromEntries(graph)).toEqual(Object.fromEntries(want));
      } finally {
        answers.close();
      }
    } finally {
      db.close();
    }
  });

});

// CODE_GRAPH.md, "Inside a macro, the tool says what is a call", edge cases 1 and 2: the built-in
// rules have no tool to ask, so each name in a macro's input followed by a group in parentheses is
// a call that is not known, with no link, in the callable around the macro. A tuple struct or a
// variant written so is one more such call. `default` is a name; `named!(tare)` writes no call.
test("the built-in rules keep each name written as a call in a macro's input as a call that is not known, with no link", async () => {
  const { db } = await built("built-in");
  try {
    const rows = calls(db, "b");
    const notKnown = (src: string, name: string, line: number) => expect(call(rows, src, name, line)).toMatchObject({ dst: null, call_state: "not_known" });
    notKnown(SIFT, "weigh", 24);
    notKnown(SIFT, "tare", 24);
    notKnown(SIFT, "weigh", 25);
    notKnown(SIFT, "len", 25);
    notKnown(SIFT, "Grain", 26);
    notKnown(SIFT, "weigh", 29);
    notKnown(`${SIEVE_FILE}:function at line 30`, "weigh", 30);
    notKnown(SIFT, "tare", 31);
    notKnown(SIFT, "weigh", 32);
    notKnown(`${SIEVE_FILE}:${SIEVE_FILE}`, "tare", 44);
    notKnown(`${SIEVE_FILE}:chaff`, "default", 54);
    expect(onLine(rows, 27)).toEqual([]);
    // `Some` twice on line 28: `Some(1)` and `Some(_)`.
    expect(onLine(rows, 28)).toEqual(["Some not_known", "Some not_known"]);
  } finally {
    db.close();
  }
});

test("without rust-analyzer on PATH, way B for Rust does not run: the built-in rules make the links, and the layer names what is missing", async () => {
  const empty = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-nopath-")));
  try {
    // A PATH that holds git alone: the graph reads the commit through it.
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, path.join(empty, "git"));
    const sha = commit({ "Cargo.toml": CARGO_TOML, "src/crates.rs": CRATES });
    setEnv("PATH", empty);
    // Cargo's home holds no rustup copy either.
    setEnv("CARGO_HOME", empty);
    const db = openGraphDb(project, null);
    try {
      const stats = await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
      expect(stats.linksNote).toContain("rust: rust-analyzer cannot run (rust-analyzer is missing: no `rust-analyzer` on PATH or in ");
      expect(stats.linksNote).toContain(" or in tmb's tools folder; `tmb tools install` installs it), so the built-in rules");
      expect(layerRow(db, "b")?.links_note).toBe(stats.linksNote);
      expect(call(calls(db, "b"), "src/crates.rs:stack", "slat")).toMatchObject({ dst: "src/crates.rs:slat", call_state: "linked" });
    } finally {
      db.close();
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
