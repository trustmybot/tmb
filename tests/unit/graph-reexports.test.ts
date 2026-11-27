// A name that reaches a file through a re-export is linked where it is declared, in
// TypeScript and Python (trustmybot/tmb#233). The import's link to the re-exporting file stays.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexProject, openView } from "../../src/engine/graph/fresh.ts";
import { openProjectStore, writeSetting } from "../../src/engine/index.ts";
import type { Actor, Store } from "../../src/engine/store/index.ts";

const HUMAN: Actor = { kind: "human" };

setDefaultTimeout(30_000);

let project: string;
let store: Store;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const FIXTURE: Record<string, string> = {
  ".gitignore": ".tmb/\n",
  "ts/a.ts": [
    "export function plain() { return 1; }",
    "export function original() { return 2; }",
    "export function imported() { return 3; }",
    "export function aliased() { return 4; }",
    "export function starred() { return 5; }",
    "export function shadowed() { return 6; }",
    "export function picked() { return 7; }",
    "export function inSpace() { return 8; }",
    "",
  ].join("\n"),
  "ts/other.ts": "export function picked() { return 9; }\n",
  "ts/index.ts": [
    "import { imported, aliased as other } from './a';",
    "export { plain } from './a';",
    "export { original as renamed } from './a';",
    "export { imported };",
    "export { other as reAliased };",
    "export * from './a';",
    "export { picked } from './other';",
    "export function shadowed() { return 0; }",
    "export * as space from './a';",
    "",
  ].join("\n"),
  "ts/chain/c.ts": "export function deep() { return 1; }\n",
  "ts/chain/b.ts": "export { deep } from './c';\n",
  "ts/chain/a.ts": "export { deep } from './b';\n",
  "ts/cycle/x.ts": "export { loop } from './y';\n",
  "ts/cycle/y.ts": "export { loop } from './x';\n",
  "ts/dup/one.ts": "export function twice() { return 1; }\nexport function onlyOne() { return 1; }\n",
  "ts/dup/two.ts": "export function twice() { return 2; }\n",
  "ts/dup/index.ts": "export * from './one';\nexport * from './two';\n",
  "ts/use.ts": [
    "import { plain, renamed, imported, reAliased, starred, shadowed, picked, space } from './index';",
    "import { deep } from './chain/a';",
    "import { loop } from './cycle/x';",
    "import { twice, onlyOne } from './dup/index';",
    "export function use() {",
    "  plain(); renamed(); imported(); reAliased(); starred(); shadowed(); picked(); space.inSpace();",
    "  deep(); loop(); twice(); onlyOne();",
    "}",
    "",
  ].join("\n"),
  "pkg/a.py": "def f():\n    return 1\n\n\ndef g():\n    return 2\n",
  "pkg/__init__.py": "from .a import f\nfrom .a import g as h\n",
  "listed/impl.py": '__all__ = ["shown"]\n\n\ndef shown():\n    return 1\n\n\ndef hidden():\n    return 2\n',
  "listed/__init__.py": "from .impl import *\n",
  "tupled/impl.py": '__all__ = ("tshown",)\n\n\ndef tshown():\n    return 1\n\n\ndef thidden():\n    return 2\n',
  "tupled/__init__.py": "from .impl import *\n",
  "public/impl.py": "def pub():\n    return 1\n\n\ndef _priv():\n    return 2\n",
  "public/__init__.py": "from .impl import *\n",
  "built/impl.py": 'names = ["built"]\n__all__ = list(names)\n\n\ndef built():\n    return 1\n',
  "built/__init__.py": "from .impl import *\n",
  "use.py": [
    "from pkg import f, h",
    "from listed import shown, hidden",
    "from tupled import tshown, thidden",
    "from public import pub, _priv",
    "from built import built",
    "",
    "",
    "def use():",
    "    f(); h(); shown(); hidden(); tshown(); thidden(); pub(); _priv(); built()",
    "",
  ].join("\n"),
};

type Links = Record<string, string | null>;

beforeAll(async () => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-reexports-")));
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

/** Each name a file's edges of `kinds` name, to `path:qualified_name` of what it links, or null. */
async function linksFrom(file: string, kinds: string[]): Promise<Links> {
  const view = await openView(project, store);
  try {
    const rows = view.db
      .query(
        `SELECT e.dst_name AS name, d.path AS path, d.qualified_name AS qualified FROM edges e
         JOIN symbols s ON s.id = e.src_id LEFT JOIN symbols d ON d.id = e.dst_id
         WHERE e.layer = ? AND s.path = ? AND e.kind IN (${kinds.map(() => "?").join(", ")})`,
      )
      .all(view.layer, file, ...kinds) as { name: string; path: string | null; qualified: string | null }[];
    const out: Links = {};
    for (const r of rows) out[r.name] = r.path === null ? null : r.path === r.qualified ? r.path : `${r.path}:${r.qualified}`;
    return out;
  } finally {
    view.db.close();
  }
}

test("TypeScript: each re-export form is followed to the declaration", async () => {
  const calls = await linksFrom("ts/use.ts", ["calls", "instantiates"]);
  expect(calls.plain).toBe("ts/a.ts:plain"); // export { f } from
  expect(calls.renamed).toBe("ts/a.ts:original"); // export { f as g } from
  expect(calls.imported).toBe("ts/a.ts:imported"); // import, then export of the same name
  expect(calls.reAliased).toBe("ts/a.ts:aliased"); // import as, then export as
  expect(calls.starred).toBe("ts/a.ts:starred"); // export * from
  expect(calls.inSpace).toBe("ts/a.ts:inSpace"); // export * as ns from, then ns.f()
});

test("TypeScript: a name the file declares or exports by name wins over a star", async () => {
  const calls = await linksFrom("ts/use.ts", ["calls"]);
  expect(calls.shadowed).toBe("ts/index.ts:shadowed");
  expect(calls.picked).toBe("ts/other.ts:picked");
});

test("TypeScript: the import's link to the re-exporting file stays", async () => {
  const imports = await linksFrom("ts/use.ts", ["imports"]);
  expect(imports.plain).toBe("ts/index.ts");
  expect(imports.deep).toBe("ts/chain/a.ts");
});

test("a chain of three files is followed step by step", async () => {
  expect((await linksFrom("ts/use.ts", ["calls"])).deep).toBe("ts/chain/c.ts:deep");
});

test("a cycle of two files leaves the name unresolved", async () => {
  expect((await linksFrom("ts/use.ts", ["calls"])).loop).toBeNull();
});

test("a name two stars bring from two declarations is unresolved; one star's own name is linked", async () => {
  const calls = await linksFrom("ts/use.ts", ["calls"]);
  expect(calls.twice).toBeNull();
  expect(calls.onlyOne).toBe("ts/dup/one.ts:onlyOne");
});

test("Python: `from .a import f` makes f a name of the package, with or without a new name", async () => {
  const calls = await linksFrom("use.py", ["calls"]);
  expect(calls.f).toBe("pkg/a.py:f");
  expect(calls.h).toBe("pkg/a.py:g");
  expect((await linksFrom("use.py", ["imports"])).f).toBe("pkg/__init__.py");
});

test("Python: `import *` follows a plain `__all__` list or tuple, else the public names", async () => {
  const calls = await linksFrom("use.py", ["calls"]);
  expect(calls.shown).toBe("listed/impl.py:shown");
  expect(calls.hidden).toBeNull();
  expect(calls.tshown).toBe("tupled/impl.py:tshown");
  expect(calls.thidden).toBeNull();
  expect(calls.pub).toBe("public/impl.py:pub");
  expect(calls._priv).toBeNull();
});

test("Python: an `__all__` built by code is not followed", async () => {
  expect((await linksFrom("use.py", ["calls"])).built).toBeNull();
});
