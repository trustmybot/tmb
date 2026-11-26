// Each candidate's answer for a call, read from the tool's own output and put in one shape: the
// declarations the tool names for the call at a position, each in the repo (a file and the line
// its name is on) or outside it. Nothing here decides a link; run.ts matches declarations to nodes
// by place, as CODE_GRAPH.md's "Two ways to make links" says.
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { readScip, ROLE_DEFINITION } from "./scip.ts";

/** A declaration: in the repo, with its file and its name's line and name; or outside it. */
export type Decl = { file: string; line: number; name: string; kind: string } | { outside: string };
/** What a tool says about the call at one position. `local`: the callee is a local variable or parameter. */
export type Answer = { decls: Decl[]; local?: boolean };
/** Answers by `file:line:col`, col in UTF-8 bytes of the name's start. */
export type Answers = Map<string, Answer>;
export const at = (file: string, line: number, col: number) => `${file}:${line}:${col}`;

/** A repo file's path relative to the repo, or null when the path is outside it. */
export function inRepo(repo: string, file: string): string | null {
  const rel = isAbsolute(file) ? relative(repo, file) : file;
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

/** The identifier written at a line and byte column of a repo file. */
function nameAt(repo: string, file: string, line: number, col: number, cache: Map<string, string[]>): string {
  let lines = cache.get(file);
  if (!lines) {
    lines = readFileSync(join(repo, file), "utf8").split("\n");
    cache.set(file, lines);
  }
  const bytes = Buffer.from(lines[line - 1] ?? "");
  // A raw identifier, `r#async`, names `async`.
  const m = /^(?:r#)?([A-Za-z_][A-Za-z0-9_]*)/.exec(bytes.subarray(col).toString());
  return m?.[1] ?? "";
}

// ---- rustc, through the rustc-calls driver ----

type Place = { file: string; line: number; end: number; col: number };
type RustcDecl = { at: Place; kind: string; path: string; crate: string };
export type RustcCall = { t: "call"; how: string; name: string; at: Place; written: boolean; owner: string; local?: boolean; decl?: RustcDecl; impl?: RustcDecl };
export type RustcDef = { t: "def"; kind: string; path: string; whole: Place; ident: Place; macro: boolean; body: boolean };

export type Rustc = {
  /** The candidate's answer: the implementation that runs where the compiler picks one, else the declaration it resolved. */
  answers: Answers;
  /** The judge's answer: every declaration the compiler gives for the call, the resolved one and the implementation. */
  judge: Answers;
  /** The compiler's own list of functions and types written in the repo, by file. */
  defs: Map<string, RustcDef[]>;
  /** Calls written in the repo, by position, with the compiler's whole record. */
  calls: Map<string, RustcCall>;
  /** Positions two compilations of one file answered differently. */
  conflicts: number;
};

export function readRustc(repo: string, outDir: string): Rustc {
  const cache = new Map<string, string[]>();
  const decl = (d: RustcDecl): Decl => {
    const file = inRepo(repo, d.at.file);
    if (file === null) return { outside: d.crate };
    return { file, line: d.at.line, name: nameAt(repo, file, d.at.line, d.at.col, cache), kind: d.kind };
  };
  const answers: Answers = new Map();
  const judge: Answers = new Map();
  const calls = new Map<string, RustcCall>();
  const defs = new Map<string, RustcDef[]>();
  const seenDefs = new Set<string>();
  let conflicts = 0;
  for (const f of readdirSync(outDir).filter((x) => x.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(outDir, f), "utf8").split("\n")) {
      if (line === "") continue;
      const rec = JSON.parse(line) as RustcCall | RustcDef;
      if (rec.t === "def") {
        const file = inRepo(repo, rec.whole.file);
        if (file === null || rec.macro) continue;
        const key = `${file}:${rec.ident.line}:${rec.ident.col}:${rec.whole.end}:${rec.kind}`;
        if (seenDefs.has(key)) continue;
        seenDefs.add(key);
        defs.set(file, [...(defs.get(file) ?? []), rec]);
        continue;
      }
      const file = inRepo(repo, rec.at.file);
      if (file === null || !rec.written) continue;
      const key = at(file, rec.at.line, rec.at.col);
      const mine: Answer = { decls: rec.impl ? [decl(rec.impl)] : rec.decl ? [decl(rec.decl)] : [], local: rec.local };
      const all: Answer = { decls: [rec.decl, rec.impl].filter((d): d is RustcDecl => d !== undefined).map(decl), local: rec.local };
      const before = judge.get(key);
      if (before) {
        if (JSON.stringify(before) !== JSON.stringify(all)) conflicts++;
        continue;
      }
      answers.set(key, mine);
      judge.set(key, all);
      calls.set(key, { ...rec, at: { ...rec.at, file } });
    }
  }
  return { answers, judge, defs, calls, conflicts };
}

// ---- rust-analyzer, through its SCIP index ----

/** `rust-analyzer cargo <crate> <version> <descriptors>`: the crate a symbol belongs to. */
const scipCrate = (symbol: string) => symbol.split(" ")[2] ?? "";

export type RustAnalyzer = { answers: Answers; defs: Map<string, { line: number; endLine: number; symbol: string }[]>; documents: number; definedTwice: number };

export function readRustAnalyzer(repo: string, scipFile: string): RustAnalyzer {
  const index = readScip(new Uint8Array(readFileSync(scipFile)));
  const cache = new Map<string, string[]>();
  // Where each symbol is defined in the repo, and the crates the repo's own code is in.
  const where = new Map<string, { file: string; line: number; col: number }>();
  const ownCrates = new Set<string>();
  const defs = new Map<string, { line: number; endLine: number; symbol: string }[]>();
  // A symbol defined at two places names no one declaration (rust-analyzer gives two nested
  // functions of one name in one module the same symbol), so a reference to it proves nothing.
  const twice = new Set<string>();
  for (const doc of index.documents) {
    for (const o of doc.occurrences) {
      if ((o.roles & ROLE_DEFINITION) === 0 || o.symbol.startsWith("local ")) continue;
      ownCrates.add(scipCrate(o.symbol));
      const prior = where.get(o.symbol);
      if (prior && (prior.file !== doc.path || prior.line !== o.startLine + 1 || prior.col !== o.startChar)) twice.add(o.symbol);
      if (!prior) where.set(o.symbol, { file: doc.path, line: o.startLine + 1, col: o.startChar });
      if (o.symbol.endsWith(").") && o.enclosing) defs.set(doc.path, [...(defs.get(doc.path) ?? []), { line: o.startLine + 1, endLine: o.enclosing.endLine + 1, symbol: o.symbol }]);
    }
  }
  const answers: Answers = new Map();
  for (const doc of index.documents) {
    for (const o of doc.occurrences) {
      if ((o.roles & ROLE_DEFINITION) !== 0) continue;
      const key = at(doc.path, o.startLine + 1, o.startChar);
      const prior = answers.get(key);
      if (o.symbol.startsWith("local ")) {
        if (!prior) answers.set(key, { decls: [], local: true });
        continue;
      }
      const def = where.get(o.symbol);
      const d: Decl = twice.has(o.symbol)
        ? { file: "", line: 0, name: "", kind: "symbol defined twice" }
        : def
        ? { file: def.file, line: def.line, name: nameAt(repo, def.file, def.line, def.col, cache), kind: o.symbol.endsWith(").") ? "fn" : "other" }
        : ownCrates.has(scipCrate(o.symbol))
          ? { file: "", line: 0, name: "", kind: "no definition in the index" }
          : { outside: scipCrate(o.symbol) };
      if (!prior || prior.local) answers.set(key, { decls: [d] });
      else prior.decls.push(d);
    }
  }
  return { answers, defs, documents: index.documents.length, definedTwice: twice.size };
}
