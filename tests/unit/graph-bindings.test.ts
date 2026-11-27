// Four bindings the lookup reads (trustmybot/tmb#287). The first place that has the name decides,
// and a binding the lookup cannot read stops the link; it is never skipped.
// 1. A class's own attribute or field hides a method of the same name further up its parents.
// 2. A name a Python class body binds holds for the statements directly in that body, and not
//    inside the functions, lambdas and comprehensions there.
// 3. A class imported under a new name is looked up in the file that import names, as the object
//    of a call, as a parent and as a declared type.
// 4. Two classes of one name in one file are two symbols, and a name that names both proves neither.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexProject, openView } from "../../src/engine/graph/fresh.ts";
import { openProjectStore, writeSetting } from "../../src/engine/index.ts";
import type { Actor, Store } from "../../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

let project: string;
let store: Store;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  // 1, TypeScript: a parent's field hides its own parent's method.
  "hide/vehicle.ts": lines("export class Vehicle {", "  honk() { return 1; }", "  wave() { return 1; }", "}"),
  "hide/car.ts": lines(
    "import { Vehicle } from './vehicle';",
    "export class Car extends Vehicle {",
    "  honk: number = 3;",
    "  declare wave: () => number;",
    "}",
  ),
  "hide/sport.ts": lines(
    "import { Car } from './car';",
    "export class SportsCar extends Car {",
    "  drive() {",
    "    this.wave();",
    "    return this.honk();",
    "  }",
    "}",
  ),
  // 1, JavaScript and TypeScript: a name the class's own methods assign on `this`, and a parameter property.
  "hide/truck.js": lines(
    "import { Vehicle } from './vehicle';",
    "export class Truck extends Vehicle {",
    "  constructor() { super(); this.honk = 0; }",
    "  go() { return this.honk(); }",
    "}",
  ),
  "hide/bus.ts": lines(
    "import { Vehicle } from './vehicle';",
    "export class Bus extends Vehicle {",
    "  constructor(private wave: number) { super(); }",
    "  go() { return this.wave(); }",
    "}",
  ),
  // 1, Python: an attribute of the class itself, or of a parent, hides a parent's method.
  "hide/__init__.py": "",
  "hide/shapes.py": lines(
    "class Polygon:",
    "    def area(self):",
    "        return 0",
    "",
    "    def sides(self):",
    "        return 0",
    "",
    "    def angle(self):",
    "        return 0",
  ),
  "hide/square.py": lines(
    "from .shapes import Polygon",
    "",
    "",
    "class Square(Polygon):",
    "    area = None",
    "    angle: int",
    "",
    "    def report(self):",
    "        self.angle()",
    "        return self.area()",
    "",
    "",
    "class Tile(Square):",
    "    def go(self):",
    "        self.sides()",
    "        return self.area()",
    "",
    "",
    "class Panel(Polygon):",
    "    def __init__(self):",
    "        self.sides = 4",
    "",
    "    def count(self):",
    "        return self.sides()",
  ),
  // 2. A Python import in a class body, and a function the class body defines.
  "body/__init__.py": "",
  "body/fmt_a.py": lines("def stamp(x):", "    return x"),
  "body/fmt_b.py": lines("def stamp(x):", "    return x"),
  "body/ledger.py": lines(
    "from .fmt_a import stamp",
    "",
    "",
    "class Ledger:",
    "    from .fmt_b import stamp",
    "",
    "    header = stamp('h')",
    "",
    "    def build():",
    "        return 1",
    "",
    "    made = build()",
    "    rows = [stamp(r) for r in 'ab']",
    "    cols = [c for c in stamp('xy')]",
    "",
    "    def total(self):",
    "        return stamp('t')",
  ),
  // 3, TypeScript: one class name imported from two files under two new names.
  "alias/red.ts": lines("export class Palette {", "  static make() { return new Palette(); }", "  mix() { return 1; }", "}"),
  "alias/blue.ts": lines("export class Palette {", "  static make() { return new Palette(); }", "  mix() { return 2; }", "}"),
  "alias/paint.ts": lines(
    "import { Palette as Warm } from './red';",
    "import { Palette as Cool } from './blue';",
    "export function paint() {",
    "  const w: Warm = Warm.make();",
    "  Cool.make();",
    "  return w.mix();",
    "}",
    "export class Fresco extends Warm {",
    "  blend() { return this.mix(); }",
    "}",
    "export class Mural extends Cool {",
    "  blend() { return this.mix(); }",
    "}",
  ),
  // 3, Python: the same, as a parent, as the object of a call and as a call.
  "alias/__init__.py": "",
  "alias/north.py": lines("class Compass:", "    def point(self):", "        return 1", "", "    @classmethod", "    def build(cls):", "        return cls()"),
  "alias/south.py": lines("class Compass:", "    def point(self):", "        return 2", "", "    @classmethod", "    def build(cls):", "        return cls()"),
  "alias/nav.py": lines(
    "from .north import Compass as Up",
    "from .south import Compass as Down",
    "",
    "",
    "class Chart(Up):",
    "    def go(self):",
    "        return self.point()",
    "",
    "",
    "def plot():",
    "    Up.build()",
    "    Down.build()",
    "    return Up()",
  ),
  // 4. Two classes of one name in one file.
  "twice/menu.ts": lines(
    "export function first() {",
    "  class Entry { label() { return 1; } }",
    "  return new Entry();",
    "}",
    "export function second() {",
    "  class Entry {",
    "    label() { return 2; }",
    "    show() { return this.label(); }",
    "  }",
    "  return new Entry();",
    "}",
  ),
  "twice/__init__.py": "",
  "twice/codec.py": lines(
    "import sys",
    "",
    "if sys.version_info >= (3, 11):",
    "    class Codec:",
    "        def encode(self):",
    "            return 1",
    "else:",
    "    class Codec:",
    "        def encode(self):",
    "            return 2",
    "",
    "",
    "def use():",
    "    return Codec()",
  ),
};

type Link = string | null;

beforeAll(async () => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-bindings-")));
  git(project, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(FIXTURE)) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  writeSetting(store, HUMAN, "base_branch", "main");
  // These test the built-in rules, so the repo names them; the default is the language's tool (trustmybot/tmb#337).
  writeSetting(store, HUMAN, "graph_links", "built-in");
  await indexProject(project, store, { rebuild: false });
});

afterAll(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

/** What the call or instantiation of `name` on `line` of `file` links: `path:qualified_name:start_line`, or null. */
async function linkAt(file: string, line: number, name: string): Promise<Link> {
  const view = await openView(project, store);
  try {
    const rows = view.db
      .query(
        `SELECT d.path AS path, d.qualified_name AS qualified, d.start_line AS start FROM edges e
         JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
         WHERE e.layer = ? AND s.path = ? AND e.line = ? AND e.dst_name = ? AND e.kind IN ('calls', 'instantiates')`,
      )
      .all(view.layer, file, line, name) as { path: string | null; qualified: string | null; start: number | null }[];
    if (rows.length !== 1) throw new Error(`${rows.length} references to ${name} at ${file}:${line}`);
    const [row] = rows;
    return row!.path === null ? null : `${row!.path}:${row!.qualified}:${row!.start}`;
  } finally {
    view.db.close();
  }
}

/** The lines each symbol of `kind` named `name` in `file` starts on. */
async function symbolsAt(file: string, kind: string, name: string): Promise<number[]> {
  const view = await openView(project, store);
  try {
    const rows = view.db
      .query("SELECT start_line AS start FROM symbols WHERE layer = ? AND path = ? AND kind = ? AND qualified_name = ? ORDER BY start_line")
      .all(view.layer, file, kind, name) as { start: number }[];
    return rows.map((r) => r.start);
  } finally {
    view.db.close();
  }
}

test("1, TypeScript: a parent's field hides the method further up, so a call on the object links nothing", async () => {
  expect(await linkAt("hide/sport.ts", 5, "honk")).toBeNull();
  // A field declared with no value hides it too.
  expect(await linkAt("hide/sport.ts", 4, "wave")).toBeNull();
  // So does a name the class's own constructor assigns on `this`, and a parameter property.
  expect(await linkAt("hide/truck.js", 4, "honk")).toBeNull();
  expect(await linkAt("hide/bus.ts", 4, "wave")).toBeNull();
});

test("1, Python: an attribute of the class or of a parent hides a parent's method; one it does not name still links", async () => {
  expect(await linkAt("hide/square.py", 10, "area")).toBeNull();
  // An annotation in the class body declares an attribute of each object (PEP 526).
  expect(await linkAt("hide/square.py", 9, "angle")).toBeNull();
  expect(await linkAt("hide/square.py", 16, "area")).toBeNull();
  expect(await linkAt("hide/square.py", 15, "sides")).toBe("hide/shapes.py:Polygon.sides:5");
  // A name the class's own methods assign on `self`.
  expect(await linkAt("hide/square.py", 24, "sides")).toBeNull();
});

test("2, Python: a class body's import decides for the class body, and not inside its functions", async () => {
  expect(await linkAt("body/ledger.py", 7, "stamp")).toBe("body/fmt_b.py:stamp:1");
  expect(await linkAt("body/ledger.py", 17, "stamp")).toBe("body/fmt_a.py:stamp:1");
  // A comprehension is a scope of its own: the class body's names are not seen in it,
  expect(await linkAt("body/ledger.py", 13, "stamp")).toBe("body/fmt_a.py:stamp:1");
  // except in its first iterable, which the class body evaluates.
  expect(await linkAt("body/ledger.py", 14, "stamp")).toBe("body/fmt_b.py:stamp:1");
});

test("2, Python: a function the class body defines is what a call in the class body names", async () => {
  expect(await linkAt("body/ledger.py", 12, "build")).toBe("body/ledger.py:Ledger.build:9");
});

test("3, TypeScript: a class under a new name is looked up in its own import's file", async () => {
  expect(await linkAt("alias/paint.ts", 4, "make")).toBe("alias/red.ts:Palette.make:2");
  expect(await linkAt("alias/paint.ts", 5, "make")).toBe("alias/blue.ts:Palette.make:2");
  // A declared type under a new name.
  expect(await linkAt("alias/paint.ts", 6, "mix")).toBe("alias/red.ts:Palette.mix:3");
  // A parent under a new name.
  expect(await linkAt("alias/paint.ts", 9, "mix")).toBe("alias/red.ts:Palette.mix:3");
  expect(await linkAt("alias/paint.ts", 12, "mix")).toBe("alias/blue.ts:Palette.mix:3");
});

test("3, Python: a class under a new name is looked up in its own import's file", async () => {
  expect(await linkAt("alias/nav.py", 7, "point")).toBe("alias/north.py:Compass.point:2");
  expect(await linkAt("alias/nav.py", 11, "build")).toBe("alias/north.py:Compass.build:5");
  expect(await linkAt("alias/nav.py", 12, "build")).toBe("alias/south.py:Compass.build:5");
  expect(await linkAt("alias/nav.py", 13, "Compass")).toBe("alias/north.py:Compass:1");
});

test("4: two classes of one name in one file are two symbols, each with its own methods", async () => {
  expect(await symbolsAt("twice/menu.ts", "type", "Entry")).toEqual([2, 6]);
  expect(await symbolsAt("twice/codec.py", "type", "Codec")).toEqual([4, 8]);
  expect(await symbolsAt("twice/codec.py", "method", "Codec.encode")).toEqual([5, 9]);
});

test("4: a name bound around the call links its own class; a name that names both links neither", async () => {
  expect(await linkAt("twice/menu.ts", 3, "Entry")).toBe("twice/menu.ts:Entry:2");
  expect(await linkAt("twice/menu.ts", 10, "Entry")).toBe("twice/menu.ts:Entry:6");
  expect(await linkAt("twice/menu.ts", 8, "label")).toBeNull();
  expect(await linkAt("twice/codec.py", 14, "Codec")).toBeNull();
});
