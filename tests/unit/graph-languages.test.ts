// Each language the code graph reads is a module of its own (trustmybot/tmb#157): a language is
// one folder and one registry line, and a grammar loads only when a file needs it.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexProject, openView } from "../../src/engine/graph/fresh.ts";
import { LANGUAGES } from "../../src/engine/graph/languages/registry.ts";
import { lookupSymbol } from "../../src/engine/graph/lookups.ts";
import { openProjectStore, writeSetting } from "../../src/engine/index.ts";
import type { Actor, Store } from "../../src/engine/store/index.ts";
import { toy } from "./graph-language-fixture/toy/index.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const HUMAN: Actor = { kind: "human" };
const SRC = path.resolve(import.meta.dir, "../../src");

let project: string;
let store: Store;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeProject(files: Record<string, string>): void {
  for (const [file, text] of Object.entries({ ".gitignore": ".tmb/\n", ...files })) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    writeFileSync(path.join(project, file), text);
  }
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "first");
  const opened = openProjectStore(project, { create: true });
  if (!opened.ok) throw opened.error;
  store = opened.store;
  writeSetting(store, HUMAN, "base_branch", "main");
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-graph-lang-")));
  git(project, "init", "-q", "-b", "main");
});

afterEach(() => {
  store?.close();
  rmSync(project, { recursive: true, force: true });
});

describe("the registry", () => {
  test("a language added as one folder and one registry line is indexed with no other change", async () => {
    makeProject({ "game/rules.janet": "fn start\n  call move\nfn move\n" });
    LANGUAGES.push(toy);
    try {
      const stats = await indexProject(project, store, { rebuild: false });
      expect(stats.functions).toBe(2);
      const view = await openView(project, store);
      try {
        const file = view.db.query("SELECT lang FROM files WHERE layer = ? AND path = 'game/rules.janet'").get(view.layer);
        expect(file).toEqual({ lang: "toy" });
        const [move] = lookupSymbol(view.db, view.layer, "move").cards;
        expect(move!.callers.map((c) => c.qualifiedName)).toEqual(["start"]);
      } finally {
        view.db.close();
      }
    } finally {
      LANGUAGES.splice(LANGUAGES.indexOf(toy), 1);
    }
  });

  test("a project with no Python or bash file loads neither grammar", () => {
    makeProject({ "src/a.ts": "export const a = () => 1;\n", "db/schema.sql": "CREATE TABLE t (id INTEGER);\n" });
    store.close();
    // A process of its own, so no other test's parse has loaded a grammar first.
    const script = `
      import { indexProject } from ${JSON.stringify(path.join(SRC, "engine/graph/fresh.ts"))};
      import { loadedGrammars } from ${JSON.stringify(path.join(SRC, "engine/graph/loader.ts"))};
      import { openProjectStore } from ${JSON.stringify(path.join(SRC, "engine/index.ts"))};
      const opened = openProjectStore(process.env.TMB_PROBE_PROJECT, { create: false });
      if (!opened.ok) throw opened.error;
      await indexProject(process.env.TMB_PROBE_PROJECT, opened.store, { rebuild: false });
      opened.store.close();
      console.log(JSON.stringify(loadedGrammars()));
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMB_PROBE_PROJECT: project } });
    if (result.status !== 0 || result.stdout.trim() === "") throw new Error(`index process: ${result.status} ${result.stderr}`);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual(["typescript"]);
    const reopened = openProjectStore(project, { create: false });
    if (!reopened.ok) throw reopened.error;
    store = reopened.store;
  });
});
