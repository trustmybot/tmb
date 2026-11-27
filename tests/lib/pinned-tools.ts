// The test setup's install of the tools way B loads from tmb's tools folder (CODE_GRAPH.md, "Where
// a language's tool comes from"): the TypeScript compiler and pyright, each at tmb's pin, from the
// tool's own registry and checked against the digest tmb carries, by tmb's own installer. They go
// into the state folder the tests run with (isolate-state.ts sets it), the one the find order reads.
// A download is kept in a folder of the test machine's temporary files, so a later run downloads
// nothing; it is checked against the digest each time, as any download is.
// The way B tests and the benchmark call it before they build a graph; nothing else downloads.
//
// The benchmark's second judge of Python's links, Jedi (trustmybot/tmb#427), is no tool of tmb's:
// it is installed here too, from Python's package registry at a pinned version, each file checked
// against the digest written below, and unpacked by Python's own `zipfile` into a folder of the
// kept downloads.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCopy } from "../../src/engine/graph/languages/contract.ts";
import { pyright } from "../../src/engine/graph/languages/python/tool.ts";
import { typescriptCompiler } from "../../src/engine/graph/languages/typescript/tool.ts";
import { findCopy, machinePlaces } from "../../src/engine/graph/tool-copy.ts";
import { installTool } from "../../src/engine/graph/tool-install.ts";

/** The tools tmb installs that way B loads from its tools folder. */
const PINNED: readonly ToolCopy[] = [typescriptCompiler.copy, pyright.copy];

/** Where a download is kept between runs: TMB_TOOL_DOWNLOADS, else a folder of the temporary files. */
const downloads = (): string => process.env.TMB_TOOL_DOWNLOADS ?? path.join(tmpdir(), "tmb-tool-downloads");

/** A fetch that answers from a kept download, else downloads and keeps it. */
async function keptFetch(url: string): Promise<Response> {
  const file = path.join(downloads(), path.basename(new URL(url).pathname));
  try {
    return new Response(readFileSync(file));
  } catch {
    const response = await fetch(url);
    if (!response.ok) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    mkdirSync(downloads(), { recursive: true });
    const partial = `${file}.${process.pid}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, file);
    return new Response(bytes);
  }
}

let installing: Promise<void> | undefined;

/** Installs each pinned tool the find order does not find yet; throws when one cannot be installed. */
export function installPinnedTools(): Promise<void> {
  installing ??= (async () => {
    const places = machinePlaces();
    for (const copy of PINNED) {
      if (!("missing" in findCopy(copy, places))) continue;
      const result = await installTool(copy, { places, fetch: keptFetch });
      if ("failed" in result) throw new Error(`the test setup could not install ${"library" in copy ? copy.library : copy.what}: ${result.failed}`);
    }
  })();
  return installing;
}

/** A file of Python's package registry, pinned by its digest. */
type Wheel = { url: string; sha256: string };

/**
 * Jedi, the benchmark's second judge of Python's links, and parso, the parser it reads with: pure
 * Python wheels at pinned versions. Jedi 0.20 runs on Python 3.10 and later.
 */
export const JEDI = {
  version: "0.20.1",
  python: { major: 3, minor: 10 },
  wheels: [
    { url: "https://files.pythonhosted.org/packages/be/c7/71eb0d51cdcbb63b857c931aa4e9218b078b5d9f8ecd383b234f28fe7b0f/jedi-0.20.1-py2.py3-none-any.whl", sha256: "0fb16d86c4a4c73c37ba518c77419975e30fcc620658a8d14fbb5720cdd34142" },
    { url: "https://files.pythonhosted.org/packages/99/5d/8268b644392ee874ee82a635cd0df1773de230bde356c38de28e298392cc/parso-0.8.7-py2.py3-none-any.whl", sha256: "a8926eb2a1b915486941fdbd31e86a4baf88fe8c210f25f2f35ecec5b574ca1c" },
  ] satisfies Wheel[],
} as const;

/** The file in an unpacked folder that says every wheel was checked and unpacked into it. */
const UNPACKED = ".unpacked";

let judging: Promise<string> | undefined;

/**
 * The folder that holds Jedi and parso, for `python` to import: each wheel downloaded once, checked
 * against its digest, and unpacked by `python -I -m zipfile`. Throws when a wheel cannot be had or
 * its digest differs.
 */
export function installJedi(python: string): Promise<string> {
  judging ??= (async () => {
    const folder = path.join(downloads(), `jedi-${JEDI.version}`);
    if (existsSync(path.join(folder, UNPACKED))) return folder;
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    for (const wheel of JEDI.wheels) {
      const response = await keptFetch(wheel.url);
      if (!response.ok) throw new Error(`the test setup could not download ${wheel.url}: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const actual = createHash("sha256").update(bytes).digest("hex");
      const file = path.join(downloads(), path.basename(new URL(wheel.url).pathname));
      if (actual !== wheel.sha256) {
        rmSync(file, { force: true });
        throw new Error(`${wheel.url} has digest ${actual}, not ${wheel.sha256}`);
      }
      const unpack = spawnSync(python, ["-I", "-m", "zipfile", "-e", file, folder], { encoding: "utf8" });
      if (unpack.error !== undefined || unpack.status !== 0) throw new Error(`${python} could not unpack ${file}: ${unpack.error?.message ?? unpack.stderr}`);
    }
    writeFileSync(path.join(folder, UNPACKED), JEDI.version);
    return folder;
  })();
  return judging;
}
