// Step 2 of the Python A/B test (trustmybot/tmb#338): one candidate's answer for every call of a
// dump, in one Python environment. The candidate reads a working copy of the repo at the dump's
// commit; it is asked only where the name each call calls is declared.
//
//   bun tests/benchmark/candidates/python/ask.ts <scratch> <dump.json> <candidate> <env> <repoCopy> <out.json>
//
// <scratch> holds tools/ (a venv with the Python-side tools), npm/ (the npm-side ones) and
// envs/<env> (the Python environment the repo is read with). The answer is written as the tool
// gave it, with each declaration's name read from its file: matching it to a node is score.ts's.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Question, askDefinitions } from "./lsp.ts";
import type { Dump } from "./dump.ts";
import { DEFINITION, isLocal, packageOf, readScip, type ScipDocument } from "./scip.ts";
import { LSP_CANDIDATES, type LspCandidate, serverSpec } from "./servers.ts";

/** A declaration as a candidate names it: a file and a 0-based line, and its name when known; or a compiled built-in with no file. */
export type Decl = { file: string; line0: number; name: string | null } | { builtin: true; name: string | null };
export type RawAnswer = { decls: Decl[] } | { error: string };
export type Asked = { candidate: string; version: string; env: string; repo: string; startMs: number; answerMs: number; totalMs: number; note: string; answers: RawAnswer[] };

export const CANDIDATES = [...LSP_CANDIDATES, "jedi", "rope", "mypy", "scip-python"] as const;

const IDENT = /[\p{L}\p{N}_]+/u;

/** The text of a file, cached. */
const textCache = new Map<string, string[] | null>();
function linesOf(file: string): string[] | null {
  if (!textCache.has(file)) textCache.set(file, existsSync(file) ? readFileSync(file, "utf8").split("\n") : null);
  return textCache.get(file)!;
}

/** The identifier written at a 0-based line and UTF-16 character. */
function nameAt(file: string, line0: number, character: number): string | null {
  const line = linesOf(file)?.[line0];
  if (line === undefined) return null;
  const m = IDENT.exec(line.slice(character));
  return m !== null && m.index === 0 ? m[0] : null;
}

/** The name a line declares, for a tool that gives a line alone: a `def`, a `class` or an assignment's target. */
function nameDeclaredOn(file: string, line0: number): string | null {
  const line = linesOf(file)?.[line0];
  if (line === undefined) return null;
  const m = /^\s*(?:async\s+def|def|class)\s+([\p{L}\p{N}_]+)/u.exec(line) ?? /^\s*([\p{L}\p{N}_]+)\s*(?::[^=]*)?=/u.exec(line);
  return m?.[1] ?? null;
}

const questionsOf = (d: Dump): Question[] => d.calls.map((c) => ({ file: c.path, line: c.line0, character: c.character }));

/** Runs a Python runner of this folder with the tools venv's Python, isolated. */
function runPython(scratch: string, script: string, input: unknown): { out: unknown; ms: number } {
  const t = performance.now();
  const run = spawnSync(path.join(scratch, "tools", "bin", "python"), ["-I", path.join(import.meta.dir, script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`${script} failed: ${run.stderr.slice(-3000)}`);
  return { out: JSON.parse(run.stdout), ms: Math.round(performance.now() - t) };
}

async function askLsp(name: LspCandidate, scratch: string, envDir: string, repo: string, d: Dump): Promise<Omit<Asked, "candidate" | "env" | "repo">> {
  const t = performance.now();
  const spec = serverSpec(name, { tools: path.join(scratch, "tools"), npm: path.join(scratch, "npm"), env: envDir });
  const { answers, timing, server, stderr } = await askDefinitions(spec, repo, questionsOf(d));
  const out: RawAnswer[] = answers.map((a) =>
    "error" in a ? a : { decls: a.decls.map((x) => ({ file: x.file, line0: x.line, name: nameAt(x.file, x.line, x.character) })) },
  );
  const npmPackage = path.join(scratch, "npm", "node_modules", name, "package.json");
  const version =
    server !== null && typeof server === "object" && "version" in server
      ? String((server as { version: unknown }).version)
      : existsSync(npmPackage)
        ? String((JSON.parse(readFileSync(npmPackage, "utf8")) as { version: unknown }).version)
        : "";
  return { version, startMs: timing.startMs, answerMs: timing.answerMs, totalMs: Math.round(performance.now() - t), note: stderr.slice(0, 300), answers: out };
}

function askJedi(scratch: string, envDir: string, repo: string, d: Dump): Omit<Asked, "candidate" | "env" | "repo"> {
  const { out, ms } = runPython(scratch, "jedi_ask.py", { root: repo, env: path.join(envDir, "bin", "python"), questions: d.calls.map((c) => [c.path, c.line0, c.character]) });
  const o = out as { version: string; answers: ({ decls: ({ file: string; line0: number; name: string } | { builtin: boolean; name: string })[] } | { error: string })[] };
  const answers: RawAnswer[] = o.answers.map((a) =>
    "error" in a
      ? a
      : {
          decls: a.decls.flatMap((x): Decl[] => ("file" in x ? [{ file: x.file, line0: x.line0, name: x.name }] : x.builtin ? [{ builtin: true, name: x.name }] : [])),
        },
  );
  return { version: o.version, startMs: 0, answerMs: ms, totalMs: ms, note: "", answers };
}

/** The site-packages folders of a venv. */
function sitePackages(envDir: string): string[] {
  const lib = path.join(envDir, "lib");
  return readdirSync(lib).map((v) => path.join(lib, v, "site-packages")).filter(existsSync);
}

function askRope(scratch: string, envDir: string, repo: string, d: Dump): Omit<Asked, "candidate" | "env" | "repo"> {
  const { out, ms } = runPython(scratch, "rope_ask.py", { root: repo, env_site: sitePackages(envDir), questions: d.calls.map((c) => [c.path, c.line0, c.character]) });
  const o = out as { version: string; answers: ({ decls: { file: string; line0: number; name: string | null }[] } | { error: string })[] };
  const answers: RawAnswer[] = o.answers.map((a) => ("error" in a ? a : { decls: a.decls.map((x) => ({ file: x.file, line0: x.line0, name: x.name === "=" ? nameDeclaredOn(x.file, x.line0) : x.name })) }));
  return { version: o.version, startMs: 0, answerMs: ms, totalMs: ms, note: "", answers };
}

/** mypy's flags: the bodies of functions with no annotations checked too, and each folder a package base, with `src` a module root when there is one, as most tools take it. */
const MYPY_FLAGS = ["--check-untyped-defs", "--explicit-package-bases"];

function askMypy(scratch: string, envDir: string, repo: string, d: Dump): Omit<Asked, "candidate" | "env" | "repo"> {
  const input = {
    root: repo,
    env: path.join(envDir, "bin", "python"),
    status: path.join(scratch, `dmypy-${path.basename(repo)}.json`),
    files: d.files,
    flags: MYPY_FLAGS,
    questions: d.calls.map((c) => [c.path, c.line0, c.character]),
  };
  const src = path.join(repo, "src");
  const prev = process.env.MYPYPATH;
  if (existsSync(src)) process.env.MYPYPATH = src;
  try {
    const { out, ms } = runPython(scratch, "mypy_ask.py", input);
    const o = out as { version: string; check: { ms: number; out: string }; answers: ({ decls: { file: string; line0: number; name: string }[] } | { error: string })[] };
    const answers: RawAnswer[] = o.answers.map((a) => ("error" in a ? a : { decls: a.decls.map((x) => ({ file: x.file, line0: x.line0, name: x.name })) }));
    return { version: o.version, startMs: o.check.ms, answerMs: ms - o.check.ms, totalMs: ms, note: o.check.out.slice(-300), answers };
  } finally {
    if (prev === undefined) delete process.env.MYPYPATH;
    else process.env.MYPYPATH = prev;
  }
}

/** The project name scip-python is given, so the repo's own symbols are told from a package's. */
const SCIP_PROJECT = "tmb-candidate";

function askScip(scratch: string, envDir: string, repo: string, d: Dump): Omit<Asked, "candidate" | "env" | "repo"> {
  const out = path.join(scratch, "out", `${path.basename(repo)}-${path.basename(envDir)}.scip`);
  const t = performance.now();
  const run = spawnSync(
    "node",
    [path.join(scratch, "npm", "node_modules", "@sourcegraph", "scip-python", "index.js"), "index", "--quiet", "--project-name", SCIP_PROJECT, "--project-version", d.sha.slice(0, 12), "--output", out],
    { cwd: repo, encoding: "utf8", env: { ...process.env, VIRTUAL_ENV: envDir, PATH: `${path.join(envDir, "bin")}:${process.env.PATH ?? ""}`, NODE_OPTIONS: "--max-old-space-size=8192" }, maxBuffer: 1024 * 1024 * 256 },
  );
  const indexMs = Math.round(performance.now() - t);
  if (run.status !== 0) throw new Error(`scip-python failed: ${(run.stdout + run.stderr).slice(-3000)}`);
  const t2 = performance.now();
  const docs = readScip(readFileSync(out));
  const byPath = new Map<string, ScipDocument>(docs.map((doc) => [doc.path, doc]));
  // Every definition of a global symbol, and of each document's local symbols.
  const defs = new Map<string, { file: string; line0: number; character: number }[]>();
  for (const doc of docs) {
    for (const o of doc.occurrences) {
      if ((o.roles & DEFINITION) === 0) continue;
      const key = isLocal(o.symbol) ? `${doc.path}\u0000${o.symbol}` : o.symbol;
      defs.set(key, [...(defs.get(key) ?? []), { file: path.join(repo, doc.path), line0: o.line, character: o.character }]);
    }
  }
  const answers: RawAnswer[] = d.calls.map((c) => {
    const doc = byPath.get(c.path);
    if (doc === undefined) return { error: "file not in the index" };
    const at = doc.occurrences.filter((o) => o.line === c.line0 && o.character === c.character && (o.roles & DEFINITION) === 0);
    if (at.length === 0) return { decls: [] };
    const decls: Decl[] = [];
    for (const o of at) {
      const key = isLocal(o.symbol) ? `${doc.path}\u0000${o.symbol}` : o.symbol;
      const found = defs.get(key);
      if (found !== undefined) for (const f of found) decls.push({ file: f.file, line0: f.line0, name: nameAt(f.file, f.line0, f.character) });
      else {
        // No definition in the index: the symbol's package says where it is declared.
        const pkg = packageOf(o.symbol);
        if (pkg !== null && pkg.name !== SCIP_PROJECT) decls.push({ file: `<package ${pkg.name} ${pkg.version}>`, line0: -1, name: null });
      }
    }
    return { decls };
  });
  const version = JSON.parse(readFileSync(path.join(scratch, "npm", "node_modules", "@sourcegraph", "scip-python", "package.json"), "utf8")).version as string;
  return { version, startMs: indexMs, answerMs: Math.round(performance.now() - t2), totalMs: Math.round(performance.now() - t), note: "", answers };
}

export async function ask(candidate: string, scratch: string, envDir: string, repo: string, d: Dump): Promise<Omit<Asked, "candidate" | "env" | "repo">> {
  if ((LSP_CANDIDATES as readonly string[]).includes(candidate)) return askLsp(candidate as LspCandidate, scratch, envDir, repo, d);
  if (candidate === "jedi") return askJedi(scratch, envDir, repo, d);
  if (candidate === "rope") return askRope(scratch, envDir, repo, d);
  if (candidate === "mypy") return askMypy(scratch, envDir, repo, d);
  if (candidate === "scip-python") return askScip(scratch, envDir, repo, d);
  throw new Error(`unknown candidate ${candidate}`);
}

if (import.meta.main) {
  const [scratch, dumpFile, candidate, env, repo, out] = process.argv.slice(2);
  if (scratch === undefined || dumpFile === undefined || candidate === undefined || env === undefined || repo === undefined || out === undefined) {
    throw new Error("usage: ask.ts <scratch> <dump.json> <candidate> <env> <repoCopy> <out.json>");
  }
  const d = JSON.parse(readFileSync(dumpFile, "utf8")) as Dump;
  // The working copy must be the dump's commit, with no change to a file the graph read.
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  if (head !== d.sha) throw new Error(`${repo} is at ${head}, not ${d.sha}`);
  const dirty = spawnSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim();
  if (dirty !== "") throw new Error(`${repo} has changes:\n${dirty}`);
  const envDir = path.join(scratch, "envs", env);
  const asked = await ask(candidate, scratch, envDir, path.resolve(repo), d);
  const full: Asked = { candidate, env, repo: path.basename(repo), ...asked };
  writeFileSync(out, JSON.stringify(full));
  const errors = asked.answers.filter((a) => "error" in a).length;
  const empty = asked.answers.filter((a) => "decls" in a && a.decls.length === 0).length;
  console.log(`${candidate} ${asked.version} on ${path.basename(repo)} (${env}): ${asked.answers.length} answers, ${empty} empty, ${errors} errors; start ${asked.startMs} ms, answers ${asked.answerMs} ms, total ${asked.totalMs} ms`);
}
