// Way B for C and C++ (trustmybot/tmb#355): clangd, the user's own, makes the links of the graph's
// calls ("Two ways to make links"), reading the repo as the project's compile database says. Each
// expectation is read off the page and the languages' standards (C11, C++17), call by call: the
// declaration a call names by the language's rules, not what the graph happens to return. Without a
// compile database, or with a partial one, way B does not run. The fixture is a small program of
// its own.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../../src/engine/graph/build.ts";
import { layerRow, openGraphDb } from "../../src/engine/graph/db.ts";

setDefaultTimeout(30_000);

const HAS_CLANGD = spawnSync("clangd", ["--version"]).status === 0;

let project: string;
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

function commit(files: Record<string, string>): string {
  write({ ".gitignore": ".tmb/\nbuild/\n", ...files });
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
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-clangd-")));
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

// C: a function declared in a header and defined in another file, one declared and never defined,
// and a structure with a pointer to a function.
const TREE_H = lines(
  "#ifndef ORCHARD_TREE_H", //                                       1
  "#define ORCHARD_TREE_H", //                                       2
  "int ripen(int days);", //                                         3
  "int wither(void);", //                                            4
  "struct crate {", //                                               5
  "  int (*sort)(int);", //                                          6
  "};", //                                                           7
  "#endif", //                                                       8
);

const TREE_C = lines(
  '#include "tree.h"', //                                            1
  "", //                                                             2
  "int ripen(int days) {", //                                        3
  "  return days * 2;", //                                           4
  "}", //                                                            5
);

// Calls clangd answers across files, into the system's headers, through a pointer, inside a macro
// that keeps its argument as code and one that makes it a string, and one with an error at it.
const GROVE_C = lines(
  '#include <string.h>', //                                          1
  '#include "tree.h"', //                                            2
  "", //                                                             3
  "#define TWICE(e) ((e) + (e))", //                                 4
  "#define LABEL(e) #e", //                                          5
  "", //                                                             6
  "int harvest(struct crate *c) {", //                               7
  "  int a = ripen(3);", //                                          8
  '  int b = (int)strlen("plum");', //                               9
  "  int d = c->sort(a);", //                                        10
  "  int e = TWICE(ripen(1));", //                                   11
  "  const char *f = LABEL(ripen(2));", //                           12
  "  int g = wither();", //                                          13
  "  int h = ripen(no_such_day);", //                                14
  "  return a + b + d + e + g + h + (f != 0);", //                   15
  "}", //                                                            16
);

// Another platform's source: the database does not compile it.
const FROST_C = lines(
  '#include "tree.h"', //                                            1
  "", //                                                             2
  "int thaw(void) {", //                                             3
  "  return ripen(4);", //                                           4
  "}", //                                                            5
);

// A `.c` file the database compiles as C++ (`-x c++`): two functions of one name, chosen by the
// argument's type (C++ [over.match]); C would reject the second.
const SCALE_C = lines(
  "static int weigh(int n) { return n; }", //                        1
  "static double weigh(double n) { return n / 2; }", //              2
  "", //                                                             3
  "double balance(void) {", //                                       4
  "  return weigh(2.5);", //                                         5
  "}", //                                                            6
);

// C++: a pure virtual method, a class whose methods are defined in another file, and a construction.
const SHAPES_H = lines(
  "#pragma once", //                                                 1
  "namespace yard {", //                                             2
  "class Plot {", //                                                 3
  " public:", //                                                     4
  "  virtual ~Plot() = default;", //                                 5
  "  virtual double acres() const = 0;", //                          6
  "};", //                                                           7
  "", //                                                             8
  "class Field : public Plot {", //                                  9
  " public:", //                                                     10
  "  explicit Field(double side);", //                               11
  "  double acres() const override;", //                             12
  "", //                                                             13
  " private:", //                                                    14
  "  double side_;", //                                              15
  "};", //                                                           16
  "}  // namespace yard", //                                         17
);

const SHAPES_CC = lines(
  '#include "shapes.h"', //                                          1
  "", //                                                             2
  "namespace yard {", //                                             3
  "Field::Field(double side) : side_(side) {}", //                   4
  "", //                                                             5
  "double Field::acres() const { return side_ * side_; }", //        6
  "}  // namespace yard", //                                         7
);

// A header with no construct only C++ has, so the graph reads it as C, which a C++ file of the
// database includes: clangd reads it with that file's command, as C++, and chooses the overload.
const SIZES_H = lines(
  "static inline int span(int n) { return n; }", //                  1
  "static inline double span(double n) { return n * 2; }", //        2
  "static inline double stretch(void) { return span(1.5); }", //     3
);

const SURVEY_CC = lines(
  "#include <cstdlib>", //                                           1
  '#include "shapes.h"', //                                          2
  '#include "sizes.h"', //                                           3
  "double measure(const yard::Plot& p) {", //                        4
  "  return p.acres();", //                                          5
  "}", //                                                            6
  "", //                                                             7
  "double survey() {", //                                            8
  "  yard::Field* f = new yard::Field(3);", //                       9
  "  double a = f->acres();", //                                     10
  "  double b = measure(*f);", //                                    11
  "  int c = std::abs(-2);", //                                      12
  "  delete f;", //                                                  13
  "  return a + b + c;", //                                          14
  "}", //                                                            15
);

const FILES = {
  "orchard/tree.h": TREE_H,
  "orchard/tree.c": TREE_C,
  "orchard/grove.c": GROVE_C,
  "orchard/frost.c": FROST_C,
  "orchard/scale.c": SCALE_C,
  "yard/shapes.h": SHAPES_H,
  "yard/shapes.cc": SHAPES_CC,
  "yard/survey.cc": SURVEY_CC,
  "yard/sizes.h": SIZES_H,
};

/** A database entry for a file of the project, compiled by `driver` with `flags`, as CMake writes one. */
function entry(file: string, driver: string, ...flags: string[]): object {
  return { directory: path.join(project, "build"), command: [driver, ...flags, "-c", path.join(project, file), "-o", `${file}.o`].join(" "), file: path.join(project, file) };
}

/** The project's compile database, in build/, where clangd looks for it. frost.c is not in it. */
function database(entries: object[] = DATABASE()): void {
  write({ "build/compile_commands.json": JSON.stringify(entries, null, 1) });
}

const DATABASE = (): object[] => [
  entry("orchard/tree.c", "cc", "-std=c11"),
  entry("orchard/grove.c", "cc", "-std=c11"),
  entry("orchard/scale.c", "cc", "-x", "c++", "-std=c++17"),
  entry("yard/shapes.cc", "c++", "-std=c++17"),
  entry("yard/survey.cc", "c++", "-std=c++17"),
];

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
  if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}${line === undefined ? "" : ` on line ${line}`}: ${JSON.stringify(rows)}`);
  return found[0]!;
}

async function built(links: "language-tool" | "built-in" = "language-tool"): Promise<{ db: Database; rows: CallRow[]; note: string | null }> {
  const sha = commit(FILES);
  const db = openGraphDb(project, null);
  const stats = await buildLayer(db, project, sha, "b", { force: true, links });
  return { db, rows: calls(db, "b"), note: stats.linksNote };
}

const linked = (dst: string) => ({ dst, call_state: "linked" });
const outside = { dst: null, call_state: "outside" };
const notKnown = { dst: null, call_state: "not_known" };

const HARVEST = "orchard/grove.c:harvest";
const SURVEY = "yard/survey.cc:survey";

describe.skipIf(!HAS_CLANGD)("way B for C and C++", () => {
  test("a call links to the definition clangd names, in another file; a call into the system's headers is outside", async () => {
    database();
    const { db, rows } = await built();
    try {
      expect(call(rows, HARVEST, "ripen", 8)).toMatchObject(linked("orchard/tree.c:ripen@3"));
      expect(call(rows, HARVEST, "strlen")).toMatchObject(outside);
    } finally {
      db.close();
    }
  });

  test("a call through a pointer, a function the repo declares and never defines, and a call with an error at it are not known", async () => {
    database();
    const { db, rows } = await built();
    try {
      expect(call(rows, HARVEST, "sort")).toMatchObject(notKnown);
      expect(call(rows, HARVEST, "wither")).toMatchObject(notKnown);
      expect(call(rows, HARVEST, "ripen", 14)).toMatchObject(notKnown);
    } finally {
      db.close();
    }
  });

  test("inside a macro, clangd says what is a call: a call the macro keeps as code links, one it makes a string is not known", async () => {
    database();
    const { db, rows } = await built();
    try {
      expect(call(rows, HARVEST, "ripen", 11)).toMatchObject(linked("orchard/tree.c:ripen@3"));
      expect(call(rows, HARVEST, "ripen", 12)).toMatchObject(notKnown);
    } finally {
      db.close();
    }
  });

  test("a file's language is what the database's command says: a `.c` file compiled as C++ chooses an overload by the argument's type", async () => {
    database();
    const { db, rows } = await built();
    try {
      expect(call(rows, "orchard/scale.c:balance", "weigh")).toMatchObject(linked("orchard/scale.c:weigh@2"));
    } finally {
      db.close();
    }
  });

  test("a header the database's files include is read with the command of a file that includes it: as C++, choosing an overload", async () => {
    database();
    const { db, rows } = await built();
    try {
      expect(call(rows, "yard/sizes.h:stretch", "span")).toMatchObject(linked("yard/sizes.h:span@2"));
    } finally {
      db.close();
    }
  });

  test("C++: a call through a base class links to its pure virtual method, a call on the class to its definition in another file, a construction to the class; the standard library is outside", async () => {
    database();
    const { db, rows } = await built();
    try {
      const acres = rows.filter((r) => r.dst_name === "acres");
      expect(call(acres, "yard/survey.cc:measure", "acres")).toMatchObject({ call_state: "linked" });
      expect(call(acres, "yard/survey.cc:measure", "acres").dst).toMatch(/^yard\/shapes\.h:.*acres@6$/);
      expect(call(acres, SURVEY, "acres").dst).toMatch(/^yard\/shapes\.cc:.*acres@6$/);
      expect(call(rows, SURVEY, "Field")).toMatchObject({ call_state: "linked" });
      expect(call(rows, SURVEY, "Field").dst).toMatch(/^yard\/shapes\.h:.*Field@9$/);
      expect(call(rows, SURVEY, "measure")).toMatchObject(linked("yard/survey.cc:measure@4"));
      expect(call(rows, SURVEY, "abs")).toMatchObject(outside);
    } finally {
      db.close();
    }
  });

  test("a file the database does not compile, nor any file it compiles includes, is not asked: its calls are not known, and the layer says so", async () => {
    database();
    const { db, rows, note } = await built();
    try {
      expect(call(rows, "orchard/frost.c:thaw", "ripen")).toMatchObject(notKnown);
      expect(note).toContain("clangd: 1 file the compile database neither compiles nor includes, whose calls are not known");
    } finally {
      db.close();
    }
  });

  test("the built-in rules, on the same files, leave the call in another file not known", async () => {
    database();
    const { db, rows } = await built("built-in");
    try {
      expect(call(rows, HARVEST, "ripen", 8)).toMatchObject(notKnown);
    } finally {
      db.close();
    }
  });

  test("without a compile database, way B does not run: the built-in rules make the links, and the layer says why", async () => {
    const { db, rows, note } = await built();
    try {
      expect(note).toContain("c, cpp: clangd cannot run (no compile database: no compile_commands.json or build/compile_commands.json in the repo), so the built-in rules");
      expect(layerRow(db, "b")?.links_note).toBe(note);
      expect(call(rows, HARVEST, "ripen", 8)).toMatchObject(notKnown);
    } finally {
      db.close();
    }
  });

  test("with a partial compile database, one entry of which names a file that is not on disk, way B does not run", async () => {
    database([...DATABASE(), entry("orchard/gone.c", "cc")]);
    const { db, note } = await built();
    try {
      expect(note).toContain("c, cpp: clangd cannot run (the compile database build/compile_commands.json is partial: entry 6 names");
      expect(note).toContain("so the built-in rules");
    } finally {
      db.close();
    }
  });

  test("with a compile database that is not JSON, way B does not run", async () => {
    write({ "build/compile_commands.json": "[{" });
    const { db, note } = await built();
    try {
      expect(note).toContain("the compile database build/compile_commands.json is partial: it is not JSON");
    } finally {
      db.close();
    }
  });

  test("with a compile database one entry of which has no command, way B does not run", async () => {
    database([...DATABASE(), { directory: path.join(project, "build"), file: path.join(project, "orchard/tree.c") }]);
    const { db, note } = await built();
    try {
      expect(note).toContain("the compile database build/compile_commands.json is partial: entry 6 has no directory, file and command");
    } finally {
      db.close();
    }
  });
});

test("without `clangd` on PATH, way B for C and C++ does not run, and the layer names what is missing", async () => {
  const empty = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-nopath-")));
  try {
    const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, path.join(empty, "git"));
    database();
    const sha = commit(FILES);
    setEnv("PATH", empty);
    const db = openGraphDb(project, null);
    try {
      const stats = await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
      expect(stats.linksNote).toContain("c, cpp: clangd cannot run (clangd is missing: no `clangd` on PATH or in tmb's tools folder; `tmb tools install` installs it), so the built-in rules");
    } finally {
      db.close();
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
