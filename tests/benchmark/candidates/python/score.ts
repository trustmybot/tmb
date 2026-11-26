// Step 3 of the Python A/B test (trustmybot/tmb#338): each candidate's answers turned into call
// states on the dump's nodes, by the page's rule ("Two ways to make links" in CODE_GRAPH.md), and
// the candidates compared with each other and with way A.
//
// The rule, as the TypeScript compiler's way B applies it (src/engine/graph/languages/typescript/tool.ts):
// - a declaration is in the repo when its file is a file of the repo; else it is outside;
// - a call is outside when it has declarations and every one is outside;
// - it is linked when its declarations in the repo match exactly one node: same file, same name,
//   lines overlapping; when two nodes fit, the one that starts on the declaration's line wins;
// - else it is not known: no answer, an error, a declaration that is no node (a parameter, a
//   local), or more than one node.
// A declaration matches a node only when it is the node's own declaration: the line declares the
// name with `def` or `class`, or the node is file-level data, whose declaration is its assignment.
// This stands for the TypeScript tool's check that a declaration is a node by "Kinds of symbol";
// without it a local named as the function around it would match that function.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Asked, Decl } from "./ask.ts";
import type { Dump, DumpNode } from "./dump.ts";

export type State = "linked" | "outside" | "not_known";
/** One call's answer: its state, and the node id it links. */
export type Resolved = { state: State; node: number | null; why: string };

/** Why a call is not known, for the reader. */
export const WHY = {
  noAnswer: "no declaration",
  error: "the tool failed on the call",
  noName: "the callee is no name",
  noNode: "a declaration in the repo that is no node",
  manyNodes: "declarations matching more than one node",
  linked: "linked",
  outside: "outside",
} as const;

const DECLARES = (name: string) => new RegExp(`^\\s*(?:async\\s+def|def|class)\\s+${name.replace(/[^\p{L}\p{N}_]/gu, "")}\\b`, "u");

export class Matcher {
  private nodesByFile = new Map<string, DumpNode[]>();
  private files: Set<string>;
  private root: string;
  private lines = new Map<string, string[]>();

  constructor(
    d: Dump,
    repoCopy: string,
    readonly strict = true,
  ) {
    this.root = realpathSync(repoCopy);
    this.files = new Set(d.files);
    for (const n of d.nodes) this.nodesByFile.set(n.path, [...(this.nodesByFile.get(n.path) ?? []), n]);
  }

  /** The repo file a declaration is in, or null when it is outside the repo. */
  repoFile(decl: Decl): string | null {
    if (!("file" in decl) || decl.file.startsWith("<")) return null;
    const abs = existsSync(decl.file) ? realpathSync(decl.file) : path.resolve(decl.file);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  private lineOf(rel: string, line0: number): string {
    if (!this.lines.has(rel)) this.lines.set(rel, readFileSync(path.join(this.root, rel), "utf8").split("\n"));
    return this.lines.get(rel)![line0] ?? "";
  }

  /** The nodes a declaration in the repo matches. */
  nodesOf(rel: string, decl: Decl): DumpNode[] {
    if (!("file" in decl) || decl.name === null || !this.files.has(rel)) return [];
    const line = decl.line0 + 1;
    const name = decl.name;
    let fit = (this.nodesByFile.get(rel) ?? []).filter((n) => n.name === name && n.start <= line && n.end >= line);
    if (this.strict) {
      const text = this.lineOf(rel, decl.line0);
      fit = fit.filter((n) => (n.kind === "const" ? true : DECLARES(name).test(text)));
    }
    if (fit.length <= 1) return fit;
    const starting = fit.filter((n) => n.start === line);
    return starting.length === 1 ? starting : fit;
  }

  resolve(answer: Asked["answers"][number]): Resolved {
    if ("error" in answer) return { state: "not_known", node: null, why: WHY.error };
    if (answer.decls.length === 0) return { state: "not_known", node: null, why: WHY.noAnswer };
    const own = answer.decls.map((d) => ({ d, rel: this.repoFile(d) })).filter((x) => x.rel !== null);
    if (own.length === 0) return { state: "outside", node: null, why: WHY.outside };
    const nodes = new Set(own.flatMap(({ d, rel }) => this.nodesOf(rel!, d).map((n) => n.id)));
    if (nodes.size === 1) return { state: "linked", node: [...nodes][0]!, why: WHY.linked };
    return { state: "not_known", node: null, why: nodes.size === 0 ? WHY.noNode : WHY.manyNodes };
  }
}

/** A callee that is one name, as `f` or `x.f`; not `f()()`, `a[i]()` or `getattr(x, n)()`. */
const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/**
 * The calls' states for one candidate's answers. A call whose callee is no name is not known, as
 * the TypeScript tool answers only a callee that is an identifier (calleeOf in compiler.ts): the
 * call's position is then the start of an expression, and a tool asked there answers for another
 * name than the one called (`current_app` in `current_app.ensure_sync(f)(x)`).
 */
export function resolveAll(d: Dump, asked: Asked, repoCopy: string, strict = true): Resolved[] {
  const m = new Matcher(d, repoCopy, strict);
  return asked.answers.map((a, i) => (NAME.test(d.calls[i]!.name) ? m.resolve(a) : { state: "not_known", node: null, why: WHY.noName }));
}

/** Way A's states, in the same form. */
export const wayA = (d: Dump): Resolved[] => d.calls.map((c) => ({ state: c.wayA, node: c.wayADst, why: c.wayA }));

export type Counts = { linked: number; outside: number; not_known: number; why: Record<string, number> };

export function counts(rs: readonly Resolved[]): Counts {
  const c: Counts = { linked: 0, outside: 0, not_known: 0, why: {} };
  for (const r of rs) {
    c[r.state]++;
    if (r.state === "not_known") c.why[r.why] = (c.why[r.why] ?? 0) + 1;
  }
  return c;
}

/** How two ways' answers compare, call by call. */
export function agreement(a: readonly Resolved[], b: readonly Resolved[]): { bothSame: number; bothDiffer: number; onlyA: number; onlyB: number; aLinkedBOutside: number; aOutsideBLinked: number } {
  const out = { bothSame: 0, bothDiffer: 0, onlyA: 0, onlyB: 0, aLinkedBOutside: 0, aOutsideBLinked: 0 };
  a.forEach((x, i) => {
    const y = b[i]!;
    if (x.state === "linked" && y.state === "linked") {
      if (x.node === y.node) out.bothSame++;
      else out.bothDiffer++;
    } else if (x.state === "linked") {
      out.onlyA++;
      if (y.state === "outside") out.aLinkedBOutside++;
    } else if (y.state === "linked") {
      out.onlyB++;
      if (x.state === "outside") out.aOutsideBLinked++;
    }
  });
  return out;
}
