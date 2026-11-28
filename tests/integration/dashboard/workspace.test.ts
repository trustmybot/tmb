// The dashboard's Code page in a workspace of several repos (trustmybot/tmb#142, #163): the page
// lists the repos first, and each graph read names the repo whose graph it reads.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { openProjectStore, writeSetting } from "../../../src/engine/index.ts";
import { REPO_ROOT } from "../../lib/paths.ts";
import { git } from "../../lib/git.ts";
import { gitRepo } from "../../lib/project.ts";

// Every test file sets this: bun's 5s fails slow tests on a busy machine (tests/README.md).
setDefaultTimeout(30_000);

const ROOT = REPO_ROOT;
const CLI = path.join(ROOT, "src", "cli", "index.ts");

let scratch: string;
let child: ChildProcess;
let base: string;

/** A repo of the workspace with one file of its own. */
function makeRepo(name: string, source: string): void {
  gitRepo(path.join(scratch, name), { "src/main.ts": source });
}

function startDashboard(projectDir: string): Promise<string> {
  child = spawn(process.execPath, [`--config=${path.join(ROOT, "bunfig.toml")}`, CLI, "dashboard", "--port", "0", "--project", projectDir], {
    cwd: scratch,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tmb dashboard did not start: ${stderr}`)), 30_000);
    child.once("exit", (code) => reject(new Error(`tmb dashboard exited ${code}: ${stderr}`)));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const match = /: (http:\/\/127\.0\.0\.1:\d+\/)$/.exec(line);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
  });
}

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-dashboard-ws-")));
  makeRepo("shop", "export function checkout(): number {\n  return [1, 2].map((n) => n * 2).length;\n}\n");
  makeRepo("tools/lint", "export function lint(): void {}\n");
  const opened = openProjectStore(scratch, { create: true });
  if (!opened.ok) throw opened.error;
  writeSetting(opened.store, { kind: "human" }, "repos", { shop: { base_branch: "main" }, "tools/lint": { base_branch: "main" } });
  opened.store.close();
  base = await startDashboard(scratch);
}, 60_000);

afterAll(() => {
  child?.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
});

const get = (route: string) => fetch(new URL(`api/${route}`, base));

test("lists the workspace's repos for the page to show first", async () => {
  expect(await (await get("graph/repos")).json()).toEqual({ repos: ["shop", "tools/lint"] });
});

test("each read names its repo and reads that repo's own graph", async () => {
  const shop = (await (await get("graph/tree?path=.&repo=shop")).json()) as any;
  expect(shop.functions).toBe(2);
  const lint = (await (await get("graph/tree?path=src&repo=tools%2Flint")).json()) as any;
  expect(lint.children.map((c: any) => [c.path, c.functions])).toEqual([["src/main.ts", 1]]);
  const hits = (await (await get("graph/search?q=lint&repo=tools%2Flint")).json()) as any;
  const id = hits.hits.find((h: any) => h.qualifiedName === "lint").id;
  expect(((await (await get(`graph/function/${id}?repo=tools%2Flint`)).json()) as any).name).toBe("lint");
});

test("a read that names no repo, or one the workspace does not have, is refused, never guessed", async () => {
  expect((await get("graph/tree?path=.")).status).toBeGreaterThanOrEqual(400);
  expect((await get("graph/tree?path=.&repo=nope")).status).toBe(404);
});
