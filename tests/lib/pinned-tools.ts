// The test setup's install of the tools way B loads from tmb's tools folder (CODE_GRAPH.md, "Where
// a language's tool comes from"): the TypeScript compiler and pyright, each at tmb's pin, from the
// tool's own registry and checked against the digest tmb carries, by tmb's own installer. They go
// into the state folder the tests run with (isolate-state.ts sets it), the one the find order reads.
// A download is kept in a folder of the test machine's temporary files, so a later run downloads
// nothing; it is checked against the digest each time, as any download is.
// The way B tests and the benchmark call it before they build a graph; nothing else downloads.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
