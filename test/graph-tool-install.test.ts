// Installing a language's tool (CODE_GRAPH.md, "Where a language's tool comes from";
// trustmybot/tmb#393):
// - `tmb tools install [language]` downloads the pinned release from the tool's own release page,
//   checks it against a checksum tmb carries, and puts it in tmb's tools folder; a failed check
//   installs nothing;
// - `tmb init` names the tools the repo's languages miss and installs them on a yes;
// - a read of the graph downloads nothing: it uses the built-in rules and names the command;
// - a setting turns installs off;
// - tmb installs a tool, never a language: the `go` command and a JDK are never offered.
// No test downloads anything: every release here is a small archive a local server serves, or a
// fetch the test gives.
// Each expectation is read off the page's rule, not off the code's output.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { runToolsCommand } from "../src/engine/doors/command-line.ts";
import { buildLayer } from "../src/engine/graph/build.ts";
import { openGraphDb } from "../src/engine/graph/db.ts";
import { clangdTool, LOWEST_CLANGD } from "../src/engine/graph/languages/c/clangd.ts";
import type { ToolCopy, ToolRelease } from "../src/engine/graph/languages/contract.ts";
import { goTypeChecker } from "../src/engine/graph/languages/go/tool.ts";
import { javacTool } from "../src/engine/graph/languages/java/tool.ts";
import { LOWEST_COMMIT_DAY, rustAnalyzer } from "../src/engine/graph/languages/rust/tool.ts";
import { type CopyPlaces, findCopy, TOOL_PATHS_FILE, toolsFolder } from "../src/engine/graph/tool-copy.ts";
import { installTool, missingTools, type InstallOptions, PLATFORMS } from "../src/engine/graph/tool-install.ts";

setDefaultTimeout(30_000);

let scratch: string;
let userBin: string;
let state: string;
let server: ReturnType<typeof Bun.serve>;
/** What the local server serves, by path, and each path it was asked for. */
const served = new Map<string, Uint8Array>();
const asked: string[] = [];
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-tool-install-")));
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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A shell program that prints `report` when asked its version. */
const program = (report: string): Uint8Array => new TextEncoder().encode(["#!/bin/sh", `if [ "$1" = "--version" ]; then echo '${report}'; exit 0; fi`, "exit 1", ""].join("\n"));

/** A zip archive of the files given, deflated, as the zip format lays it out (APPNOTE.TXT 4.3). */
function zip(files: Record<string, Uint8Array>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const crc = Bun.hash.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const here = `${process.platform}-${process.arch}`;
const url = (at: string): string => `http://127.0.0.1:${server.port}${at}`;

/** A tool of no language whose release is one gzip of the program, served at /widget.gz. */
function gzipWidget(bytes: Uint8Array = gzipSync(program("widget 2.5")), sha = sha256(bytes)): ToolCopy {
  served.set("/widget.gz", bytes);
  const release: ToolRelease = { version: "2.5", page: url("/"), assets: { [here]: { url: url("/widget.gz"), sha256: sha, archive: { format: "gzip" } } } };
  return { program: "widget", what: "widget", versionArgs: ["--version"], report: ({ stdout }) => stdout.trim(), lowest: "widget 2.0", supported: (r) => Number(/widget (\d+)/.exec(r)?.[1] ?? 0) >= 2, tmbInstalls: true, release };
}

/** A tool whose release is a zip of a folder holding the program and the files it reads beside it, as clangd's lays out its resource headers. */
function zipWidget(): ToolCopy {
  const bytes = zip({
    "widget_2.5/bin/widget": program("widget 2.5"),
    "widget_2.5/lib/widget/2/include/stddef.h": new TextEncoder().encode("/* a resource header */\n"),
  });
  served.set("/widget.zip", bytes);
  const release: ToolRelease = {
    version: "2.5",
    page: url("/"),
    assets: { [here]: { url: url("/widget.zip"), sha256: sha256(bytes), archive: { format: "zip", from: "widget_2.5/", to: "" } } },
  };
  return { ...gzipWidget(), release };
}

const places = (): CopyPlaces => ({ searchPath: userBin, stateDir: state });
const options = (more: Partial<InstallOptions> = {}): InstallOptions => ({ places: places(), ...more });
const tmbCopy = (name: string): string => path.join(toolsFolder(state), name, "bin", name);
/** Every entry the tools folder holds: an install that failed leaves none, and a whole one leaves only its own folder. */
const toolsHeld = (): string[] => (existsSync(toolsFolder(state)) ? readdirSync(toolsFolder(state)) : []);

describe("an install", () => {
  test("a good install: the checked release is in tmb's tools folder, and the find order then finds tmb's copy", async () => {
    const widget = gzipWidget();
    const result = await installTool(widget, options());
    expect(result).toEqual({ installed: tmbCopy("widget") });
    expect(asked).toEqual(["/widget.gz"]);
    expect(toolsHeld()).toEqual(["widget"]);
    expect(findCopy(widget, places())).toEqual({ whose: "tmb", path: tmbCopy("widget"), version: "widget 2.5" });
  });

  test("a release that is a folder keeps the files beside the program as the release lays them out", async () => {
    const widget = zipWidget();
    expect(await installTool(widget, options())).toEqual({ installed: tmbCopy("widget") });
    expect(readFileSync(path.join(toolsFolder(state), "widget", "lib", "widget", "2", "include", "stddef.h"), "utf8")).toBe("/* a resource header */\n");
    expect(findCopy(widget, places())).toMatchObject({ whose: "tmb", version: "widget 2.5" });
  });

  test("a checksum that does not match installs nothing and leaves no partial file", async () => {
    const widget = gzipWidget(gzipSync(program("widget 2.5")), "0".repeat(64));
    const result = await installTool(widget, options());
    expect("failed" in result).toBe(true);
    expect((result as { failed: string }).failed).toContain("checksum");
    expect(toolsHeld()).toEqual([]);
    expect("missing" in findCopy(widget, places())).toBe(true);
  });

  test("a release the page does not serve installs nothing", async () => {
    const widget = gzipWidget();
    served.clear();
    const result = await installTool(widget, options());
    expect("failed" in result).toBe(true);
    expect(toolsHeld()).toEqual([]);
  });

  test("the setting turns installs off: nothing is downloaded and nothing installed", async () => {
    writeFileSync(path.join(state, TOOL_PATHS_FILE), JSON.stringify({ install: false }));
    const widget = gzipWidget();
    const result = await installTool(widget, options());
    expect("failed" in result).toBe(true);
    expect((result as { failed: string }).failed).toContain("off");
    expect(asked).toEqual([]);
    expect(toolsHeld()).toEqual([]);
  });

  test("two installs at once each finish, and leave one whole copy", async () => {
    const widget = zipWidget();
    const [a, b] = await Promise.all([installTool(widget, options()), installTool(widget, options())]);
    expect(a).toEqual({ installed: tmbCopy("widget") });
    expect(b).toEqual({ installed: tmbCopy("widget") });
    expect(toolsHeld()).toEqual(["widget"]);
    expect(findCopy(widget, places())).toMatchObject({ whose: "tmb", version: "widget 2.5" });
  });

  test("a machine the release has no build for installs nothing", async () => {
    const widget = gzipWidget();
    const result = await installTool(widget, options({ platform: "plan9-mips" }));
    expect("failed" in result).toBe(true);
    expect(asked).toEqual([]);
  });

  test("a language's own command is never installed: tmb installs a tool, never a language", async () => {
    let fetched = 0;
    const fetch = async () => {
      fetched++;
      return new Response("");
    };
    for (const copy of [goTypeChecker.copy, javacTool.copy]) {
      const result = await installTool(copy, options({ fetch }));
      expect((result as { failed: string }).failed).toContain("never a language");
    }
    expect(fetched).toBe(0);
  });
});

describe("what tmb would install", () => {
  test("the missing tools of the languages given, each once, and never a language's toolchain", () => {
    setEnv("CARGO_HOME", path.join(scratch, "cargo"));
    const { offers, notes } = missingTools(["go", "java", "rust", "c", "cpp", "typescript", "python", "bash"], places());
    expect(offers.map((offer) => offer.tool).sort()).toEqual(["clangd", "rust-analyzer"]);
    expect(offers.find((offer) => offer.tool === "clangd")?.languages).toEqual(["c", "cpp"]);
    expect(notes.join("\n")).toContain("tmb installs no language");
  });

  test("a tool the user already has is not offered", () => {
    setEnv("CARGO_HOME", path.join(scratch, "cargo"));
    const file = path.join(userBin, "clangd");
    writeFileSync(file, "#!/bin/sh\necho 'clangd version 23.1.0'\n", { mode: 0o755 });
    expect(missingTools(["c"], places()).offers).toEqual([]);
  });
});

describe("the note of a missing tool", () => {
  test("names `tmb tools install` for a tool tmb installs", () => {
    setEnv("CARGO_HOME", path.join(scratch, "cargo"));
    for (const tool of [rustAnalyzer, clangdTool]) {
      const found = findCopy(tool.copy, places());
      expect((found as { missing?: string }).missing ?? "").toContain("`tmb tools install");
    }
  });

  test("does not name it for a language's own command", () => {
    const found = findCopy(goTypeChecker.copy, places());
    expect((found as { missing?: string }).missing ?? "").not.toContain("tools install");
  });
});

describe("a read never downloads", () => {
  test("building the graph of a Rust repo with no rust-analyzer uses the built-in rules, names the command, and fetches nothing", async () => {
    const project = path.join(scratch, "project");
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname = "orchard"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(path.join(project, "src", "lib.rs"), "pub fn pick() -> i32 { sort() }\npub fn sort() -> i32 { 1 }\n");
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    const gitOnly = path.join(scratch, "git-only");
    mkdirSync(gitOnly);
    symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), path.join(gitOnly, "git"));
    setEnv("PATH", `${userBin}${path.delimiter}${gitOnly}`);
    setEnv("TMB_STATE_DIR", state);
    setEnv("CARGO_HOME", path.join(scratch, "cargo"));
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = Object.assign(async () => {
      fetched++;
      return new Response("");
    }, realFetch);
    const sha = git("rev-parse", "HEAD").stdout.trim();
    const db = openGraphDb(project, null);
    try {
      const stats = await buildLayer(db, project, sha, "base", { force: true, links: "language-tool" });
      expect(stats.linksNote ?? "").toContain("so the built-in rules");
      expect(stats.linksNote ?? "").toContain("`tmb tools install");
    } finally {
      db.close();
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
    expect(toolsHeld()).toEqual([]);
  });
});

describe("tmb tools install", () => {
  const output = () => {
    const lines = { out: [] as string[], err: [] as string[] };
    return { lines, sink: { out: (line: string) => lines.out.push(line), err: (line: string) => lines.err.push(line) } };
  };

  test("a language's toolchain is refused, and nothing is downloaded", async () => {
    let fetched = 0;
    const fetch = async () => {
      fetched++;
      return new Response("");
    };
    for (const language of ["go", "java"]) {
      const { lines, sink } = output();
      expect(await runToolsCommand(["install", language], scratch, sink, options({ fetch }))).toBe(1);
      expect(lines.err.join("\n")).toContain("never a language");
    }
    expect(fetched).toBe(0);
  });

  test("rust-analyzer's real pin, with a release whose bytes do not match its checksum: nothing installed", async () => {
    setEnv("CARGO_HOME", path.join(scratch, "cargo"));
    const fetch = async () => new Response(gzipSync(program("rust-analyzer 0.3.0-standalone (abc 2026-11-08)")));
    const { lines, sink } = output();
    expect(await runToolsCommand(["install", "rust"], scratch, sink, options({ fetch }))).toBe(1);
    expect(lines.err.join("\n")).toContain("checksum");
    expect(toolsHeld()).toEqual([]);
  });

  test("a language tmb carries the tool of has nothing to install", async () => {
    const { lines, sink } = output();
    expect(await runToolsCommand(["install", "typescript"], scratch, sink, options())).toBe(0);
    expect(lines.out.join("\n")).toContain("carries");
  });

  test("a language that is not one tmb reads is a usage error", async () => {
    const { sink } = output();
    expect(await runToolsCommand(["install", "cobol"], scratch, sink, options())).toBe(2);
  });
});

describe("the pins", () => {
  // The platforms tmb installs for: macOS on Apple silicon and Intel, Linux on x64 and arm64, Windows.
  const OFFICIAL: Record<string, string> = {
    "rust-analyzer": "https://github.com/rust-lang/rust-analyzer/releases/download/",
    clangd: "https://github.com/clangd/clangd/releases/download/",
  };

  for (const tool of [rustAnalyzer, clangdTool]) {
    test(`${tool.name}: each asset is on the tool's own release page, with a sha256`, () => {
      const copy = tool.copy as Extract<ToolCopy, { program: string }>;
      const release = copy.release!;
      for (const [platform, asset] of Object.entries(release.assets)) {
        expect(PLATFORMS as readonly string[]).toContain(platform);
        expect(asset!.url.startsWith(`${OFFICIAL[tool.name]}${release.version}/`)).toBe(true);
        expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) expect(Object.keys(release.assets)).toContain(platform);
    });
  }

  test("rust-analyzer's pin is at or above the lowest tmb supports, and has a Linux arm64 build", () => {
    const release = (rustAnalyzer.copy as Extract<ToolCopy, { program: string }>).release!;
    expect(release.version >= LOWEST_COMMIT_DAY).toBe(true);
    expect(Object.keys(release.assets)).toContain("linux-arm64");
  });

  test("clangd's pin is at or above the lowest tmb supports", () => {
    const release = (clangdTool.copy as Extract<ToolCopy, { program: string }>).release!;
    expect(Number(release.version.split(".")[0])).toBeGreaterThanOrEqual(Number(LOWEST_CLANGD));
  });
});
