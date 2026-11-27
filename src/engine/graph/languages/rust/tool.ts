// Way B for Rust (trustmybot/tmb#354): rust-analyzer makes the links of the graph's
// calls. It asks rust-analyzer; it does not imitate it. Its `scip` command writes, for every name of
// the repo's code it resolves, the symbol the name refers to and where that symbol is defined, and
// its `diagnostics` command the errors it reports. For each call the built-in parser found, the
// symbol rust-analyzer gives at the call's name is:
// - linked, when it is defined in the repo, at one place, and that place is one node of the graph:
//   in the same file, of the same name, its lines holding the definition; when two hold it, the one
//   that starts on its line. An enum's variant links to its enum, and a tuple struct's name is the
//   struct, so a construction links to its type;
// - outside, when it belongs to no package of the repo: the standard library, or a dependency;
// - not known, otherwise: no symbol, a local, a symbol defined at two places, a definition that is
//   no node, a call rust-analyzer reports an error in, or a file it does not load (one `cfg` leaves
//   out, or one of no Cargo package).
//
// It runs no code of the repo and downloads nothing. The repo's `.rs` files and Cargo's manifests
// are read from the commit into a scratch folder; Cargo runs offline, so a dependency that is not on
// disk is not loaded, and a call into it is not known. No build script and no proc macro runs: what
// rust-analyzer cannot know without them is not known.
//
// A name written as a call in a macro's input, the name then a group in parentheses, is no call
// the parser can prove: the macro may make a call of it, or a pattern, or text. It is a call when
// the symbol rust-analyzer gives at it is a function or a method (a SCIP method descriptor), and it
// is then answered as above; any other name there is dropped. A tuple struct or a variant is
// written the same way in a pattern as in a construction, so neither is answered as a call there.
// The copy of rust-analyzer is the one the find order finds (tool-copy.ts); with none, way B for
// Rust cannot run, and the built-in rules make the links.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Node, Parser } from "web-tree-sitter";
import type { BuiltWith, LanguageTool, ToolAnswer, ToolInput, ToolRelease } from "../contract.ts";
import { atLeast, versionNumbers } from "../../tool-copy.ts";
import { isNameToken } from "./keywords.ts";
import { ENCODING, isFunction, isLocal, KIND_ENUM_MEMBER, ownerOfType, packageOf, readScip, ROLE_DEFINITION, type ScipDocument } from "./scip.ts";

/** The program way B for Rust runs, as the find order names it (CODE_GRAPH.md, "Where a language's tool comes from"). */
export const RUST_ANALYZER = "rust-analyzer";

/** Cargo's files that lay a package out (The Cargo Book, "The Manifest Format", "Cargo.toml vs Cargo.lock"). */
export const MANIFESTS = ["Cargo.toml", "Cargo.lock"] as const;

/**
 * The environment rust-analyzer runs in: Cargo downloads nothing (CARGO_NET_OFFLINE, The Cargo
 * Book, "Environment variables"), and rustup installs no toolchain (RUSTUP_AUTO_INSTALL).
 */
export const TOOL_ENV = { CARGO_NET_OFFLINE: "true", RUSTUP_AUTO_INSTALL: "0" } as const;

/**
 * rust-analyzer's settings for `scip`. That command asks Cargo for the build scripts' output
 * whatever `cargo.buildScripts.enable` says, so the command it runs for that output is replaced by
 * one that prints none, rust-analyzer's own `--version`: no build script is compiled or run. No proc
 * macro is expanded.
 */
export const scipSettings = (program: string) =>
  ({
    cargo: { buildScripts: { enable: false, overrideCommand: [program, "--version"] } },
    procMacro: { enable: false },
  }) as const;

/** The same, for `diagnostics`, which takes them as flags. */
export const DIAGNOSTICS_FLAGS = ["--disable-build-scripts", "--disable-proc-macros"] as const;

/** The longest a command's output may be. */
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

const NOT_KNOWN: ToolAnswer = { state: "not_known" };
const OUTSIDE: ToolAnswer = { state: "outside" };

/** An error `rust-analyzer diagnostics` prints: its file, and its range as 0-based lines and UTF-8 columns. */
const ERROR_LINE = /^at crate .*?, file (.+?): Error .*? from LineCol \{ line: (\d+), col: (\d+) \} to LineCol \{ line: (\d+), col: (\d+) \}/;

/** An error rust-analyzer reports: its file from the repo's root, and its range in UTF-16 offsets. */
export type ReportedError = { file: string; start: number; end: number };

/** What rust-analyzer gives for the repo. */
export type RustAnalyzerOutput = {
  /** Each Cargo workspace's folder, from the repo's root ("." for the root), with its SCIP documents. */
  workspaces: { root: string; documents: ScipDocument[] }[];
  errors: ReportedError[];
  /** A workspace rust-analyzer could not index, with why. */
  failed: string[];
};

/**
 * The lowest rust-analyzer tmb supports: the first that prints each error in the form ERROR_LINE
 * reads ("Improve `rust-analyzer diagnostics`", rust-lang/rust-analyzer 27897e48, 2025-09-14).
 * rustup's copy names the Rust toolchain it came with, the first being Rust 1.92.0; a release of
 * rust-analyzer's own names the day of the commit it was built from.
 */
export const LOWEST_TOOLCHAIN = "1.92.0";
export const LOWEST_COMMIT_DAY = "2025-09-14";

/** `rust-analyzer --version`: `rust-analyzer <version> (<commit> <day>)`. */
const VERSION_LINE = /^rust-analyzer (\d+(?:\.\d+)*)\S* \(\S+ (\d{4}-\d{2}-\d{2})\)/;

/**
 * Whether a report is at or above the lowest rust-analyzer tmb supports: a toolchain's version
 * from 1 on is rustup's copy, compared with LOWEST_TOOLCHAIN; one below 1 is a release of
 * rust-analyzer's own, compared by its commit's day.
 */
export function supportedRustAnalyzer(report: string): boolean {
  const match = VERSION_LINE.exec(report.trim());
  if (match === null) return false;
  const version = versionNumbers(match[1]!);
  return (version[0] ?? 0) >= 1 ? atLeast(version, versionNumbers(LOWEST_TOOLCHAIN)) : match[2]! >= LOWEST_COMMIT_DAY;
}

/**
 * The rust-analyzer tmb installs when a machine has none it supports: a release of rust-analyzer's
 * own, from its release page, built on or after LOWEST_COMMIT_DAY. Each asset is the program,
 * gzipped, except on Windows, where it is a zip holding `rust-analyzer.exe`. The project publishes
 * no checksum file; each sha256 is of the asset as its release page serves it.
 */
export const RUST_ANALYZER_RELEASE = "2026-11-09";
const RELEASE_PAGE = "https://github.com/rust-lang/rust-analyzer/releases";
const asset = (target: string, ending: "gz" | "zip"): string => `${RELEASE_PAGE}/download/${RUST_ANALYZER_RELEASE}/rust-analyzer-${target}.${ending}`;
const GZIP = { format: "gzip" } as const;
const WINDOWS_ZIP = { format: "zip", from: "", to: "bin/" } as const;
export const RUST_ANALYZER_PIN: ToolRelease = {
  version: RUST_ANALYZER_RELEASE,
  page: RELEASE_PAGE,
  assets: {
    "darwin-arm64": { url: asset("aarch64-apple-darwin", "gz"), sha256: "e43a65008f8f4291320f33c0545dd577ad7623a7407b584a27155833d3722dfb", archive: GZIP },
    "darwin-x64": { url: asset("x86_64-apple-darwin", "gz"), sha256: "abf410a54e33e9f8b2d37f76dde8884db86a030d6a9cc70c0e3f87a77c084c5c", archive: GZIP },
    "linux-x64": { url: asset("x86_64-unknown-linux-gnu", "gz"), sha256: "8c039b25cb338b3970c731646677a4c9d4e9dd7a92c9ab9ae459c71467fbf4a9", archive: GZIP },
    "linux-arm64": { url: asset("aarch64-unknown-linux-gnu", "gz"), sha256: "813ca3cec78ac6dab99c7bc9d51e63578f6d401b994ecf29cc0dcad86f9b2cd4", archive: GZIP },
    "win32-x64": { url: asset("x86_64-pc-windows-msvc", "zip"), sha256: "973ab11e84955a7f8e3cf01ccd98a33f3ecbd6d4a14bf59bb164aa9e831c6fef", archive: WINDOWS_ZIP },
    "win32-arm64": { url: asset("aarch64-pc-windows-msvc", "zip"), sha256: "ca0770b76d3881642221d0437f7535e324f22a9499bcd00bbebeb0228617249e", archive: WINDOWS_ZIP },
  },
};

/** Cargo's home, where it keeps the crates it fetched: `$CARGO_HOME`, else `~/.cargo` (The Cargo Book, "Cargo Home"). */
function cargoHome(): string {
  const set = process.env.CARGO_HOME?.trim();
  return set ? path.resolve(set) : path.join(homedir(), ".cargo");
}

/** Where Cargo unpacks a registry's crates, one folder per registry: `<CARGO_HOME>/registry/src/<registry>/<name>-<version>`. */
const REGISTRY_SOURCES = ["registry", "src"] as const;

/**
 * The crates the repo's Cargo.lock files resolve from a registry, as Cargo names their unpacked
 * folders: `<name>-<version>`. A package of the repo itself, or one from a path, has no `source`;
 * one from git is not in the registry (The Cargo Book, "Cargo.toml vs Cargo.lock").
 */
export function registryCrates(locks: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const text of locks) {
    for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
      const field = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(block)?.[1];
      const name = field("name");
      const version = field("version");
      const source = field("source");
      if (name === undefined || version === undefined || source === undefined) continue;
      if (source.startsWith("registry+") || source.startsWith("sparse+")) out.add(`${name}-${version}`);
    }
  }
  return [...out].sort();
}

/** The text of each Cargo.lock in a folder that holds Rust code or is above one. */
function locksOf(input: Pick<ToolInput, "files" | "configs" | "read">): string[] {
  const out: string[] = [];
  for (const dir of foldersOf(input.files.keys())) {
    const rel = inFolder(dir, "Cargo.lock");
    const text = input.configs.get(rel) ?? input.read(rel);
    if (text !== undefined) out.push(text);
  }
  return out;
}

/** The repo's path of a folder's file, "." being the root. */
const inFolder = (dir: string, name: string): string => (dir === "." ? name : `${dir}/${name}`);

/** Each folder that holds a `.rs` file, and each folder above it, up to the repo's root ("."). */
function foldersOf(files: Iterable<string>): Set<string> {
  const out = new Set<string>(["."]);
  for (const file of files) for (let d = path.posix.dirname(file); d !== "." && !out.has(d); d = path.posix.dirname(d)) out.add(d);
  return out;
}

/**
 * The folders rust-analyzer is run in: each that holds a Cargo.toml with none in a folder above it.
 * Cargo finds a package's workspace by looking up from it (The Cargo Book, "Workspaces"), so a
 * workspace's members are below its root.
 */
function workspaceRoots(manifests: ReadonlySet<string>): string[] {
  const roots: string[] = [];
  for (const dir of [...manifests].sort()) {
    let above = false;
    for (let d = dir; d !== "." && !above; ) {
      d = path.posix.dirname(d);
      above = manifests.has(d);
    }
    if (!above) roots.push(dir);
  }
  return roots;
}

/** Offsets of each line's start, in UTF-16 code units. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/** The UTF-16 offset of a line's character, counted in the given encoding. */
function offsetOf(text: string, starts: readonly number[], line: number, column: number, encoding: number): number {
  const start = starts[line] ?? text.length;
  if (encoding === ENCODING.utf16) return start + column;
  let i = start;
  for (let bytes = 0; bytes < column && i < text.length; ) {
    const code = text.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code < 0x10000 ? 1 : 2;
  }
  return i;
}

/** A line and its character, in the given encoding, of a UTF-16 offset. */
function placeOf(text: string, starts: readonly number[], pos: number, encoding: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  const start = starts[lo]!;
  if (encoding === ENCODING.utf16) return { line: lo, column: pos - start };
  return { line: lo, column: Buffer.byteLength(text.slice(start, pos), "utf8") };
}

/** Writes the repo's `.rs` files and Cargo's manifests to `repo`; returns the folders that hold a Cargo.toml. */
function writeRepo(input: Pick<ToolInput, "files" | "configs" | "read">, repo: string): Set<string> {
  const write = (rel: string, text: string) => {
    const file = path.join(repo, ...rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  for (const [rel, text] of input.files) if (rel.endsWith(".rs")) write(rel, text);
  const manifests = new Set<string>();
  for (const dir of foldersOf(input.files.keys())) {
    for (const name of MANIFESTS) {
      const rel = inFolder(dir, name);
      const text = input.configs.get(rel) ?? input.read(rel);
      if (text === undefined) continue;
      write(rel, text);
      if (name === "Cargo.toml") manifests.add(dir);
    }
  }
  return manifests;
}

/** The errors `rust-analyzer diagnostics` prints for the workspace at `dir`, in the files of the repo at `repo`. */
function readErrors(stdout: string, repo: string, files: ReadonlyMap<string, string>): ReportedError[] {
  const out: ReportedError[] = [];
  for (const line of stdout.split("\n")) {
    const m = ERROR_LINE.exec(line);
    if (m === null) continue;
    const rel = path.relative(repo, m[1]!).split(path.sep).join("/");
    const text = files.get(rel);
    if (text === undefined) continue;
    const starts = lineStarts(text);
    out.push({ file: rel, start: offsetOf(text, starts, Number(m[2]), Number(m[3]), ENCODING.utf8), end: offsetOf(text, starts, Number(m[4]), Number(m[5]), ENCODING.utf8) });
  }
  return out;
}

/**
 * Runs rust-analyzer on the repo's files at the commit, written to a scratch folder with Cargo's
 * manifests: `scip` and `diagnostics` in each workspace's folder.
 */
export function runRustAnalyzer(input: Pick<ToolInput, "files" | "configs" | "read">, program: string = RUST_ANALYZER): RustAnalyzerOutput {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "tmb-rust-analyzer-")));
  try {
    const repo = path.join(scratch, "repo");
    mkdirSync(repo);
    const roots = workspaceRoots(writeRepo(input, repo));
    const settings = path.join(scratch, "settings.json");
    writeFileSync(settings, JSON.stringify(scipSettings(program)));
    // Cargo's own output folder is in scratch too, though nothing is built.
    const env = { ...process.env, ...TOOL_ENV, CARGO_TARGET_DIR: path.join(scratch, "target") };
    const out: RustAnalyzerOutput = { workspaces: [], errors: [], failed: [] };
    roots.forEach((root, i) => {
      const cwd = root === "." ? repo : path.join(repo, ...root.split("/"));
      const index = path.join(scratch, `index-${i}.scip`);
      const scip = spawnSync(program, ["scip", ".", "--output", index, "--config-path", settings], { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, env });
      if (scip.error !== undefined || scip.status !== 0) {
        out.failed.push(`${root}: \`rust-analyzer scip\` failed (${scip.error?.message ?? scip.stderr.trim().split("\n").at(-1) ?? ""})`);
        return;
      }
      out.workspaces.push({ root, documents: readScip(new Uint8Array(readFileSync(index))) });
      // It exits with an error when it reports one; its report ends with this line.
      const diagnostics = spawnSync(program, ["diagnostics", ".", ...DIAGNOSTICS_FLAGS], { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, env });
      if (diagnostics.error !== undefined || !diagnostics.stdout.includes("diagnostic scan complete")) {
        // Without its errors, no answer in this workspace stands.
        out.workspaces.pop();
        out.failed.push(`${root}: \`rust-analyzer diagnostics\` failed (${diagnostics.error?.message ?? diagnostics.stderr.trim().split("\n")[0] ?? ""})`);
        return;
      }
      out.errors.push(...readErrors(diagnostics.stdout, repo, input.files));
    });
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The name an identifier is: a raw identifier, `r#fn`, is the name `fn` (The Rust Reference, "Identifiers"). */
export const identifierName = (identifier: string): string => identifier.replace(/^r#/, "");

/** Where a symbol is defined in the repo: its file, the line of its name (1-based), and its name. */
export type Definition = { file: string; line: number; name: string };

/** rust-analyzer's answer for the name at a place: the definition in the repo it names, outside the repo, or why there is none. */
export type Answer = { repo: Definition } | { outside: string } | { notKnown: string };

/**
 * The call expression around the name at `pos`: the whole call, receiver and arguments included;
 * in a macro's input, the name and the group in parentheses after it; else the name.
 */
function callExtent(root: Node, pos: number, length: number): { start: number; end: number } {
  const name = root.descendantForIndex(pos, pos + length);
  for (let n: Node | null = name; n !== null; n = n.parent) {
    const callee = n.type === "call_expression" ? n.childForFieldName("function") : null;
    if (callee !== null && callee.startIndex <= pos && callee.endIndex >= pos + length) return { start: n.startIndex, end: n.endIndex };
  }
  const args = name !== null && isNameToken(name) && name.parent?.type === "token_tree" ? name.nextSibling : null;
  if (args?.type === "token_tree" && args.firstChild?.type === "(") return { start: pos, end: args.endIndex };
  return { start: pos, end: pos + length };
}

/**
 * rust-analyzer's answers, read from its output for the repo's files. `parser` reads the files it
 * reports errors in, for the extent of a call there. Call `close` when done.
 */
export function readAnswers(
  files: ReadonlyMap<string, string>,
  out: RustAnalyzerOutput,
  parser: Parser,
): { at(file: string, pos: number, length: number): Answer; asCall(file: string, pos: number, length: number): Answer | null; close(): void } {
  // Every document, by its path from the repo's root.
  const documents = new Map<string, ScipDocument>();
  for (const { root, documents: docs } of out.workspaces) for (const doc of docs) documents.set(root === "." ? doc.path : `${root}/${doc.path}`, doc);
  const starts = new Map<string, number[]>();
  const startsOf = (file: string, text: string) => {
    let s = starts.get(file);
    if (s === undefined) starts.set(file, (s = lineStarts(text)));
    return s;
  };
  // Where each symbol is defined, the repo's own packages, and the symbols defined at two places,
  // which name no one definition. A symbol's kind, as rust-analyzer gives it.
  const defined = new Map<string, Definition>();
  const twice = new Set<string>();
  const ownPackages = new Set<string>();
  const kinds = new Map<string, number>();
  for (const [file, doc] of documents) {
    for (const [symbol, kind] of doc.kinds) kinds.set(symbol, kind);
    const text = files.get(file);
    if (text === undefined) continue;
    for (const o of doc.occurrences) {
      if ((o.roles & ROLE_DEFINITION) === 0 || isLocal(o.symbol)) continue;
      ownPackages.add(packageOf(o.symbol));
      const s = startsOf(file, text);
      const start = offsetOf(text, s, o.line, o.start, doc.encoding);
      const end = offsetOf(text, s, o.endLine, o.end, doc.encoding);
      const name = identifierName(text.slice(start, end));
      const prior = defined.get(o.symbol);
      if (prior === undefined) defined.set(o.symbol, { file, line: o.line + 1, name });
      else if (prior.file !== file || prior.line !== o.line + 1) twice.add(o.symbol);
    }
  }
  // The symbols each document gives at each place, `line:character`, but definitions.
  const at = new Map<ScipDocument, Map<string, Set<string>>>();
  const symbolsAt = (doc: ScipDocument, line: number, column: number): Set<string> | undefined => {
    let byPlace = at.get(doc);
    if (byPlace === undefined) {
      byPlace = new Map();
      for (const o of doc.occurrences) {
        if ((o.roles & ROLE_DEFINITION) !== 0) continue;
        const key = `${o.line}:${o.start}`;
        byPlace.set(key, (byPlace.get(key) ?? new Set()).add(o.symbol));
      }
      at.set(doc, byPlace);
    }
    return byPlace.get(`${line}:${column}`);
  };
  // The errors, by file, and each such file's tree.
  const errors = new Map<string, ReportedError[]>();
  for (const e of out.errors) errors.set(e.file, [...(errors.get(e.file) ?? []), e]);
  const trees = new Map<string, Node>();
  const inError = (file: string, text: string, pos: number, length: number): boolean => {
    const here = errors.get(file);
    if (here === undefined) return false;
    let root = trees.get(file);
    if (root === undefined) {
      const tree = parser.parse(text);
      if (tree === null) return true;
      trees.set(file, (root = tree.rootNode));
    }
    const extent = callExtent(root, pos, length);
    return here.some((e) => e.start < extent.end && e.end > extent.start);
  };
  // The symbols rust-analyzer gives at the name at `pos`, or why it gives none.
  const symbolsOf = (file: string, pos: number): Set<string> | Answer => {
    const doc = documents.get(file);
    const text = files.get(file);
    if (doc === undefined || text === undefined) return { notKnown: "a file rust-analyzer does not load" };
    const place = placeOf(text, startsOf(file, text), pos, doc.encoding);
    return symbolsAt(doc, place.line, place.column) ?? { notKnown: "no symbol" };
  };
  const answers = {
    at(file: string, pos: number, length: number): Answer {
      const text = files.get(file);
      const symbols = symbolsOf(file, pos);
      if (!(symbols instanceof Set) || text === undefined) return symbols instanceof Set ? { notKnown: "a file rust-analyzer does not load" } : symbols;
      if (symbols.size !== 1) return { notKnown: "more than one symbol" };
      let symbol = [...symbols][0]!;
      if (isLocal(symbol)) return { notKnown: "a local" };
      if (inError(file, text, pos, length)) return { notKnown: "an error in the call" };
      // A variant is its enum's: a construction links to the type (CODE_GRAPH.md, "Two ways to make links").
      if (kinds.get(symbol) === KIND_ENUM_MEMBER) {
        const owner = ownerOfType(symbol);
        if (owner === null) return { notKnown: "a variant of no type" };
        symbol = owner;
      }
      if (twice.has(symbol)) return { notKnown: "a symbol defined at two places" };
      const definition = defined.get(symbol);
      if (definition !== undefined) return { repo: definition };
      return ownPackages.has(packageOf(symbol)) ? { notKnown: "a symbol of the repo with no definition in it" } : { outside: packageOf(symbol) };
    },
    // A name written as a call in a macro's input: answered as a call when the one symbol at it is
    // a function or a method; null, so dropped, otherwise.
    asCall(file: string, pos: number, length: number): Answer | null {
      const symbols = symbolsOf(file, pos);
      if (!(symbols instanceof Set) || symbols.size !== 1 || !isFunction([...symbols][0]!)) return null;
      return answers.at(file, pos, length);
    },
    close() {
      for (const root of trees.values()) root.tree.delete();
      trees.clear();
    },
  };
  return answers;
}

/** The answers for the graph's calls, one per call, in order. */
export function answerCalls(input: ToolInput, out: RustAnalyzerOutput, parser: Parser): ToolAnswer[] {
  const nodesByFile = new Map<string, { index: number; name: string; start: number; end: number }[]>();
  input.nodes.forEach((node, index) => nodesByFile.set(node.path, [...(nodesByFile.get(node.path) ?? []), { index, ...node }]));
  // The node a definition is, by place: in its file, of its name, its lines holding the
  // definition's; when two hold it, the one that starts on its line.
  const nodeOf = (d: Definition): ToolAnswer => {
    const holding = (nodesByFile.get(d.file) ?? []).filter((n) => identifierName(n.name) === d.name && n.start <= d.line && n.end >= d.line);
    const chosen = holding.length > 1 ? holding.filter((n) => n.start === d.line) : holding;
    return chosen.length === 1 ? { nodes: [chosen[0]!.index] } : NOT_KNOWN;
  };
  const answers = readAnswers(input.files, out, parser);
  try {
    return input.calls.map((call): ToolAnswer => {
      const a = call.inMacro ? answers.asCall(call.path, call.pos, call.name.length) : answers.at(call.path, call.pos, call.name.length);
      if (a === null) return { call: false };
      return "repo" in a ? nodeOf(a.repo) : "outside" in a ? OUTSIDE : NOT_KNOWN;
    });
  } finally {
    answers.close();
  }
}

/** rust-analyzer, way B's tool for Rust. */
export const rustAnalyzer: LanguageTool = {
  name: "rust-analyzer",
  // The user's copy comes from rustup, which puts it in Cargo's bin folder (The rustup book,
  // "Installation"), or is on PATH; else tmb's.
  copy: {
    program: RUST_ANALYZER,
    what: "rust-analyzer",
    versionArgs: ["--version"],
    env: TOOL_ENV,
    report: ({ stdout }) => stdout.trim(),
    lowest: `rust-analyzer of Rust ${LOWEST_TOOLCHAIN}, or a release of rust-analyzer's own from ${LOWEST_COMMIT_DAY}`,
    supported: supportedRustAnalyzer,
    userPlaces: () => [path.join(cargoHome(), "bin")],
    tmbInstalls: true,
    release: RUST_ANALYZER_PIN,
  },
  reads: (file) => (MANIFESTS as readonly string[]).includes(path.posix.basename(file)),
  async open(_repoDir, found) {
    const program = found.path ?? RUST_ANALYZER;
    // The parser that finds a call's extent; loaded here, as the graph's loader names this module.
    const { loadParsers } = await import("../../loader.ts");
    const parser = (await loadParsers(["rust"])).get("rust");
    if (parser === undefined) return { unavailable: "the Rust grammar did not load" };
    return {
      answer(input, note, readFrom) {
        readFrom(registryCrates(locksOf(input)));
        const out = runRustAnalyzer(input, program);
        for (const failed of out.failed) note(failed);
        if (out.workspaces.length === 0 && out.failed.length === 0) note("no Cargo.toml: rust-analyzer loads no file");
        return answerCalls(input, out, parser);
      },
    };
  },
  // The installed packages are Cargo's registry on disk: of each crate Cargo.lock resolves from a
  // registry, whether Cargo has unpacked it, in any registry's folder.
  builtWith(_repoDir: string, places: readonly string[]): BuiltWith {
    const sources = path.join(cargoHome(), ...REGISTRY_SOURCES);
    let registries: string[] = [];
    try {
      registries = readdirSync(sources).sort();
    } catch {
      // No registry on disk: no crate is held.
    }
    const held = places.map((place) => `${place}: ${registries.some((r) => existsSync(path.join(sources, r, place))) ? "held" : "not held"}`);
    return { packages: [`registry: ${sources}`, ...held].join("\n") };
  },
};
