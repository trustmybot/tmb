// Way B for Java (trustmybot/tmb#353): javac, run from the user's JDK by the small adapter tmb
// carries, makes the links of the graph's calls ("Two ways to make links"). Each expectation is read
// off the page and the Java Language Specification (Java SE 21), call by call: the declaration a call
// names by Java's rules, not what the graph happens to return. Way B runs no code of the repo and
// downloads nothing; a call whose answer rests on an error, or that javac cannot answer, is not
// known. The fixture is a small program of its own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../src/engine/graph/build.ts";
import { layerRow, openGraphDb } from "../src/engine/graph/db.ts";

setDefaultTimeout(30_000);

const HAS_JAVA = spawnSync("java", ["-version"]).status === 0;

let project: string;
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
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-javac-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(project, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const MAIN = "src/main/java";

// Two methods of one name: javac chooses by the arguments' types (JLS 15.12.2).
const CRATE = lines(
  "package harbor.dock;", //                                         1
  "", //                                                             2
  "public class Crate {", //                                         3
  "  public Crate() {}", //                                          4
  "", //                                                             5
  "  public Crate(int size) { this(); }", //                         6
  "", //                                                             7
  "  public int load(int tons) { return tons; }", //                 8
  "", //                                                             9
  "  public String load(String cargo) { return cargo; }", //         10
  "", //                                                             11
  "  public static Crate build() { return new Crate(3); }", //       12
  "}", //                                                            13
);

// Text that is not ASCII, one character of it outside the Basic Multilingual Plane, before the
// calls: a call's position counts UTF-16 units in both ways.
const PALLET = lines(
  "package harbor.dock;", //                                         1
  "", //                                                             2
  "// Palétte 🚢: a crate on a wooden frame.", //                    3
  "public class Pallet extends Crate {", //                          4
  "  public Pallet() { super(2); }", //                              5
  "", //                                                             6
  '  int stack() { return load(4) + load("tea").length(); }', //     7
  "", //                                                             8
  "  int tip() { return load(true); }", //                           9
  "", //                                                             10
  "  int wrap(Tarp t) { return load(t); }", //                       11
  "}", //                                                            12
);

// A member class whose superclass is missing: what that superclass declares is not known.
const DEPOT = lines(
  "package harbor.dock;", //                                         1
  "", //                                                             2
  "import faraway.Awning;", //                                       3
  "", //                                                             4
  "public class Depot {", //                                         5
  "  void sweep() {}", //                                            6
  "", //                                                             7
  "  class Bay extends Awning {", //                                 8
  "    void open() { sweep(); }", //                                 9
  "  }", //                                                          10
  "", //                                                             11
  "  void close() { sweep(); }", //                                  12
  "}", //                                                            13
);

/** A class whose static initializer would leave a file behind if any code of the repo ran. */
const rope = (marker: string): string =>
  lines(
    "package harbor.dock;", //                                       1
    "", //                                                           2
    "public class Rope {", //                                        3
    `  static { new java.io.File(${JSON.stringify(marker)}).mkdirs(); }`, // 4
    "", //                                                           5
    "  public void coil() {}", //                                    6
    "}", //                                                          7
  );

// An import javac cannot find, of a name a type of the package also has: the import names the type
// throughout the file (JLS 6.4.1), so the package's own type is not what the file means.
const QUAY = lines(
  "package harbor.dock;", //                                         1
  "", //                                                             2
  "import faraway.Rope;", //                                         3
  "", //                                                             4
  "class Quay {", //                                                 5
  "  void moor() { new Rope().coil(); }", //                         6
  "}", //                                                            7
);

const HATCH = lines(
  "package harbor.dock;", //                                         1
  "", //                                                             2
  "public class Hatch {", //                                         3
  "  public void shut() { latch(); }", //                            4
  "", //                                                             5
  "  void latch() {}", //                                            6
  "}", //                                                            7
);

const LIFTER = lines(
  "package harbor.crane;", //                                        1
  "", //                                                             2
  "public interface Lifter {", //                                    3
  "  int lift();", //                                                4
  "}", //                                                            5
);

const CRANE = lines(
  "package harbor.crane;", //                                        1
  "", //                                                             2
  "public class Crane implements Lifter {", //                       3
  "  public int lift() { return 2; }", //                            4
  "}", //                                                            5
);

const CAPTAIN = lines(
  "package harbor;", //                                              1
  "", //                                                             2
  "import harbor.crane.Crane;", //                                   3
  "import harbor.crane.Lifter;", //                                  4
  "import harbor.dock.Crate;", //                                    5
  "", //                                                             6
  "public class Captain {", //                                       7
  "  enum Tide { HIGH, LOW }", //                                    8
  "", //                                                             9
  "  record Berth(int depth) {}", //                                 10
  "", //                                                             11
  "  int sail() {", //                                               12
  "    Lifter l = new Crane();", //                                  13
  "    int n = l.lift() + Crate.build().load(1);", //                14
  "    Lifter quick = new Lifter() { public int lift() { return 1; } };", // 15
  "    n += quick.lift() + Tide.values().length + new Berth(2).depth();", // 16
  "    n += Math.max(n, 3);", //                                     17
  "    System.out.println(String.valueOf(n));", //                   18
  "    return n + faraway.Charts.read();", //                        19
  "  }", //                                                          20
  "}", //                                                            21
);

// A static import javac cannot find: a method found through another static import may be an
// overload of one it would have named (JLS 6.4.1, 15.12.1).
const DECK = lines(
  "package harbor;", //                                              1
  "", //                                                             2
  "import static faraway.Knots.*;", //                               3
  "import static harbor.dock.Crate.build;", //                       4
  "", //                                                             5
  "import harbor.dock.Hatch;", //                                    6
  "", //                                                             7
  "class Deck {", //                                                 8
  "  void batten() { new Hatch().shut(); build(); }", //             9
  "}", //                                                            10
);

type CallRow = { src: string; dst_name: string; line: number; dst: string | null; call_state: string };

function calls(db: Database, layer: string): CallRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name, e.line, d.path || ':' || d.qualified_name || '@' || d.start_line AS dst, e.call_state
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

const marker = () => path.join(project, "ran");

const dock = (file: string) => `${MAIN}/harbor/dock/${file}`;
const crane = (file: string) => `${MAIN}/harbor/crane/${file}`;
const top = (file: string) => `${MAIN}/harbor/${file}`;

async function built(links: "language-tool" | "built-in" = "language-tool"): Promise<{ db: Database; note: string | null }> {
  const sha = commit({
    [dock("Crate.java")]: CRATE,
    [dock("Pallet.java")]: PALLET,
    [dock("Depot.java")]: DEPOT,
    [dock("Rope.java")]: rope(marker()),
    [dock("Quay.java")]: QUAY,
    [dock("Hatch.java")]: HATCH,
    // The same class again, as a release-specific copy: two files declare harbor.dock.Hatch.
    ["src/main/java9/harbor/dock/Hatch.java"]: HATCH,
    [crane("Lifter.java")]: LIFTER,
    [crane("Crane.java")]: CRANE,
    [top("Captain.java")]: CAPTAIN,
    [top("Deck.java")]: DECK,
    // A module declaration that requires a module no file declares.
    ["src/main/java11/module-info.java"]: lines("module harbor {", "  requires faraway.lib;", "}"),
  });
  const db = openGraphDb(project, null);
  const stats = await buildLayer(db, project, sha, "b", { force: true, links });
  return { db, note: stats.linksNote };
}

const linked = (dst: string) => ({ dst, call_state: "linked" });
const outside = { dst: null, call_state: "outside" };
const notKnown = { dst: null, call_state: "not_known" };

describe.skipIf(!HAS_JAVA)("way B for Java", () => {
  test("a call links to the method javac names: an overload by its arguments' types, an inherited method, a method in another file and package, an interface's method through a value", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      const stack = `${dock("Pallet.java")}:Pallet.stack`;
      const loads = rows.filter((r) => r.src === stack && r.dst_name === "load");
      expect(loads.map((r) => r.dst)).toEqual([`${dock("Crate.java")}:Crate.load@8`, `${dock("Crate.java")}:Crate.load@10`]);
      const sail = `${top("Captain.java")}:Captain.sail`;
      expect(call(rows, sail, "build")).toMatchObject(linked(`${dock("Crate.java")}:Crate.build@12`));
      expect(call(rows, sail, "load")).toMatchObject(linked(`${dock("Crate.java")}:Crate.load@8`));
      expect(call(rows, sail, "lift", 14)).toMatchObject(linked(`${crane("Lifter.java")}:Lifter.lift@4`));
      expect(call(rows, sail, "lift", 16)).toMatchObject(linked(`${crane("Lifter.java")}:Lifter.lift@4`));
      expect(call(rows, `${dock("Depot.java")}:Depot.close`, "sweep")).toMatchObject(linked(`${dock("Depot.java")}:Depot.sweep@6`));
    } finally {
      db.close();
    }
  });

  test("a construction, `this(…)` and `super(…)` link to the class; a record's construction to the record", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      const sail = `${top("Captain.java")}:Captain.sail`;
      expect(call(rows, sail, "Crane")).toMatchObject(linked(`${crane("Crane.java")}:Crane@3`));
      expect(call(rows, sail, "Berth")).toMatchObject(linked(`${top("Captain.java")}:Captain.Berth@10`));
      expect(call(rows, `${dock("Crate.java")}:Crate.build`, "Crate")).toMatchObject(linked(`${dock("Crate.java")}:Crate@3`));
      expect(rows.filter((r) => r.dst_name === "this").map((r) => [r.src, r.call_state, r.dst])).toEqual([[`${dock("Crate.java")}:Crate.Crate`, "linked", `${dock("Crate.java")}:Crate@3`]]);
      expect(call(rows, `${dock("Pallet.java")}:Pallet.Pallet`, "super")).toMatchObject(linked(`${dock("Crate.java")}:Crate@3`));
    } finally {
      db.close();
    }
  });

  test("a call javac answers with a declaration outside the repo, the JDK's, is outside", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      const sail = `${top("Captain.java")}:Captain.sail`;
      expect(call(rows, sail, "max")).toMatchObject(outside);
      expect(call(rows, sail, "println")).toMatchObject(outside);
      expect(call(rows, sail, "valueOf")).toMatchObject(outside);
      expect(call(rows, `${dock("Pallet.java")}:Pallet.stack`, "length")).toMatchObject(outside);
    } finally {
      db.close();
    }
  });

  test("a member the language declares, an anonymous class, and a class no file declares are not known", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      const sail = `${top("Captain.java")}:Captain.sail`;
      // An enum's `values` and a record's accessor have no declaration in the file (JLS 8.9.3, 8.10.3).
      expect(call(rows, sail, "values")).toMatchObject(notKnown);
      expect(call(rows, sail, "depth")).toMatchObject(notKnown);
      // `new Lifter() { … }` creates a class with no name, which is no node.
      expect(call(rows, sail, "Lifter")).toMatchObject(notKnown);
      // faraway.Charts is in no file and not in the JDK, and nothing is downloaded.
      expect(call(rows, sail, "read")).toMatchObject(notKnown);
    } finally {
      db.close();
    }
  });

  test("a call whose answer rests on an error is not known: an error at the call, an argument of a missing type, a superclass that is missing, an import javac cannot find", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      // No `load` takes a boolean: javac reports an error at the call.
      expect(call(rows, `${dock("Pallet.java")}:Pallet.tip`, "load")).toMatchObject(notKnown);
      // `Tarp` is no type javac finds, so which `load` the call chooses is not proven.
      expect(call(rows, `${dock("Pallet.java")}:Pallet.wrap`, "load")).toMatchObject(notKnown);
      // Bay's superclass is missing and may declare its own `sweep` (JLS 15.12.1).
      expect(call(rows, `${dock("Depot.java")}:Depot.Bay.open`, "sweep")).toMatchObject(notKnown);
      // `Rope` in Quay is faraway.Rope, which javac cannot find, not harbor.dock.Rope.
      const moor = `${dock("Quay.java")}:Quay.moor`;
      expect(call(rows, moor, "Rope")).toMatchObject(notKnown);
      expect(call(rows, moor, "coil")).toMatchObject(notKnown);
      // faraway.Knots may declare a `build` too, an overload of the one Deck imports.
      expect(call(rows, `${top("Deck.java")}:Deck.batten`, "build")).toMatchObject(notKnown);
    } finally {
      db.close();
    }
  });

  test("a class two files declare is not known, in either file and from a third", async () => {
    const { db } = await built();
    try {
      const rows = calls(db, "b");
      const batten = `${top("Deck.java")}:Deck.batten`;
      expect(call(rows, batten, "Hatch")).toMatchObject(notKnown);
      expect(call(rows, batten, "shut")).toMatchObject(notKnown);
      expect(call(rows, `${dock("Hatch.java")}:Hatch.shut`, "latch")).toMatchObject(notKnown);
      expect(call(rows, "src/main/java9/harbor/dock/Hatch.java:Hatch.shut", "latch")).toMatchObject(notKnown);
    } finally {
      db.close();
    }
  });

  test("way B runs no code of the repo and downloads nothing", async () => {
    const { db, note } = await built();
    db.close();
    expect(note).toBeNull();
    expect(existsSync(marker())).toBe(false);
  });

  test("the same files read by the built-in rules leave a call of an inherited method and a call in another file not known", async () => {
    const { db } = await built("built-in");
    try {
      const rows = calls(db, "b");
      const stack = `${dock("Pallet.java")}:Pallet.stack`;
      expect(rows.filter((r) => r.src === stack && r.dst_name === "load").map((r) => r.call_state)).toEqual(["not_known", "not_known"]);
      expect(call(rows, `${top("Captain.java")}:Captain.sail`, "build")).toMatchObject(notKnown);
    } finally {
      db.close();
    }
  });
});

test("without `java` on PATH, way B for Java does not run: the built-in rules make the links, and the layer names what is missing", async () => {
  const empty = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-nopath-")));
  try {
    // A PATH that holds git alone: the graph reads the commit through it.
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, path.join(empty, "git"));
    const sha = commit({ [dock("Hatch.java")]: HATCH });
    setEnv("PATH", empty);
    const db = openGraphDb(project, null);
    try {
      const stats = await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
      expect(stats.linksNote).toContain("java: javac cannot run (a JDK is missing: no `java` on PATH), so the built-in rules");
      expect(layerRow(db, "b")?.links_note).toBe(stats.linksNote);
      expect(call(calls(db, "b"), `${dock("Hatch.java")}:Hatch.shut`, "latch")).toMatchObject(linked(`${dock("Hatch.java")}:Hatch.latch@6`));
    } finally {
      db.close();
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
