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
// them is not known. The `go` is the user's, as the find order finds it (tool-copy.ts): tmb installs
// a tool, never a language. Without it, way B for Go cannot run, and the built-in rules make the
// links.
//
// The helper is built once (CODE_GRAPH.md, "Go's helper is built once"; trustmybot/tmb#394): the
// first time a Go repo is indexed, with the user's `go`, the same one that then runs its `go list`,
// into tmb's tools folder under its name and its key, `<state>/tools/gotypes/<key>/gotypes`. The key
// is a digest of all the build rests on: the source, the build's go.mod and recipe, the exact Go
// version and the machine's kind. A helper built by an older Go than the one that runs `go list`
// gives wrong answers, so a new key builds a new helper, and the old one is removed once it is
// built. The build takes none of the user's Go settings; the run takes them as before.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import GOTYPES from "./gotypes.go" with { type: "text" };
import { atLeast, machinePlaces, toolsFolder, versionNumbers } from "../../tool-copy.ts";
import type { BuiltHelper, BuiltWith, FoundCopy, LanguageTool, ToolAnswer, ToolInput } from "../contract.ts";

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

/**
 * The helper's output; see gotypes.go. `cannotCheck` names each package, or module, the type
 * checker could not check at all, with why: then its answers are no answers.
 */
export type HelperOutput = { go: string; modules: string[]; errors: number; firstErrors: string[]; cannotCheck: string[]; loaded: string[]; calls: HelperCall[] };

/** The program way B for Go runs: the user's own `go`. */
export const GO = "go";

/**
 * The lowest Go tmb supports: the helper calls go/ast's Unparen, which Go 1.22 added (Go's API
 * list, api/go1.22.txt).
 */
export const LOWEST_GO = "1.22";

/** `go version`: `go version go<version>[-…] <os>/<arch>`, or a development build's `devel go<version>-…`. */
const VERSION_LINE = /\bgo(\d+(?:\.\d+)*)/;

/** Whether a report is at or above the lowest Go tmb supports. */
export function supportedGo(report: string): boolean {
  const match = VERSION_LINE.exec(report.replace(/^go version /, ""));
  return match !== null && atLeast(versionNumbers(match[1]!), versionNumbers(LOWEST_GO));
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

/** The helper's name: its folder in tmb's tools folder, and its program's name there. */
export const HELPER = "gotypes";

/** The helper's file name on this platform. */
const helperFile = (): string => (process.platform === "win32" ? `${HELPER}.exe` : HELPER);

/**
 * The go.mod the helper is built under, in a folder of its own: no go.mod above the folder takes the
 * build over, and the helper compiles at the language level of the lowest Go tmb supports.
 */
export const BUILD_GO_MOD = `module tmb.invalid/${HELPER}\n\ngo ${LOWEST_GO}\n`;

/** How the helper is built: with no build paths and no version control facts in it, so one source and one Go build one program. */
export const BUILD_FLAGS = ["-trimpath", "-buildvcs=false"] as const;

/**
 * The environment the helper is built in, over the user's with every Go setting taken out (each
 * variable `go env` reports, and its settings file, GOENV): nothing is downloaded and no other
 * toolchain fetched, no workspace takes over, no C compiler runs, and it is built for this machine.
 */
export const BUILD_ENV = { GOENV: "off", GOPROXY: "off", GOTOOLCHAIN: "local", GOWORK: "off", CGO_ENABLED: "0", GOFLAGS: "" } as const;

/** The build's recipe, as the key reads it: its flags and environment. */
const BUILD_RECIPE = JSON.stringify({ flags: BUILD_FLAGS, env: BUILD_ENV });

/** The digest of the helper's source tmb carries. */
export const HELPER_SOURCE = createHash("sha256").update(GOTYPES).digest("hex");

/** What a built helper rests on: its source, the build's go.mod and recipe, the Go that builds it, exactly, and the machine's kind. */
export type HelperParts = { source: string; goMod: string; recipe: string; goVersion: string; host: string };

/** The helper's key: a digest of all it rests on. Where the `go` is is not part of it: one Go version builds one program. */
export function helperKey(parts: HelperParts): string {
  return createHash("sha256").update(JSON.stringify([parts.source, parts.goMod, parts.recipe, parts.goVersion, parts.host])).digest("hex");
}

/** What `go env` reports of a `go`, run as the helper runs it, with the user's own settings. */
type GoEnv = Record<string, string>;

/** The `go`'s environment as it reports it, or why it does not say. */
function goEnv(program: string): GoEnv | { fails: string } {
  const run = spawnSync(program, ["env", "-json"], { encoding: "utf8", env: { ...process.env, ...HELPER_ENV } });
  if (run.error !== undefined) return { fails: run.error.message };
  if (run.status !== 0) return { fails: `\`go env\` failed: ${(run.stderr ?? "").trim()}` };
  try {
    return JSON.parse(run.stdout) as GoEnv;
  } catch {
    return { fails: "`go env -json` gave no settings" };
  }
}

/** The helper the `go` builds and where it is kept in the tools folder, from what `go env` reports. */
function helperOf(env: GoEnv, stateDir: string): BuiltHelper {
  const builtBy = env.GOVERSION ?? "";
  const key = helperKey({ source: HELPER_SOURCE, goMod: BUILD_GO_MOD, recipe: BUILD_RECIPE, goVersion: builtBy, host: `${env.GOHOSTOS ?? ""}/${env.GOHOSTARCH ?? ""}` });
  const file = path.join(toolsFolder(stateDir), HELPER, key, helperFile());
  return { name: HELPER, key, source: HELPER_SOURCE, builtBy, path: file, built: existsSync(file) };
}

/** The helper the `go` builds, and whether it is built; null when the `go` does not say what it is. */
export function goHelper(program: string, stateDir: string): BuiltHelper | null {
  const env = goEnv(program);
  return "fails" in env ? null : helperOf(env, stateDir);
}

/**
 * The helper the `go` builds: built once, the first time it is asked for. It is built in a folder of
 * its own under a temporary name and moved into place, so two builds at once each leave a whole
 * program; then each helper of another key is removed. Throws why it could not be built.
 */
export function builtHelper(program: string, stateDir: string): string {
  const env = goEnv(program);
  if ("fails" in env) throw new Error(`the Go helper could not be built: ${env.fails}`);
  const helper = helperOf(env, stateDir);
  if (helper.built) return helper.path;
  const folder = path.dirname(helper.path);
  mkdirSync(folder, { recursive: true });
  const work = mkdtempSync(path.join(folder, ".build-"));
  try {
    writeFileSync(path.join(work, `${HELPER}.go`), GOTYPES);
    writeFileSync(path.join(work, "go.mod"), BUILD_GO_MOD);
    // None of the user's Go settings; the user's build cache, and the `go`'s own root.
    const user = Object.fromEntries(Object.entries(process.env).filter(([name]) => !(name in env)));
    const buildEnv = { ...user, ...BUILD_ENV, GOCACHE: env.GOCACHE ?? "", GOROOT: env.GOROOT ?? "" };
    const out = path.join(work, helperFile());
    const run = spawnSync(program, ["build", ...BUILD_FLAGS, "-o", out, "."], { cwd: work, encoding: "utf8", env: buildEnv });
    if (run.error !== undefined || run.status !== 0) throw new Error(`the Go helper could not be built: ${run.error?.message ?? (run.stderr ?? "").trim()}`);
    renameSync(out, helper.path);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const all = path.dirname(folder);
  for (const other of readdirSync(all)) {
    if (other !== helper.key && existsSync(path.join(all, other, helperFile()))) rmSync(path.join(all, other), { recursive: true, force: true });
  }
  return helper.path;
}

/**
 * Runs the helper on the repo's files at the commit, written to a scratch folder with the module
 * settings files of every folder that holds Go code, and returns its answer. The helper is the one
 * `program` builds, and its `go list` runs `program`. A package it could not check at all makes the
 * whole answer no answer: it throws why.
 */
export function runHelper(input: Pick<ToolInput, "files" | "read">, program: string = GO, helper: string = builtHelper(program, machinePlaces().stateDir)): HelperOutput {
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
    const run = spawnSync(helper, [program, repo], { cwd: scratch, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, ...HELPER_ENV } });
    if (run.error !== undefined || run.status !== 0) throw new Error(`the Go helper failed: ${run.error?.message ?? run.stderr.trim()}`);
    const out = JSON.parse(run.stdout) as HelperOutput;
    if (out.cannotCheck.length > 0) throw new Error(`go/types could not check ${out.cannotCheck.join("; ")}`);
    return out;
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
function moduleCache(program: string): string | null {
  const run = spawnSync(program, ["env", "GOMODCACHE"], { encoding: "utf8", env: { ...process.env, ...HELPER_ENV } });
  return run.error === undefined && run.status === 0 && run.stdout.trim() !== "" ? run.stdout.trim() : null;
}

/** Go's type checker, way B's tool for Go. */
export const goTypeChecker: LanguageTool = {
  name: "Go's type checker (go/types)",
  copy: {
    program: GO,
    what: "the `go` command",
    versionArgs: ["version"],
    env: HELPER_ENV,
    report: ({ stdout }) => stdout.trim(),
    lowest: `Go ${LOWEST_GO}`,
    supported: supportedGo,
    tmbInstalls: false,
  },
  open(_repoDir, found) {
    const program = found.path ?? GO;
    // The first index of a Go repo builds the helper; a failed build means the built-in rules.
    let helper: string;
    try {
      helper = builtHelper(program, machinePlaces().stateDir);
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) };
    }
    return {
      answer: (input: ToolInput, _note: (text: string) => void, readFrom: (places: readonly string[]) => void) => {
        readFrom(cacheFolders(sumsOf(input)));
        return answerCalls(input, runHelper(input, program, helper));
      },
    };
  },
  helper: (found: FoundCopy, stateDir: string) => goHelper(found.path ?? GO, stateDir),
  // The installed packages are the module cache: of each module version go.sum lists, whether the
  // cache holds it.
  builtWith(_repoDir: string, places: readonly string[], found): BuiltWith {
    const cache = moduleCache(found.path ?? GO);
    const held = places.map((place) => `${place}: ${cache !== null && existsSync(path.join(cache, ...place.split("/"))) ? "held" : "not held"}`);
    return { packages: [`module cache: ${cache ?? "none"}`, ...held].join("\n") };
  },
};
