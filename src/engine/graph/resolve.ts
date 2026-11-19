// Links a reference to its definition only on proof, carried over from the plugin's resolver:
// the same file, a resolved import, an explicit path, a declared receiver type, or the one
// definition of a table or script. A bare name that matches a symbol elsewhere is never
// proof, so such a reference stays unresolved rather than risk a wrong link.
import { basename, posix } from "node:path";
import type { EdgeKind, ExtractedEdge, SymbolKind } from "./extract.ts";
import { isTestPath } from "./test-paths.ts";

/** A symbol an edge may link to; `id` is the caller's own index for it. */
export type Candidate = { id: number; path: string; kind: SymbolKind; qualified_name: string };

/** Why a reference was linked: `exact` on a proof that names the definition, `name` on a receiver's declared type. */
export type Link = { dst: number; how: "exact" | "name" };

const CALLABLE = new Set<SymbolKind>(["function", "method", "class", "sh_function"]);
const TABLE_EDGES = new Set<EdgeKind>(["reads_table", "writes_table", "indexes", "triggers_on"]);
/** Edges that name a key, not a symbol: they are never linked. */
export const NAME_ONLY_EDGES: ReadonlySet<EdgeKind> = new Set<EdgeKind>(["reads_config", "covers"]);

/** A symbol's name as references use it: a method's own name, else its qualified name. */
export function shortName(kind: SymbolKind, qualifiedName: string): string {
  return kind === "method" ? qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1) : qualifiedName;
}

/** A relative import specifier resolved against the importing file, trying the TS forms of a `.js` specifier. */
export function resolveImport(fromFile: string, spec: string | null, fileSet: ReadonlySet<string>): string | null {
  if (!spec || !spec.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  const stem = base.replace(/\.(m?js|ts)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.js`]) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

/**
 * A Python dotted module resolved to `mod.py` or `mod/__init__.py`. Leading dots climb from
 * the importing file's package; an absolute module is tried from the repo root, then `src/`.
 */
export function resolvePythonImport(fromFile: string, spec: string | null, fileSet: ReadonlySet<string>): string | null {
  if (!spec) return null;
  const module = spec.replace(/^\.+/, "");
  const dots = spec.length - module.length;
  const parts = module.split(".").filter(Boolean);
  let roots = [".", "src"];
  if (dots > 0) {
    const pkg = posix.normalize(posix.join(posix.dirname(fromFile), ...Array<string>(dots - 1).fill("..")));
    if (pkg.startsWith("..")) return null;
    roots = [pkg];
  }
  for (const root of roots) {
    const base = posix.join(root, ...parts);
    for (const c of parts.length ? [`${base}.py`, `${base}/__init__.py`] : [`${base}/__init__.py`]) {
      const path = posix.normalize(c);
      if (fileSet.has(path)) return path;
    }
  }
  return null;
}

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export class Resolver {
  private readonly byName = new Map<string, Candidate[]>();
  private readonly modules = new Map<string, number>();
  private readonly byBase = new Map<string, Candidate[]>();
  private readonly fileSet = new Set<string>();
  private readonly importMap = new Map<string, Map<string, string>>();
  private readonly sourced = new Map<string, string[]>();

  constructor(candidates: Iterable<Candidate>, pending: Iterable<{ from: string; edge: ExtractedEdge }>) {
    for (const c of candidates) {
      if (c.kind === "module") {
        this.modules.set(c.path, c.id);
        this.fileSet.add(c.path);
        push(this.byBase, basename(c.path), c);
      } else {
        push(this.byName, shortName(c.kind, c.qualified_name), c);
      }
    }
    for (const { from, edge } of pending) {
      if (edge.kind === "imports") {
        const target = this.importTarget(from, edge);
        if (target) {
          const map = this.importMap.get(from) ?? new Map<string, string>();
          map.set(edge.dst_name, target);
          this.importMap.set(from, map);
        }
      } else if (edge.kind === "sources") {
        const target = this.scriptTarget(edge.dst_name);
        if (target !== undefined) push(this.sourced, from, target.path);
      }
    }
  }

  /** The script a `runs` or `sources` edge names: its repo path, or the one file with that basename. */
  private scriptTarget(name: string): { id: number; path: string } | undefined {
    const byPath = name.includes("/") ? this.modules.get(name) : undefined;
    if (byPath !== undefined) return { id: byPath, path: name };
    const cands = this.byBase.get(name) ?? [];
    return cands.length === 1 ? cands[0] : undefined;
  }

  /** The file an `imports` edge names; in Python, `from pkg import x` names pkg/x.py when pkg defines no x. */
  private importTarget(from: string, edge: ExtractedEdge): string | null {
    if (!from.endsWith(".py")) return resolveImport(from, edge.hint, this.fileSet);
    const module = resolvePythonImport(from, edge.hint, this.fileSet);
    if (module && (this.byName.get(edge.dst_name) ?? []).some((c) => c.path === module)) return module;
    if (!edge.hint || edge.hint === edge.dst_name) return module;
    const submodule = `${edge.hint}${edge.hint.endsWith(".") ? "" : "."}${edge.dst_name}`;
    return resolvePythonImport(from, submodule, this.fileSet) ?? module;
  }

  /** The file that defines the class named `name` as `from` sees it: its own file, or the file it imports the name from. */
  private classFile(from: string, name: string): string | null {
    const isClass = (path: string) => (this.byName.get(name) ?? []).some((c) => c.path === path && c.kind === "class");
    if (isClass(from)) return from;
    const imported = this.importMap.get(from)?.get(name);
    return imported !== undefined && isClass(imported) ? imported : null;
  }

  resolve(from: string, edge: ExtractedEdge): Link | null {
    if (NAME_ONLY_EDGES.has(edge.kind)) return null;
    if (edge.kind === "imports") {
      const target = this.importTarget(from, edge);
      if (!target) return null;
      const hit = (this.byName.get(edge.dst_name) ?? []).find((c) => c.path === target);
      return link(hit?.id ?? this.modules.get(target), "exact");
    }
    if (edge.kind === "bundles") return link(this.modules.get(edge.dst_name), "exact");
    if (edge.kind === "runs" || edge.kind === "sources") return link(this.scriptTarget(edge.dst_name)?.id, "exact");
    if (TABLE_EDGES.has(edge.kind)) {
      const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => c.kind === "sql_table");
      const real = cands.filter((c) => !isTestPath(c.path));
      const only = real.length === 1 ? real[0] : real.length === 0 && cands.length === 1 ? cands[0] : undefined;
      return link(only?.id, "exact");
    }
    const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => CALLABLE.has(c.kind));
    if (edge.hint !== null && edge.hint !== "this") {
      // A receiver's type is only a name: the call links only when that name is proven to be a
      // class of this repo, defined in this file or imported from a file of it.
      const classFile = this.classFile(from, edge.hint);
      if (classFile === null) return null;
      const qualified = `${edge.hint}.${edge.dst_name}`;
      return link(cands.find((c) => c.kind === "method" && c.path === classFile && c.qualified_name === qualified)?.id, "exact");
    }
    const same = cands.find((c) => c.path === from);
    if (same) return link(same.id, "exact");
    const viaImport = this.importMap.get(from)?.get(edge.dst_name);
    if (viaImport) return link(cands.find((c) => c.path === viaImport)?.id, "exact");
    const viaSource = (this.sourced.get(from) ?? []).map((p) => cands.find((c) => c.path === p)).find(Boolean);
    return link(viaSource?.id, "exact");
  }
}

function link(dst: number | undefined, how: Link["how"]): Link | null {
  return dst === undefined ? null : { dst, how };
}
