// The candidates for way B in C and C++, each run the same way: given the repo, its graph and
// the compiler's reference, the declarations it gives for each call.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clangdAnswers } from "./clangd.ts";
import { clangPerUnitAnswers, type Answers, type Graph, type Reference } from "./lib.ts";
import { readIndex, runScipClang, scipAnswers } from "./scip.ts";

export const CANDIDATES = ["clang", "clangd-apple", "clangd", "scip-clang"] as const;
export type Candidate = (typeof CANDIDATES)[number];

export const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
};

/** Whether every tool the candidates need is named by the environment. */
export const toolsSet = () => ["TMB_LIBCLANG", "TMB_CINDEX", "TMB_CLANGD_APPLE", "TMB_CLANGD", "TMB_SCIP_CLANG", "TMB_GRAMMAR_C", "TMB_GRAMMAR_CPP"].every((n) => process.env[n]);

export type Run = { answers: Answers; timing: Record<string, number | string> } | { notRun: string };

export async function runCandidate(cand: Candidate, o: { root: string; cdb: string | null; out: string; graph: Graph; ref: Reference; language: "c" | "cpp"; indexTimeoutMs: number }): Promise<Run> {
  if (cand === "clang") return { answers: clangPerUnitAnswers(o.ref), timing: {} };
  if (cand === "clangd-apple" || cand === "clangd") {
    let cdbDir: string | null = null;
    if (o.cdb !== null) {
      // A folder of its own for each run, since clangd keeps its index beside the database.
      cdbDir = path.join(o.out, `${cand}-cdb`);
      rmSync(cdbDir, { recursive: true, force: true });
      mkdirSync(cdbDir, { recursive: true });
      copyFileSync(o.cdb, path.join(cdbDir, "compile_commands.json"));
    }
    const run = await clangdAnswers({ binary: env(cand === "clangd" ? "TMB_CLANGD" : "TMB_CLANGD_APPLE"), root: o.root, cdbDir, language: o.language, indexTimeoutMs: o.indexTimeoutMs, parallelFiles: 4 }, o.graph.calls);
    return { answers: run.answers, timing: { version: run.version, startMs: Math.round(run.startMs), indexMs: Math.round(run.indexMs), askMs: Math.round(run.askMs) } };
  }
  if (o.cdb === null) return { notRun: "scip-clang reads a compile database and runs with none only on a database it is given" };
  const index = path.join(o.out, "index.scip");
  rmSync(index, { force: true });
  const run = runScipClang(env("TMB_SCIP_CLANG"), o.root, o.cdb, index);
  if (!existsSync(index)) return { notRun: `scip-clang wrote no index: ${run.stderr.slice(0, 500)}` };
  return { answers: scipAnswers(readIndex(index), o.graph.calls), timing: { indexMs: Math.round(run.ms), status: String(run.status) } };
}

/** The macOS SDK, which a compile database must name for a tool built on clang that is not Apple's. */
export function sdkPath(): string {
  const r = spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** A compile database for a folder of sources: one entry per file, each compiled alone with the given flags. */
export function writeCdb(root: string, files: string[], compiler: string, flags: string[], out: string): string {
  const sdk = sdkPath();
  const entries = files.map((f) => ({ directory: path.dirname(path.join(root, f)), file: path.basename(f), arguments: [compiler, ...flags, ...(sdk ? ["-isysroot", sdk] : []), "-c", path.basename(f)] }));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(entries, null, 1));
  return out;
}
