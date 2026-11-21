// Links a reference to its definition only on proof, carried over from the plugin's resolver:
// the same file, a resolved import, an explicit path, a declared receiver type, or the one
// definition of a table or script. A bare name that matches a symbol elsewhere is never
// proof, so such a reference stays unresolved rather than risk a wrong link.
import { basename, posix } from "node:path";
import type { EdgeKind, ExtractedEdge, ExtractedExport, SymbolKind } from "./extract.ts";
import { fileCandidates, ImportConfig } from "./import-config.ts";
import { isTestPath } from "./test-paths.ts";

/**
 * A symbol an edge may link to; `id` is the caller's own index for it. `reach` marks a function
 * nested in another, which only its own file's bare call may name, and one bound as an object's
 * key or an assignment's target, which no bare call names. `within` is a nested function's
 * parent's lines: the only lines whose bare call may name it.
 */
export type Candidate = { id: number; path: string; kind: SymbolKind; qualified_name: string; reach?: "nested" | "member"; within?: [number, number] };

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
  for (const c of fileCandidates(base)) if (fileSet.has(c)) return c;
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

/** Where a name a file exports comes from: a declaration, or a whole module (`export * as ns from`). */
type Origin = { path: string; name: string } | { namespace: string };
/** An origin, and whether a cycle was cut on the way, so the answer depends on the chain that asked. */
type Followed = { origin: Origin | null; cut: boolean };

const originKey = (o: Origin): string => ("namespace" in o ? `*\u0000${o.namespace}` : `${o.path}\u0000${o.name}`);

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
  /** The names each file declares at its top level. */
  private readonly topLevel = new Map<string, Set<string>>();
  private readonly followed = new Map<string, Origin | null>();

  /** Imports that name the repo's own code (a relative path, a `paths` alias, a package of the repo) and link no file. */
  unresolvedImports = 0;

  constructor(
    candidates: Iterable<Candidate>,
    pending: Iterable<{ from: string; edge: ExtractedEdge }>,
    private readonly config: ImportConfig = new ImportConfig(new Map()),
    private readonly exports: ReadonlyMap<string, readonly ExtractedExport[]> = new Map(),
  ) {
    for (const c of candidates) {
      if (c.kind === "module") {
        this.modules.set(c.path, c.id);
        this.fileSet.add(c.path);
        push(this.byBase, basename(c.path), c);
      } else {
        push(this.byName, shortName(c.kind, c.qualified_name), c);
        if (c.kind !== "method" && c.reach === undefined) {
          const names = this.topLevel.get(c.path) ?? new Set<string>();
          names.add(c.qualified_name);
          this.topLevel.set(c.path, names);
        }
      }
    }
    for (const { from, edge } of pending) {
      if (edge.kind === "imports") {
        const { file: target, local } = this.importTarget(from, edge);
        if (target === null && local) this.unresolvedImports++;
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

  /**
   * The file an `imports` edge names, and whether it names the repo's own code; in Python,
   * `from pkg import x` names pkg/x.py when pkg defines no x.
   */
  private importTarget(from: string, edge: ExtractedEdge): { file: string | null; local: boolean } {
    if (!from.endsWith(".py")) {
      if (!edge.hint) return { file: null, local: false };
      if (edge.hint.startsWith(".")) return { file: resolveImport(from, edge.hint, this.fileSet), local: true };
      return this.config.resolve(from, edge.hint, this.fileSet);
    }
    const local = edge.hint?.startsWith(".") === true;
    const module = resolvePythonImport(from, edge.hint, this.fileSet);
    if (module && (this.byName.get(edge.dst_name) ?? []).some((c) => c.path === module)) return { file: module, local };
    if (!edge.hint || edge.hint === edge.dst_name) return { file: module, local };
    const submodule = `${edge.hint}${edge.hint.endsWith(".") ? "" : "."}${edge.dst_name}`;
    return { file: resolvePythonImport(from, submodule, this.fileSet) ?? module, local };
  }

  /** The repo file a module specifier written in `from` names, or null when it names none. */
  private moduleFile(from: string, spec: string): string | null {
    if (from.endsWith(".py")) return resolvePythonImport(from, spec, this.fileSet);
    if (spec.startsWith(".")) return resolveImport(from, spec, this.fileSet);
    return this.config.resolve(from, spec, this.fileSet).file;
  }

  /**
   * Where `name`, as `path` exports it, is declared (trustmybot/tmb#233): the file itself, or
   * the end of its re-exports, followed step by step. Null when a step cannot be proven, when
   * a file comes twice in one chain, or when two stars give the name from two declarations.
   */
  private originOf(path: string, name: string): Origin | null {
    return this.follow(path, name, new Set()).origin;
  }

  private follow(path: string, name: string, seen: ReadonlySet<string>): Followed {
    if (this.topLevel.get(path)?.has(name)) return { origin: { path, name }, cut: false };
    if (seen.has(path)) return { origin: null, cut: true };
    const key = `${path}\u0000${name}`;
    const known = this.followed.get(key);
    if (known !== undefined) return { origin: known, cut: false };
    const result = this.followExports(path, name, new Set(seen).add(path));
    // An answer cut short by a cycle holds only for the chain that asked.
    if (!result.cut) this.followed.set(key, result.origin);
    return result;
  }

  private followExports(path: string, name: string, seen: ReadonlySet<string>): Followed {
    const entries = this.exports.get(path) ?? [];
    // A name the file exports by name wins over every star.
    const byName = entries.filter((e) => (e.kind === "name" || e.kind === "namespace") && e.name === name);
    if (byName.length > 1) return { origin: null, cut: false };
    const own = byName[0];
    if (own?.kind === "namespace") {
      const file = this.moduleFile(path, own.source);
      return { origin: file === null ? null : { namespace: file }, cut: false };
    }
    if (own?.kind === "name") {
      if (own.source === null) return { origin: this.topLevel.get(path)?.has(own.original) ? { path, name: own.original } : null, cut: false };
      const file = this.moduleFile(path, own.source);
      return file === null ? { origin: null, cut: false } : this.follow(file, own.original, seen);
    }
    const python = path.endsWith(".py");
    // A star never gives a default export.
    if (!python && name === "default") return { origin: null, cut: false };
    let origin: Origin | null = null;
    let cut = false;
    let unproven = false;
    for (const star of entries) {
      if (star.kind !== "star") continue;
      const file = this.moduleFile(path, star.source);
      if (file === null) {
        unproven = true;
        continue;
      }
      if (python) {
        // Python's star gives the names of `__all__`, else every name not starting with `_`.
        const all = this.exports.get(file)?.find((e) => e.kind === "all");
        if (all?.kind === "all" && all.names === null) {
          unproven = true;
          continue;
        }
        if (all?.kind === "all" ? !all.names!.includes(name) : name.startsWith("_")) continue;
      }
      const step = this.follow(file, name, seen);
      cut ||= step.cut;
      if (step.origin === null) continue;
      if (origin !== null && originKey(origin) !== originKey(step.origin)) return { origin: null, cut };
      origin = step.origin;
    }
    // A star that cannot be followed may give the name too: no star's answer is then proof.
    return { origin: unproven ? null : origin, cut };
  }

  /** The top-level callable `name` declared in `origin`, when it is a declaration. */
  private callableAt(origin: Origin | null): number | undefined {
    if (origin === null || "namespace" in origin) return undefined;
    return (this.byName.get(origin.name) ?? []).find((c) => c.path === origin.path && c.reach === undefined && CALLABLE.has(c.kind))?.id;
  }

  /** The class named `name` as `from` sees it: its own, or the one its import of the name leads to. */
  private classOf(from: string, name: string): { path: string; name: string } | null {
    const isClass = (path: string, n: string) => (this.byName.get(n) ?? []).some((c) => c.path === path && c.kind === "class");
    if (isClass(from, name)) return { path: from, name };
    const imported = this.importMap.get(from)?.get(name);
    if (imported === undefined) return null;
    if (isClass(imported, name)) return { path: imported, name };
    const origin = this.originOf(imported, name);
    return origin !== null && "path" in origin && isClass(origin.path, origin.name) ? origin : null;
  }

  resolve(from: string, edge: ExtractedEdge): Link | null {
    if (NAME_ONLY_EDGES.has(edge.kind)) return null;
    if (edge.kind === "imports") {
      const target = this.importTarget(from, edge).file;
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
      // `ns.f()` on a name imported from a file that exports it as `export * as ns from`.
      const imported = this.importMap.get(from)?.get(edge.hint);
      const namespace = imported === undefined ? null : this.originOf(imported, edge.hint);
      if (namespace !== null && "namespace" in namespace) return link(this.callableAt(this.originOf(namespace.namespace, edge.dst_name)), "exact");
      // A receiver's type is only a name: the call links only when that name is proven to be a
      // class of this repo, defined in this file or imported from a file of it.
      const cls = this.classOf(from, edge.hint);
      if (cls === null) return null;
      const qualified = `${cls.name}.${edge.dst_name}`;
      return link(cands.find((c) => c.kind === "method" && c.path === cls.path && c.qualified_name === qualified)?.id, "exact");
    }
    const declared = cands.filter((c) => c.reach === undefined);
    const same = declared.find((c) => c.path === from);
    if (same) return link(same.id, "exact");
    // A function nested in another is linked by its bare name from inside its parent, and only when
    // no other nested function of that name is in reach there.
    const nested = cands.filter((c) => c.reach === "nested" && c.path === from && c.within && edge.line >= c.within[0] && edge.line <= c.within[1]);
    if (nested.length === 1) return link(nested[0]!.id, "exact");
    const viaImport = this.importMap.get(from)?.get(edge.dst_name);
    if (viaImport) {
      const direct = declared.find((c) => c.path === viaImport);
      // A name the imported file re-exports is linked where it is declared (trustmybot/tmb#233).
      return link(direct?.id ?? this.callableAt(this.originOf(viaImport, edge.dst_name)), "exact");
    }
    const viaSource = (this.sourced.get(from) ?? []).map((p) => declared.find((c) => c.path === p)).find(Boolean);
    return link(viaSource?.id, "exact");
  }
}

function link(dst: number | undefined, how: Link["how"]): Link | null {
  return dst === undefined ? null : { dst, how };
}
