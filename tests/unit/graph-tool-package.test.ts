// The TypeScript compiler and pyright are installed on ask, not carried in the tmb program
// (CODE_GRAPH.md, "Where a language's tool comes from"; trustmybot/tmb#395):
// - tmb uses only its pinned copy of each, in its tools folder; a copy in the repo's `node_modules`
//   or on the PATH is never used, so one tmb gives one answer;
// - until it is installed, the built-in rules build the graph, and the answer names the missing
//   tool and `tmb tools install`;
// - an install takes the pinned package from the tool's own registry, checked against a digest tmb
//   carries; a failed check installs nothing and leaves nothing behind;
// - the layer records whose copy built it, with its version, so a changed copy rebuilds the layer.
// The install tests download nothing: each package is a small archive a local server serves. The
// way B tests use the real pinned tools, which the test setup installs (tests/lib/pinned-tools.ts).
// Each expectation is read off the page's rule, not off the code's output.
import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { runToolsCommand } from "../../src/engine/doors/command-line.ts";
import { buildLayer, stillBuiltWith } from "../../src/engine/graph/build.ts";
import { layerRow, openGraphDb } from "../../src/engine/graph/db.ts";
import type { ToolCopy, ToolRelease } from "../../src/engine/graph/languages/contract.ts";
import { pyright } from "../../src/engine/graph/languages/python/tool.ts";
import { typescriptCompiler } from "../../src/engine/graph/languages/typescript/tool.ts";
import { type CopyPlaces, findCopy, machinePlaces, TOOL_PATHS_FILE, toolFolder, toolsFolder } from "../../src/engine/graph/tool-copy.ts";
import { installTool, type InstallOptions, missingTools, PLATFORMS } from "../../src/engine/graph/tool-install.ts";
import { installPinnedTools } from "../lib/pinned-tools.ts";

setDefaultTimeout(30_000);

/** The two tools that are packages tmb loads, by the name the tools folder keeps each under. */
type PackageCopy = Extract<ToolCopy, { library: string }>;
const TS = typescriptCompiler.copy as PackageCopy;
const PY = pyright.copy as PackageCopy;

let scratch: string;
let userBin: string;
let state: string;
let server: ReturnType<typeof Bun.serve>;
const served = new Map<string, Uint8Array>();
const asked: string[] = [];
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-tool-package-")));
  userBin = path.join(scratch, "user-bin");
  state = path.join(scratch, "state");
  mkdirSync(userBin, { recursive: true });
  mkdirSync(state, { recursive: true });
  served.clear();
  asked.length = 0;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const at = new URL(request.url).pathname;
      asked.push(at);
      const body = served.get(at);
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
});

afterEach(() => {
  server.stop(true);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

const places = (): CopyPlaces => ({ searchPath: userBin, stateDir: state });
const options = (more: Partial<InstallOptions> = {}): InstallOptions => ({ places: places(), ...more });
const toolsHeld = (): string[] => (existsSync(toolsFolder(state)) ? readdirSync(toolsFolder(state)) : []);
const sha512 = (bytes: Uint8Array): string => createHash("sha512").update(bytes).digest("base64");
const url = (at: string): string => `http://127.0.0.1:${server.port}${at}`;

/** A tar archive of the files given (POSIX ustar, as npm packs a package), gzipped. */
function tgz(files: Record<string, string>): Uint8Array {
  const BLOCK = 512;
  const parts: Buffer[] = [];
  const field = (header: Buffer, at: number, length: number, text: string) => header.write(text.slice(0, length), at, length, "ascii");
  const octal = (n: number, length: number) => `${n.toString(8).padStart(length - 1, "0")}\0`;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const header = Buffer.alloc(BLOCK);
    field(header, 0, 100, name);
    field(header, 100, 8, octal(0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(data.length, 12));
    field(header, 136, 12, octal(0, 12));
    field(header, 148, 8, "        ");
    field(header, 156, 1, "0");
    field(header, 257, 6, "ustar\0");
    field(header, 263, 2, "00");
    let sum = 0;
    for (const byte of header) sum += byte;
    field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

/** A package of the copy's name at the pinned version, as its registry packs it: each file the copy must hold, under `package/`. */
function packageFiles(copy: PackageCopy, version: string = copy.release.version, leave: string[] = []): Record<string, string> {
  const files: Record<string, string> = { "package/package.json": JSON.stringify({ name: copy.library, version }) };
  for (const file of copy.holds) if (!leave.includes(file)) files[`package/${file}`] = `// ${file}\n`;
  return files;
}

/** Serves an archive and gives the release that names it, with its digest unless one is given. */
function servedRelease(bytes: Uint8Array, digest: string = sha512(bytes)): ToolRelease {
  served.set("/package.tgz", bytes);
  return { version: "fixture", page: url("/"), assets: {}, everyMachine: { url: url("/package.tgz"), sha512: digest, archive: { format: "tgz", from: "package/", to: "" } } };
}

/** Writes tmb's copy of a package into the tools folder by hand, at a version. */
function placeCopy(copy: PackageCopy, version: string): string {
  const folder = toolFolder(state, copy.library);
  for (const [name, text] of Object.entries(packageFiles(copy, version))) {
    const file = path.join(folder, name.slice("package/".length));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return folder;
}

describe("the find order for the TypeScript compiler and pyright", () => {
  test("with no copy in tmb's tools folder each is missing, and the note names the tool and `tmb tools install`", () => {
    for (const copy of [TS, PY]) {
      const found = findCopy(copy, places());
      expect("missing" in found).toBe(true);
      const missing = (found as { missing: string }).missing;
      expect(missing).toContain(copy.what);
      expect(missing).toContain("tools install`");
    }
  });

  test("a copy on the PATH or in the repo's node_modules is never used", () => {
    for (const program of ["tsc", "pyright", "typescript"]) {
      const file = path.join(userBin, program);
      writeFileSync(file, `#!/bin/sh\necho ${program}\n`);
      chmodSync(file, 0o755);
    }
    for (const copy of [TS, PY]) {
      const folder = path.join(userBin, "node_modules", copy.library);
      for (const [name, text] of Object.entries(packageFiles(copy))) {
        mkdirSync(path.dirname(path.join(folder, name.slice("package/".length))), { recursive: true });
        writeFileSync(path.join(folder, name.slice("package/".length)), text);
      }
      expect("missing" in findCopy(copy, { searchPath: [userBin, path.join(userBin, "node_modules", copy.library)].join(path.delimiter), stateDir: state })).toBe(true);
    }
  });

  test("tmb's copy at the pinned version is used: tmb's, in its folder, at its version", () => {
    for (const copy of [TS, PY]) {
      const folder = placeCopy(copy, copy.release.version);
      expect(findCopy(copy, places())).toEqual({ whose: "tmb", path: folder, version: copy.release.version });
    }
  });

  test("tmb's copy at another version than the pin is not used, and the note names the pin and the command", () => {
    for (const copy of [TS, PY]) {
      placeCopy(copy, "0.0.1");
      const found = findCopy(copy, places());
      expect("missing" in found).toBe(true);
      expect((found as { missing: string }).missing).toContain(copy.release.version);
      expect((found as { missing: string }).missing).toContain("tools install`");
    }
  });

  test("a copy that lacks a file it must hold is not used", () => {
    const folder = placeCopy(TS, TS.release.version);
    rmSync(path.join(folder, TS.holds[0]!));
    expect("missing" in findCopy(TS, places())).toBe(true);
  });

  test("what tmb would install: both, for a TypeScript and a Python repo with neither", () => {
    const { offers } = missingTools(["typescript", "javascript", "python"], places());
    expect(offers.map((o) => o.tool).sort()).toEqual([pyright.name, typescriptCompiler.name].sort());
    expect(offers.find((o) => o.tool === typescriptCompiler.name)?.languages).toEqual(["typescript", "javascript"]);
  });
});

describe("installing a package", () => {
  test("the checked package is unpacked into tmb's tools folder, and the find order then finds tmb's copy", async () => {
    const release = servedRelease(tgz(packageFiles(TS)));
    const result = await installTool(TS, options({ releaseOf: () => release }));
    expect(result).toEqual({ installed: toolFolder(state, TS.library) });
    expect(asked).toEqual(["/package.tgz"]);
    expect(toolsHeld()).toEqual([TS.library]);
    for (const file of TS.holds) expect(existsSync(path.join(toolFolder(state, TS.library), file))).toBe(true);
    expect(findCopy(TS, places())).toEqual({ whose: "tmb", path: toolFolder(state, TS.library), version: TS.release.version });
  });

  test("a digest that does not match installs nothing and leaves nothing behind", async () => {
    const bytes = tgz(packageFiles(PY));
    const release = servedRelease(bytes, sha512(new TextEncoder().encode("another package")));
    const result = await installTool(PY, options({ releaseOf: () => release }));
    expect("failed" in result).toBe(true);
    expect((result as { failed: string }).failed).toContain("checksum");
    expect(toolsHeld()).toEqual([]);
    expect("missing" in findCopy(PY, places())).toBe(true);
  });

  test("a package that lacks a file the copy must hold installs nothing and leaves nothing behind", async () => {
    const release = servedRelease(tgz(packageFiles(PY, PY.release.version, [PY.holds[0]!])));
    const result = await installTool(PY, options({ releaseOf: () => release }));
    expect("failed" in result).toBe(true);
    expect(toolsHeld()).toEqual([]);
  });

  test("a package that names a file outside its folder installs nothing and leaves nothing behind", async () => {
    const release = servedRelease(tgz({ ...packageFiles(TS), "package/../../escaped.js": "// out\n" }));
    const result = await installTool(TS, options({ releaseOf: () => release }));
    expect("failed" in result).toBe(true);
    expect(toolsHeld()).toEqual([]);
    expect(existsSync(path.join(state, "escaped.js"))).toBe(false);
  });

  test("an install over an older copy replaces it whole", async () => {
    placeCopy(TS, "0.0.1");
    const release = servedRelease(tgz(packageFiles(TS)));
    expect(await installTool(TS, options({ releaseOf: () => release }))).toEqual({ installed: toolFolder(state, TS.library) });
    expect(toolsHeld()).toEqual([TS.library]);
    expect(findCopy(TS, places())).toMatchObject({ whose: "tmb", version: TS.release.version });
  });

  test("two installs at once each finish, and leave one whole copy", async () => {
    const release = servedRelease(tgz(packageFiles(PY)));
    const [a, b] = await Promise.all([installTool(PY, options({ releaseOf: () => release })), installTool(PY, options({ releaseOf: () => release }))]);
    expect(a).toEqual({ installed: toolFolder(state, PY.library) });
    expect(b).toEqual({ installed: toolFolder(state, PY.library) });
    expect(toolsHeld()).toEqual([PY.library]);
  });

  test("the setting that turns installs off: nothing is downloaded", async () => {
    writeFileSync(path.join(state, TOOL_PATHS_FILE), JSON.stringify({ install: false }));
    const release = servedRelease(tgz(packageFiles(TS)));
    const result = await installTool(TS, options({ releaseOf: () => release }));
    expect((result as { failed: string }).failed).toContain("off");
    expect(asked).toEqual([]);
  });

  test("`tmb tools install typescript` with bytes that do not match the pin's digest installs nothing", async () => {
    const lines = { out: [] as string[], err: [] as string[] };
    const fetch = async () => new Response(tgz(packageFiles(TS)));
    const code = await runToolsCommand(["install", "typescript"], scratch, { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l) }, options({ fetch }));
    expect(code).toBe(1);
    expect(lines.err.join("\n")).toContain("checksum");
    expect(toolsHeld()).toEqual([]);
  });
});

describe("the pins", () => {
  // The pinned versions, and the tool's own registry the package comes from.
  const PINS: [PackageCopy, string, string][] = [
    [TS, "typescript", "5.9.3"],
    [PY, "pyright", "1.1.414"],
  ];
  for (const [copy, name, version] of PINS) {
    test(`${name}: one version, ${version}, from the tool's own registry, with a sha512, for every machine`, () => {
      expect(copy.library).toBe(name);
      expect(copy.release.version).toBe(version);
      const asset = copy.release.everyMachine!;
      expect(asset.url).toBe(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
      expect(Buffer.from((asset as { sha512: string }).sha512, "base64").length).toBe(64);
      for (const platform of PLATFORMS) expect(copy.release.assets[platform] ?? copy.release.everyMachine).toBe(asset);
    });
  }

  test("the benchmark's reference compiler is a separate package at the same version as way B's", () => {
    const reference = JSON.parse(readFileSync(Bun.resolveSync("typescript5/package.json", import.meta.dir), "utf8")) as { version: string };
    expect(reference.version).toBe(TS.release.version);
  });
});

describe("way B through an installed copy", () => {
  beforeAll(installPinnedTools);

  function git(cwd: string, ...args: string[]): string {
    const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  }

  /** A repo of the files given, committed. */
  function repo(files: Record<string, string>): { dir: string; sha: string } {
    const dir = path.join(scratch, "project");
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "first");
    return { dir, sha: git(dir, "rev-parse", "HEAD") };
  }

  /** The way B layer of the repo: its note, its record and the targets of its calls. */
  async function build(dir: string, sha: string): Promise<{ note: string | null; record: Record<string, { whose: string; path: string | null; tool: string }>; links: string[]; built: string | null }> {
    const db = openGraphDb(dir, null);
    try {
      const stats = await buildLayer(db, dir, sha, "base", { force: true, links: "language-tool" });
      const built = layerRow(db, "base")?.built_with ?? null;
      const links = (
        db.query("SELECT s.qualified_name AS src, d.qualified_name AS dst FROM edges e JOIN symbols s ON s.id = e.src_id JOIN symbols d ON d.id = e.dst_id WHERE e.layer = 'base' AND e.call_state = 'linked'").all() as {
          src: string;
          dst: string;
        }[]
      ).map((r) => `${r.src} -> ${r.dst}`);
      return { note: stats.linksNote ?? null, record: JSON.parse(built ?? "{}"), links, built };
    } finally {
      db.close();
    }
  }

  // A call whose receiver's type only the compiler knows: way A has no written type for it.
  const SHOP = {
    "cart.ts": "export class Cart {\n  total(): number {\n    return 1;\n  }\n}\nexport function makeCart() {\n  return new Cart();\n}\n",
    "till.ts": 'import { makeCart } from "./cart";\nexport function ring(): number {\n  const c = makeCart();\n  return c.total();\n}\n',
  };
  const ORCHARD = {
    "orchard.py": "class Tree:\n    def pick(self) -> int:\n        return 1\n\n\ndef plant():\n    return Tree()\n",
    "harvest.py": "from orchard import plant\n\n\ndef gather() -> int:\n    t = plant()\n    return t.pick()\n",
  };

  test("TypeScript: the installed compiler links a call only a type proves, and the layer records tmb's copy", async () => {
    const { dir, sha } = repo(SHOP);
    const { links, record } = await build(dir, sha);
    expect(links).toContain("ring -> Cart.total");
    expect(record[typescriptCompiler.name]).toMatchObject({ whose: "tmb", path: toolFolder(machinePlaces().stateDir, TS.library), tool: TS.release.version });
  });

  test("Python: the installed pyright links a call only a type proves, and the layer records tmb's copy", async () => {
    const { dir, sha } = repo(ORCHARD);
    const { links, record } = await build(dir, sha);
    expect(links).toContain("gather -> Tree.pick");
    expect(record[pyright.name]).toMatchObject({ whose: "tmb", path: toolFolder(machinePlaces().stateDir, PY.library), tool: PY.release.version });
  });

  test("not installed: the built-in rules build it, the note names the tool and the command, and installing the copy makes the layer stale", async () => {
    const { dir, sha } = repo({ ...SHOP, ...ORCHARD });
    const empty = path.join(scratch, "empty-state");
    mkdirSync(empty);
    setEnv("TMB_STATE_DIR", empty);
    const before = await build(dir, sha);
    expect(before.links).not.toContain("ring -> Cart.total");
    expect(before.links).not.toContain("gather -> Tree.pick");
    for (const name of [typescriptCompiler.name, pyright.name]) {
      expect(before.note ?? "").toContain(`${name} cannot run (`);
      expect(before.record[name]).toMatchObject({ whose: "missing", path: null });
    }
    expect(before.note ?? "").toContain("tools install`");
    expect(before.note ?? "").toContain("so the built-in rules");
    expect(stillBuiltWith(dir, before.built)).toBe(true);
    // The copy is installed: the layer it did not rest on is stale.
    cpSync(toolsFolder(saved.TMB_STATE_DIR!), toolsFolder(empty), { recursive: true });
    expect(stillBuiltWith(dir, before.built)).toBe(false);
  });
});
