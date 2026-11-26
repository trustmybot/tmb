// Way B for Java (trustmybot/tmb#353): javac makes the links of the graph's calls. It asks the
// compiler; it does not imitate it. tmb carries a small adapter (javac_links.java) that uses only
// the JDK's compiler API, and runs it with the user's own `java`. The repo's files are read from the
// commit; javac reads no class path, runs no annotation processor and downloads nothing, so a call
// into a library is not known. For each call the built-in parser found, the declaration javac names
// is:
// - linked, when it is in the repo and one node of the graph fits it by place: in its file, of its
//   name, over its lines; when two fit, the one that starts on its first line;
// - outside, when javac reads it from outside the repo: the JDK;
// - not known, otherwise: no answer, an answer that rests on an error, a declaration no file
//   writes, or a class two files declare (javac_links.java says each).
// Without `java` on PATH, way B for Java cannot run, and the built-in rules make the links.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ADAPTER from "./javac_links.java" with { type: "text" };
import type { BuiltWith, LanguageTool, ToolAnswer, ToolInput } from "../contract.ts";

/** The longest the adapter's output may be. */
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

/** The file name the adapter is run from: `java` runs a source file by its name. */
const ADAPTER_FILE = "javac_links.java";

/**
 * A module declaration's file (JLS 7.7), which javac is not given: every file is read in the
 * unnamed module, which reads every module of the JDK, and a repo with several modules is read as
 * one.
 */
export const MODULE_DECLARATION = "module-info.java";

const NOT_KNOWN: ToolAnswer = { state: "not_known" };
const OUTSIDE: ToolAnswer = { state: "outside" };

/** The adapter's answer for one call; see javac_links.java. */
export type AdapterCall = {
  file: string;
  pos: number;
  line: number;
  name: string;
  callee: "name" | "qualified" | "creation" | "this" | "super";
  answer: { repo?: { file: string; name: string; start: number; end: number }; outside?: string; notKnown?: string };
};

export type AdapterOutput = { java: string; errors: number; firstErrors: string[]; calls: AdapterCall[] };

/** The `java` on PATH, as `java -version` reports it, or why it does not run. */
function javaVersion(): { version: string } | { unavailable: string } {
  const run = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (run.error !== undefined) return { unavailable: "no `java` on PATH" };
  if (run.status !== 0) return { unavailable: `\`java -version\` failed: ${run.stderr.trim()}` };
  // The JDK reports its version on standard error.
  return { version: `${run.stdout}${run.stderr}`.trim() };
}

/** Runs the adapter on the repo's Java files at the commit, written to a scratch folder, and returns its answer. */
export function runAdapter(input: Pick<ToolInput, "files">): AdapterOutput {
  const scratch = mkdtempSync(path.join(tmpdir(), "tmb-javac-"));
  try {
    const repo = path.join(scratch, "repo");
    for (const [rel, text] of input.files) {
      if (!rel.endsWith(".java") || path.posix.basename(rel) === MODULE_DECLARATION) continue;
      const file = path.join(repo, ...rel.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    mkdirSync(repo, { recursive: true });
    // The class path: an empty folder.
    const classes = path.join(scratch, "classes");
    mkdirSync(classes);
    const adapter = path.join(scratch, "adapter");
    mkdirSync(adapter);
    writeFileSync(path.join(adapter, ADAPTER_FILE), ADAPTER);
    const run = spawnSync("java", [path.join(adapter, ADAPTER_FILE), repo, classes], { cwd: adapter, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
    if (run.error !== undefined || run.status !== 0) throw new Error(`the javac adapter failed: ${run.error?.message ?? run.stderr.trim()}`);
    return JSON.parse(run.stdout) as AdapterOutput;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type Place = { index: number; name: string; start: number; end: number };

/**
 * The node a declaration in the repo is, by place (CODE_GRAPH.md, "Two ways to make links"): of
 * its name, in its file, over its lines; when two fit, the one that starts on its first line; or
 * none.
 */
export function nodeOf(nodes: readonly Place[], decl: { name: string; start: number; end: number }): number | undefined {
  const fit = nodes.filter((n) => n.name === decl.name && n.start <= decl.end && n.end >= decl.start);
  if (fit.length === 1) return fit[0]!.index;
  const sameStart = fit.filter((n) => n.start === decl.start);
  return sameStart.length === 1 ? sameStart[0]!.index : undefined;
}

/** The answers for the graph's calls, one per call, in order. */
export function answerCalls(input: ToolInput, out: AdapterOutput): ToolAnswer[] {
  const nodesByFile = new Map<string, Place[]>();
  input.nodes.forEach((node, index) => {
    const here = nodesByFile.get(node.path) ?? [];
    here.push({ index, name: node.name, start: node.start, end: node.end });
    nodesByFile.set(node.path, here);
  });
  const byPlace = new Map<string, AdapterCall>();
  for (const c of out.calls) byPlace.set(`${c.file}\u0000${c.pos}\u0000${c.name}`, c);
  const answerOf = (c: AdapterCall): ToolAnswer => {
    const { repo, outside } = c.answer;
    if (outside !== undefined) return OUTSIDE;
    if (repo === undefined) return NOT_KNOWN;
    const node = nodeOf(nodesByFile.get(repo.file) ?? [], repo);
    return node === undefined ? NOT_KNOWN : { nodes: [node] };
  };
  // A call is answered by javac's call at its position, of its name; a call javac has none at is
  // not known.
  return input.calls.map((call) => {
    const c = byPlace.get(`${call.path}\u0000${call.pos}\u0000${call.name}`);
    return c === undefined ? NOT_KNOWN : answerOf(c);
  });
}

/** javac, way B's tool for Java. */
export const javacTool: LanguageTool = {
  name: "javac",
  open() {
    const java = javaVersion();
    if ("unavailable" in java) return java;
    return { answer: (input: ToolInput) => answerCalls(input, runAdapter(input)) };
  },
  // The tool is the user's JDK, as it reports its version. javac reads no class path, so its
  // answers rest on no installed package.
  builtWith(): BuiltWith {
    const java = javaVersion();
    return { tool: "unavailable" in java ? `cannot run: ${java.unavailable}` : java.version, packages: "" };
  },
};
