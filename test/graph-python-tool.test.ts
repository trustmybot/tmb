// Way B for Python (trustmybot/tmb#347): pyright, tmb's pinned copy in its tools folder, makes the links of a
// repo's Python calls. It is asked and never imitated (CODE_GRAPH.md, "Two ways to make links"):
// - linked, when the callee's declaration is exactly one node of the graph;
// - outside, when every declaration is outside the repo: the standard library, or a package the
//   repo's own virtual environment installs;
// - not known, otherwise: no answer, a declaration that is no node, or an answer for another call.
// The page's rules for Python, each with its fixture: overload stubs are one function; a function or
// a class inside another has no node yet; the environment is the repo's own, in its working tree,
// with its project config, and the user's Python never runs; a construction links to the class; a
// call in unreachable code or under `if TYPE_CHECKING:` is a call like any other; an answer for
// another call is no answer; the tool's answer stands. The fixtures are small programs of their
// own; each expectation is read off the rule, not off the graph's output.
import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayer } from "../src/engine/graph/build.ts";
import { openGraphDb } from "../src/engine/graph/db.ts";
import { loadPyright } from "../src/engine/graph/languages/python/load.ts";
import { NODE } from "../src/engine/graph/languages/python/tool.ts";
import { machinePlaces, toolFolder } from "../src/engine/graph/tool-copy.ts";
import { installPinnedTools } from "../tests/lib/pinned-tools.ts";

setDefaultTimeout(30_000);

// Way B loads pyright from tmb's tools folder; the setup installs tmb's pinned copy there.
beforeAll(installPinnedTools);

let project: string;

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

/** Commits the files, and writes the untracked ones (a virtual environment) beside them. */
function commit(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  write({ ".gitignore": ".tmb/\n.venv/\nvenv/\nenv/\n", ...files });
  write(untracked);
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  return git(project, "rev-parse", "HEAD");
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-python-tool-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

type CallRow = { src: string; dst_name: string; line: number; dst: string | null; dst_start: number | null; call_state: string; way: string };

/** Every call of the layer, with where it links. */
function calls(db: Database, layer: string): CallRow[] {
  return db
    .query(
      `SELECT s.path || ':' || s.qualified_name AS src, e.dst_name, e.line, d.path || ':' || d.qualified_name AS dst, d.start_line AS dst_start, e.call_state, e.way
       FROM edges e JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
       WHERE e.layer = ? AND e.call_state IS NOT NULL ORDER BY s.path, e.line, e.dst_name`,
    )
    .all(layer) as CallRow[];
}

/** The one call of `name` that `src` makes on `line`, or anywhere in it when no line is given. */
function call(rows: CallRow[], src: string, name: string, line?: number): CallRow {
  const found = rows.filter((r) => r.src === src && r.dst_name === name && (line === undefined || r.line === line));
  if (found.length !== 1) throw new Error(`${found.length} calls of ${name} in ${src}${line === undefined ? "" : ` on line ${line}`}: ${JSON.stringify(rows.filter((r) => r.src === src))}`);
  return found[0]!;
}

/** The repo's graph built by way B, and its stats. */
async function wayB(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const sha = commit(files, untracked);
  const db = openGraphDb(project, null);
  const stats = await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
  return { db, rows: calls(db, "b"), stats };
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

/** A virtual environment at `dir` that installs one package, as a tool that makes one leaves it. */
function environment(dir: string, pkg: Record<string, string>): Record<string, string> {
  const files: Record<string, string> = { [`${dir}/pyvenv.cfg`]: "home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.12.0\n" };
  for (const [file, text] of Object.entries(pkg)) files[`${dir}/lib/python3.12/site-packages/${file}`] = text;
  return files;
}

const INKWELL = { "inkwell/__init__.py": lines("def blot(n):", "    return n") };

describe("way B for Python, pyright", () => {
  test("links a call across files, a method on a value whose class only a return type says, and records the way", async () => {
    const { db, rows, stats } = await wayB({
      "shop/basket.py": lines("class Basket:", "    def weigh(self):", "        return 2", "", "", "def fill() -> Basket:", "    return Basket()"),
      "shop/till.py": lines("from shop.basket import fill", "", "", "def ring():", "    return fill().weigh()"),
    });
    expect(stats.linksNote).toBeNull();
    expect(call(rows, "shop/till.py:ring", "fill")).toMatchObject({ dst: "shop/basket.py:fill", call_state: "linked", way: "language-tool" });
    expect(call(rows, "shop/till.py:ring", "weigh")).toMatchObject({ dst: "shop/basket.py:Basket.weigh", call_state: "linked", way: "language-tool" });
    db.close();
  });

  test("a call of the standard library is outside, from the stubs tmb carries", async () => {
    const { db, rows } = await wayB({ "util/paths.py": lines("import os.path", "", "", "def joined(a, b):", "    return os.path.join(a, b)", "", "", "def size(xs):", "    return len(xs)") });
    expect(call(rows, "util/paths.py:joined", "join")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    expect(call(rows, "util/paths.py:size", "len")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    db.close();
  });

  test("a call of a parameter is not known: the declaration is no node", async () => {
    const { db, rows } = await wayB({ "util/apply.py": lines("def apply(fn):", "    return fn()") });
    expect(call(rows, "util/apply.py:apply", "fn")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    db.close();
  });

  test("an import under a new name links the function it names", async () => {
    const { db, rows } = await wayB({
      "pkg/__init__.py": "",
      "pkg/stamp.py": lines("def press(x):", "    return x"),
      "pkg/use.py": lines("from pkg.stamp import press as squash", "", "", "def go():", "    return squash(1)"),
    });
    expect(call(rows, "pkg/use.py:go", "press")).toMatchObject({ dst: "pkg/stamp.py:press", call_state: "linked" });
    db.close();
  });
});

describe("every link of way B is placed where its name is written", () => {
  test("a call, a method call and a parent class each keep the position of the name they link", async () => {
    const text = lines("class Crate:", "    def lid(self):", "        return 1", "", "", "class Box(Crate):", "    pass", "", "", "def pack():", "    return Box().lid()");
    const { db } = await wayB({ "store/box.py": text });
    const rows = db
      .query(`SELECT e.dst_name AS name, e.pos AS pos, e.call_state AS state FROM edges e JOIN symbols s ON s.id = e.src_id WHERE e.layer = 'b' AND s.path = 'store/box.py' AND e.kind IN ('calls', 'instantiates') ORDER BY e.pos`)
      .all() as { name: string; pos: number | null; state: string | null }[];
    expect(rows).toEqual([
      { name: "Crate", pos: text.indexOf("Crate)"), state: null },
      { name: "Box", pos: text.indexOf("Box()"), state: "linked" },
      { name: "lid", pos: text.indexOf("lid()"), state: "linked" },
    ]);
    db.close();
  });
});

describe("overload stubs are one function", () => {
  test("a call pyright resolves to a function's @overload stubs links to the function itself, the one definition that runs", async () => {
    const { db, rows } = await wayB({
      "geo/scale.py": lines(
        "from typing import overload",
        "",
        "",
        "@overload",
        "def stretch(x: int) -> int: ...",
        "@overload",
        "def stretch(x: str) -> str: ...",
        "def stretch(x):",
        "    return x",
        "",
        "",
        "class Ruler:",
        "    @overload",
        "    def mark(self, x: int) -> int: ...",
        "    @overload",
        "    def mark(self, x: str) -> str: ...",
        "    def mark(self, x):",
        "        return x",
      ),
      "geo/use.py": lines("from geo.scale import Ruler, stretch", "", "", "def go():", "    stretch(2)", '    stretch("a")', "    return Ruler().mark(3)"),
    });
    expect(call(rows, "geo/use.py:go", "stretch", 5)).toMatchObject({ dst: "geo/scale.py:stretch", dst_start: 8, call_state: "linked" });
    expect(call(rows, "geo/use.py:go", "stretch", 6)).toMatchObject({ dst: "geo/scale.py:stretch", dst_start: 8, call_state: "linked" });
    expect(call(rows, "geo/use.py:go", "mark")).toMatchObject({ dst: "geo/scale.py:Ruler.mark", dst_start: 17, call_state: "linked" });
    db.close();
  });
});

describe("a function or a class inside another has no node yet", () => {
  test("a call of a nested function, of a nested class or of its method is not known, even one of the name of the function around it", async () => {
    const { db, rows } = await wayB({
      "deep/nest.py": lines(
        "def outer():",
        "    def helper():",
        "        return 1",
        "    return helper()",
        "",
        "",
        "def tally():",
        "    def tally():",
        "        return 2",
        "    return tally()",
        "",
        "",
        "def build():",
        "    class Box:",
        "        def open(self):",
        "            return 3",
        "    return Box().open()",
      ),
    });
    expect(call(rows, "deep/nest.py:outer", "helper")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    expect(call(rows, "deep/nest.py:tally", "tally")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    expect(call(rows, "deep/nest.py:build", "Box")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    expect(call(rows, "deep/nest.py:build", "open")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    db.close();
  });
});

describe("the environment is the repo's own, in its working tree", () => {
  const USES_INK = { "app/main.py": lines("from inkwell import blot", "", "", "def draw():", "    return blot(1)") };

  test("a call into a package the repo's virtual environment installs is outside", async () => {
    const { db, rows } = await wayB(USES_INK, environment(".venv", INKWELL));
    expect(call(rows, "app/main.py:draw", "blot")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    db.close();
  });

  test("whatever the environment's folder is named", async () => {
    const { db, rows } = await wayB(USES_INK, environment("env", INKWELL));
    expect(call(rows, "app/main.py:draw", "blot")).toMatchObject({ call_state: "outside" });
    db.close();
  });

  test("with no environment, a call into a package is not known, never guessed to be outside", async () => {
    const { db, rows } = await wayB(USES_INK);
    expect(call(rows, "app/main.py:draw", "blot")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    db.close();
  });

  test("with no environment, a package whose stubs pyright ships is not known either", async () => {
    const { db, rows } = await wayB({ "app/conf.py": lines("import yaml", "", "", "def load(text):", "    return yaml.safe_load(text)") });
    expect(call(rows, "app/conf.py:load", "safe_load")).toMatchObject({ dst: null, call_state: "not_known" });
    db.close();
  });

  test("two environments are no one environment: a call into a package is not known", async () => {
    const { db, rows } = await wayB(USES_INK, { ...environment(".venv", INKWELL), ...environment("venv", INKWELL) });
    expect(call(rows, "app/main.py:draw", "blot")).toMatchObject({ dst: null, call_state: "not_known" });
    db.close();
  });

  test("the language's stubs in the repo are read: a function a stub declares links to the function that runs", async () => {
    const { db, rows } = await wayB({
      "fmt/money.py": lines("def cents(x):", "    return x * 100"),
      "fmt/money.pyi": lines("def cents(x: int) -> int: ..."),
      "fmt/use.py": lines("from fmt.money import cents", "", "", "def price():", "    return cents(2)"),
    });
    expect(call(rows, "fmt/use.py:price", "cents")).toMatchObject({ dst: "fmt/money.py:cents", call_state: "linked" });
    db.close();
  });

  test("with no environment, the calls inside the repo are still linked", async () => {
    const { db, rows } = await wayB({ ...USES_INK, "app/local.py": lines("from app.main import draw", "", "", "def run():", "    return draw()") });
    expect(call(rows, "app/local.py:run", "draw")).toMatchObject({ dst: "app/main.py:draw", call_state: "linked" });
    db.close();
  });

  test("the src layout the project config names is where its package's imports are found", async () => {
    const { db, rows } = await wayB({
      "pyproject.toml": lines("[project]", 'name = "ledger"', "", "[tool.setuptools.packages.find]", 'where = ["src"]'),
      "src/ledger/__init__.py": "",
      "src/ledger/books.py": lines("def post(entry):", "    return entry"),
      "tests/test_books.py": lines("from ledger.books import post", "", "", "def test_post():", "    assert post(1) == 1"),
    });
    expect(call(rows, "tests/test_books.py:test_post", "post")).toMatchObject({ dst: "src/ledger/books.py:post", call_state: "linked" });
    db.close();
  });

  test("the user's Python is never run", async () => {
    const marker = path.join(project, "python-ran");
    const python = `#!/bin/sh\ntouch '${marker}'\nexit 1\n`;
    const env = { ...environment(".venv", INKWELL), ".venv/bin/python": python, ".venv/bin/python3": python };
    const sha = commit(USES_INK, env);
    chmodSync(path.join(project, ".venv/bin/python"), 0o755);
    chmodSync(path.join(project, ".venv/bin/python3"), 0o755);
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
    expect(call(calls(db, "b"), "app/main.py:draw", "blot")).toMatchObject({ call_state: "outside" });
    expect(existsSync(marker)).toBe(false);
    db.close();
  });

  test("the repo's files are read from the commit, not from the working tree", async () => {
    const sha = commit({
      "calc/ops.py": lines("def add(a, b):", "    return a + b"),
      "calc/use.py": lines("from calc.ops import add", "", "", "def total():", "    return add(1, 2)"),
    });
    // The working tree loses the function the commit holds.
    write({ "calc/ops.py": lines("def subtract(a, b):", "    return a - b") });
    const db = openGraphDb(project, null);
    await buildLayer(db, project, sha, "b", { force: true, links: "language-tool" });
    expect(call(calls(db, "b"), "calc/use.py:total", "add")).toMatchObject({ dst: "calc/ops.py:add", call_state: "linked" });
    db.close();
  });
});

// CODE_GRAPH.md, "Way B for Python reads the environment in the working tree", "Which
// environment": the one the project's config names, else the one folder at the top of the repo
// that holds `pyvenv.cfg`; two or more with no config naming one count as none, and the answer's
// freshness says so. The config is pyright's own: `venvPath` and `venv`, in `pyrightconfig.json` or
// in `pyproject.toml` under `[tool.pyright]`.
describe("which environment", () => {
  const USES_QUILL = { "desk/write.py": lines("from quill import scratch", "", "", "def letter():", "    return scratch(2)") };
  const QUILL = { "quill/__init__.py": lines("def scratch(n):", "    return n") };
  const NOTHING = { "other/__init__.py": "" };
  // The environments are the working tree's, never the commit's.
  const IGNORED = { ".gitignore": lines(".tmb/", ".venv/", "py/", "envs/", "alpha/", "beta/", "tools-env/") };

  /** The freshness line the layer records. */
  const note = (db: Database): string | null => (db.query("SELECT links_note AS note FROM layers WHERE layer = 'b'").get() as { note: string | null }).note;

  test("the config names one of two environments in pyproject.toml: that one is read, from disk", async () => {
    const { db, rows, stats } = await wayB(
      { ...IGNORED, ...USES_QUILL, "pyproject.toml": lines("[project]", 'name = "desk"', "", "[tool.pyright]", 'venvPath = "."', 'venv = "py"') },
      { ...environment(".venv", NOTHING), ...environment("py", QUILL) },
    );
    expect(call(rows, "desk/write.py:letter", "scratch")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    expect(stats.linksNote).toBeNull();
    expect(note(db)).toBeNull();
    db.close();
  });

  test("the config's choice wins over the one folder at the top: pyrightconfig.json names one in a folder below", async () => {
    const { db, rows, stats } = await wayB(
      { ...IGNORED, ...USES_QUILL, "pyrightconfig.json": JSON.stringify({ venvPath: "envs", venv: "work" }) },
      { ...environment(".venv", NOTHING), ...environment("envs/work", QUILL) },
    );
    expect(call(rows, "desk/write.py:letter", "scratch")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    expect(stats.linksNote).toBeNull();
    db.close();
  });

  test("two environments and no config naming one: none is read, and the freshness names them", async () => {
    const { db, rows, stats } = await wayB({ ...IGNORED, ...USES_QUILL }, { ...environment("alpha", QUILL), ...environment("beta", QUILL) });
    expect(call(rows, "desk/write.py:letter", "scratch")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    expect(stats.linksNote).not.toBeNull();
    expect(stats.linksNote).toContain("alpha");
    expect(stats.linksNote).toContain("beta");
    expect(note(db)).toBe(stats.linksNote);
    db.close();
  });

  test("two environments and a config that names none: none is read, and the freshness says so", async () => {
    const { db, rows, stats } = await wayB(
      { ...IGNORED, ...USES_QUILL, "pyproject.toml": lines("[tool.pyright]", 'include = ["desk"]') },
      { ...environment("alpha", QUILL), ...environment("beta", QUILL) },
    );
    expect(call(rows, "desk/write.py:letter", "scratch")).toMatchObject({ dst: null, call_state: "not_known" });
    expect(stats.linksNote).toContain("alpha");
    expect(stats.linksNote).toContain("beta");
    db.close();
  });

  test("the config names an environment folder that is not there: none is read, and the freshness names the folder", async () => {
    const { db, rows, stats } = await wayB(
      { ...IGNORED, ...USES_QUILL, "pyrightconfig.json": JSON.stringify({ venvPath: "envs", venv: "gone" }) },
      environment("tools-env", QUILL),
    );
    expect(call(rows, "desk/write.py:letter", "scratch")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    expect(stats.linksNote).toContain("envs/gone");
    expect(stats.linksNote).toContain("not known");
    expect(note(db)).toBe(stats.linksNote);
    db.close();
  });

  test("one environment and no config: that one is read, and the freshness says nothing", async () => {
    const { db, rows, stats } = await wayB({ ...IGNORED, ...USES_QUILL }, environment("tools-env", QUILL));
    expect(call(rows, "desk/write.py:letter", "scratch")).toMatchObject({ dst: null, call_state: "outside", way: "language-tool" });
    expect(stats.linksNote).toBeNull();
    db.close();
  });

  test("one environment and a config that names none: that one is read", async () => {
    const { db, rows, stats } = await wayB({ ...IGNORED, ...USES_QUILL, "pyproject.toml": lines("[tool.pyright]", 'include = ["desk"]') }, environment("tools-env", QUILL));
    expect(call(rows, "desk/write.py:letter", "scratch")).toMatchObject({ dst: null, call_state: "outside" });
    expect(stats.linksNote).toBeNull();
    db.close();
  });
});

describe("a construction links to the class", () => {
  test("a class called links to the class, not its __init__ or __new__", async () => {
    const { db, rows } = await wayB({
      "bank/ledger.py": lines("class Ledger:", "    def __init__(self):", "        self.rows = []", "", "", "class Vault:", "    def __new__(cls):", "        return super().__new__(cls)"),
      "bank/use.py": lines("from bank.ledger import Ledger, Vault", "", "", "def open_books():", "    Vault()", "    return Ledger()"),
    });
    expect(call(rows, "bank/use.py:open_books", "Ledger")).toMatchObject({ dst: "bank/ledger.py:Ledger", call_state: "linked" });
    expect(call(rows, "bank/use.py:open_books", "Vault")).toMatchObject({ dst: "bank/ledger.py:Vault", call_state: "linked" });
    db.close();
  });
});

describe("a call in unreachable code or under `if TYPE_CHECKING:` is a call like any other", () => {
  test("pyright's answer there makes the link, as anywhere", async () => {
    const { db, rows } = await wayB({
      "gate/check.py": lines(
        "from typing import TYPE_CHECKING",
        "",
        "",
        "def ping():",
        "    return 1",
        "",
        "",
        "def guarded():",
        "    if TYPE_CHECKING:",
        "        ping()",
        "    return 0",
        "",
        "",
        "def after():",
        "    return 0",
        "    ping()",
      ),
    });
    // pyright reads `TYPE_CHECKING` as true, so the block is code it checks.
    expect(call(rows, "gate/check.py:guarded", "ping")).toMatchObject({ dst: "gate/check.py:ping", call_state: "linked", way: "language-tool" });
    // After a return: the tool's answer, or not known when it gives none; never another link.
    const unreachable = call(rows, "gate/check.py:after", "ping");
    expect(unreachable.way).toBe("language-tool");
    expect(["linked gate/check.py:ping", "not_known null"]).toContain(`${unreachable.call_state} ${unreachable.dst}`);
    db.close();
  });
});

describe("an answer for another call than the one asked is no answer", () => {
  test("a call whose callee is a call's result or a subscript is not known; the inner call is answered", async () => {
    const { db, rows } = await wayB({
      "relay/hops.py": lines(
        "def ping():",
        "    return 1",
        "",
        "",
        "def maker():",
        "    return ping",
        "",
        "",
        "TABLE = {'a': ping}",
        "",
        "",
        "def hop():",
        "    maker()()",
        "    return TABLE['a']()",
      ),
    });
    expect(call(rows, "relay/hops.py:hop", "maker")).toMatchObject({ dst: "relay/hops.py:maker", call_state: "linked" });
    expect(call(rows, "relay/hops.py:hop", "maker()")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    expect(call(rows, "relay/hops.py:hop", "TABLE['a']")).toMatchObject({ dst: null, call_state: "not_known", way: "language-tool" });
    db.close();
  });
});

describe("the tool's answer stands", () => {
  test("the declared type, a base class's method, a stub that is a node and an inferred value each link where pyright says", async () => {
    const { db, rows } = await wayB({
      "zoo/animals.py": lines(
        "class Animal:",
        "    def speak(self):",
        "        return 'hm'",
        "",
        "",
        "class Dog(Animal):",
        "    def speak(self):",
        "        return 'woof'",
        "",
        "",
        "class Cat(Animal):",
        "    pass",
        "",
        "",
        "def adopt() -> Animal:",
        "    return Dog()",
        "",
        "",
        "def later(): ...",
      ),
      "zoo/use.py": lines(
        "from zoo.animals import Cat, Dog, adopt, later",
        "",
        "",
        "def visit():",
        "    adopt().speak()",
        "    Cat().speak()",
        "    rex = Dog()",
        "    rex.speak()",
        "    return later()",
      ),
    });
    expect(call(rows, "zoo/use.py:visit", "speak", 5)).toMatchObject({ dst: "zoo/animals.py:Animal.speak", call_state: "linked" });
    expect(call(rows, "zoo/use.py:visit", "speak", 6)).toMatchObject({ dst: "zoo/animals.py:Animal.speak", call_state: "linked" });
    expect(call(rows, "zoo/use.py:visit", "speak", 8)).toMatchObject({ dst: "zoo/animals.py:Dog.speak", call_state: "linked" });
    expect(call(rows, "zoo/use.py:visit", "later")).toMatchObject({ dst: "zoo/animals.py:later", call_state: "linked" });
    db.close();
  });
});

describe("tmb's pinned pyright", () => {
  test("the kinds of its syntax tree tool.ts reads are the ones it numbers", () => {
    const { exporting } = loadPyright(toolFolder(machinePlaces().stateDir, "pyright"));
    const { Parser, ParseOptions } = exporting("Parser");
    const { DiagnosticSink } = exporting("DiagnosticSink");
    const text = lines("from m import f as g", "class C:", "    def m(self):", "        return lambda: [x for x in o.p()]");
    const tree = new Parser().parseSourceFile(text, new ParseOptions(), new DiagnosticSink()).parserOutput.parseTree;
    // Each kind is found where it is written: the shape of the node with that number says what it is.
    const at = (kind: keyof typeof NODE) => {
      const found: { nodeType: number; d: Record<string, any> }[] = [];
      const walk = (n: { nodeType: number; d?: Record<string, any> }): void => {
        if (n.nodeType === NODE[kind]) found.push(n as { nodeType: number; d: Record<string, any> });
        for (const v of Object.values(n.d ?? {})) for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c === "object" && (c as { parent?: unknown }).parent === n) walk(c as typeof n);
      };
      walk(tree);
      return found;
    };
    expect(tree.nodeType).toBe(NODE.Module);
    expect(at("ImportFromAs").map((n) => [n.d.name.d.value, n.d.alias.d.value])).toEqual([["f", "g"]]);
    expect(at("Class").map((n) => n.d.name.d.value)).toEqual(["C"]);
    expect(at("Function").map((n) => n.d.name.d.value)).toEqual(["m"]);
    expect(at("Lambda")).toHaveLength(1);
    expect(at("Comprehension")).toHaveLength(1);
    expect(at("Call").map((n) => n.d.leftExpr.nodeType)).toEqual([NODE.MemberAccess]);
    expect(at("MemberAccess").map((n) => n.d.member.d.value)).toEqual(["p"]);
    expect(at("Name").map((n) => n.d.value)).toContain("o");
  });
});
