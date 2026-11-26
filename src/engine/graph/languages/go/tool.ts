// Way B for Go (trustmybot/tmb#352): Go's own type checker, go/types, makes the links of the graph's
// calls. It asks the compiler; it does not imitate it. tmb carries a small helper (gotypes.go) that
// uses only Go's standard library, and runs it with the user's own `go`: `go list` lays the repo's
// packages out under the default build configuration, and go/types checks them. For each call the
// built-in parser found, the declaration go/types names is:
// - linked, when it is in the repo and exactly one node of the graph: of its name, in its file,
//   the innermost whose lines hold the declaration's name;
// - outside, when it is outside the repo: Go's standard library, a module on disk, or a
//   predeclared name such as `len`;
// - not known, otherwise: no answer, a local, a parameter, a field, an error the type checker
//   reports in the call, or a file it does not load (one its build constraints leave out).
//
// It runs no code of the repo and downloads nothing. The repo's files are read from the commit;
// the modules it needs from the module cache on disk (GOPROXY=off), and without them a call into
// them is not known. Without `go` on PATH, way B for Go cannot run, and the built-in rules make
// the links.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import GOTYPES from "./gotypes.go" with { type: "text" };
import type { BuiltWith, LanguageTool, ToolAnswer, ToolInput } from "../contract.ts";

/** The settings files of a Go module or workspace that the go command reads beside the code ("Modules", "Workspaces", "Vendoring"). */
export const SETTINGS_FILES = ["go.mod", "go.sum", "go.work", "go.work.sum", "vendor/modules.txt"] as const;

/**
 * The environment the helper runs in: no module is downloaded (GOPROXY=off), no other Go
 * toolchain is fetched (GOTOOLCHAIN=local), and no C compiler runs, so cgo's files are left out
 * (CGO_ENABLED=0).
 */
export const HELPER_ENV = { GOPROXY: "off", GOTOOLCHAIN: "local", CGO_ENABLED: "0", GOWORK: "off" } as const;

/** The longest the helper's output may be. */
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

const NOT_KNOWN: ToolAnswer = { state: "not_known" };
const OUTSIDE: ToolAnswer = { state: "outside" };

/** What a declaration in the repo must be to be a node of the graph: no local, parameter or field. */
export const NODE_DECLARATIONS: ReadonlySet<string> = new Set(["func", "method", "interface method", "type", "var", "const"]);

/** The helper's answer for one call; see gotypes.go. */
export type HelperCall = {
  file: string;
  pos: number;
  off: number;
  line: number;
  name: string;
  /** How the callee is written: a name (`f`), through a package's name (`pkg.F`), a selector (`x.f`), or other. */
  callee: "name" | "pkgname" | "selector" | "other";
  kind: "call" | "conversion" | "builtin";
  answer: { repo?: { file: string; line: number; name: string; what: string }; outside?: string; notKnown?: string };
};

export type HelperOutput = { go: string; modules: string[]; errors: number; firstErrors: string[]; loaded: string[]; calls: HelperCall[] };

/** The `go` on PATH, as `go version` reports it, or why it does not run. */
function goVersion(): { version: string } | { unavailable: string } {
  const run = spawnSync("go", ["version"], { encoding: "utf8", env: { ...process.env, ...HELPER_ENV } });
  if (run.error !== undefined) return { unavailable: "no `go` on PATH" };
  if (run.status !== 0) return { unavailable: `\`go version\` failed: ${run.stderr.trim()}` };
  return { version: run.stdout.trim() };
}

/** The files that list the module versions a module or a workspace needs, with their checksums ("go.sum files"). */
const SUM_FILES = ["go.sum", "go.work.sum"] as const;

/**
 * A module path or version as the module cache writes it: each capital letter as `!` and the letter
 * in lower case, so the cache is the same on a file system that ignores case (Go Modules Reference,
 * "Module cache"; golang.org/x/mod/module, EscapePath).
 */
const caseEncoded = (text: string): string => text.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);

/**
 * The module cache's folder for each module version the repo's go.sum files list, by path from the
 * module cache: `<module>@<version>`, case-encoded. A line for a module's go.mod alone
 * (`<version>/go.mod`) names no module's code, so it names no folder.
 */
export function cacheFolders(sums: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const text of sums) {
    for (const line of text.split("\n")) {
      const [module, version] = line.trim().split(/\s+/);
      if (module === undefined || version === undefined || version.endsWith("/go.mod")) continue;
      out.add(`${caseEncoded(module)}@${caseEncoded(version)}`);
    }
  }
  return [...out].sort();
}

/** Every folder that holds a Go file, and each folder above it, up to the repo's root ("."). */
function foldersOf(files: Iterable<string>): Set<string> {
  const out = new Set<string>(["."]);
  for (const file of files) for (let d = path.posix.dirname(file); d !== "." && !out.has(d); d = path.posix.dirname(d)) out.add(d);
  return out;
}

/**
 * Runs the helper on the repo's files at the commit, written to a scratch folder with the module
 * settings files of every folder that holds Go code, and returns its answer.
 */
export function runHelper(input: Pick<ToolInput, "files" | "read">): HelperOutput {
  const scratch = mkdtempSync(path.join(tmpdir(), "tmb-gotypes-"));
  try {
    const repo = path.join(scratch, "repo");
    const write = (rel: string, text: string) => {
      const file = path.join(repo, ...rel.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    for (const [rel, text] of input.files) if (rel.endsWith(".go")) write(rel, text);
    for (const dir of foldersOf(input.files.keys())) {
      for (const name of SETTINGS_FILES) {
        const rel = dir === "." ? name : `${dir}/${name}`;
        const text = input.read(rel);
        if (text !== undefined) write(rel, text);
      }
    }
    const helper = path.join(scratch, "helper");
    mkdirSync(helper);
    writeFileSync(path.join(helper, "gotypes.go"), GOTYPES);
    const run = spawnSync("go", ["run", "gotypes.go", repo], { cwd: helper, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, ...HELPER_ENV } });
    if (run.error !== undefined || run.status !== 0) throw new Error(`the Go helper failed: ${run.error?.message ?? run.stderr.trim()}`);
    return JSON.parse(run.stdout) as HelperOutput;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The answers for the graph's calls, one per call, in order. */
export function answerCalls(input: ToolInput, out: HelperOutput): ToolAnswer[] {
  const nodesByFile = new Map<string, { index: number; name: string; start: number; end: number }[]>();
  input.nodes.forEach((node, index) => {
    const here = nodesByFile.get(node.path) ?? [];
    here.push({ index, ...node });
    nodesByFile.set(node.path, here);
  });
  const byPlace = new Map<string, HelperCall>();
  for (const c of out.calls) if (c.name !== "") byPlace.set(`${c.file}\u0000${c.pos}\u0000${c.name}`, c);
  const answerOf = (c: HelperCall): ToolAnswer => {
    const { repo, outside } = c.answer;
    if (outside !== undefined) return OUTSIDE;
    if (repo === undefined || !NODE_DECLARATIONS.has(repo.what)) return NOT_KNOWN;
    const nodes = (nodesByFile.get(repo.file) ?? []).filter((n) => n.name === repo.name && n.start <= repo.line && n.end >= repo.line);
    // A method of an interface sits inside its type, which may share its name: the declaration
    // is the innermost node that holds its line, when only one is.
    const size = Math.min(...nodes.map((n) => n.end - n.start));
    const innermost = nodes.filter((n) => n.end - n.start === size);
    return innermost.length === 1 ? { nodes: [innermost[0]!.index] } : NOT_KNOWN;
  };
  // A call is answered by the helper's call at its position, of its name; a call the helper has
  // none at, as in a file it does not load, is not known.
  return input.calls.map((call) => {
    const c = byPlace.get(`${call.path}\u0000${call.pos}\u0000${call.name}`);
    return c === undefined ? NOT_KNOWN : answerOf(c);
  });
}

/** The go.sum files of every folder that holds Go code, and of each folder above it, at the commit. */
function sumsOf(input: Pick<ToolInput, "files" | "read">): string[] {
  const out: string[] = [];
  for (const dir of foldersOf(input.files.keys())) {
    for (const name of SUM_FILES) {
      const text = input.read(dir === "." ? name : `${dir}/${name}`);
      if (text !== undefined) out.push(text);
    }
  }
  return out;
}

/** Where the go command keeps the module cache, as `go env` reports it with the user's own settings; null when it does not say. */
function moduleCache(): string | null {
  const run = spawnSync("go", ["env", "GOMODCACHE"], { encoding: "utf8", env: { ...process.env, ...HELPER_ENV } });
  return run.error === undefined && run.status === 0 && run.stdout.trim() !== "" ? run.stdout.trim() : null;
}

/** Go's type checker, way B's tool for Go. */
export const goTypeChecker: LanguageTool = {
  name: "Go's type checker (go/types)",
  open() {
    const go = goVersion();
    if ("unavailable" in go) return go;
    return {
      answer: (input: ToolInput, _note: (text: string) => void, readFrom: (places: readonly string[]) => void) => {
        readFrom(cacheFolders(sumsOf(input)));
        return answerCalls(input, runHelper(input));
      },
    };
  },
  // The tool is the user's `go`, as it reports its version. The installed packages are the module
  // cache: of each module version go.sum lists, whether the cache holds it.
  builtWith(_repoDir: string, places: readonly string[]): BuiltWith {
    const go = goVersion();
    if ("unavailable" in go) return { tool: `cannot run: ${go.unavailable}`, packages: "" };
    const cache = moduleCache();
    const held = places.map((place) => `${place}: ${cache !== null && existsSync(path.join(cache, ...place.split("/"))) ? "held" : "not held"}`);
    return { tool: go.version, packages: [`module cache: ${cache ?? "none"}`, ...held].join("\n") };
  },
};
