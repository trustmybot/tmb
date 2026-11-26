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
export type Candidate = {
  id: number;
  path: string;
  kind: SymbolKind;
  qualified_name: string;
  reach?: "nested" | "member";
  within?: [number, number];
  /** The line it starts on. */
  line?: number;
  /** A class's bases as its file names them; '' for one that is no plain name. */
  bases?: readonly string[];
  /** The names a class binds to anything but a method, each hiding a parent's method of that name. */
  fields?: readonly string[];
};

/** Why a reference was linked: `exact` on a proof that names the definition, `name` on a receiver's declared type. */
export type Link = { dst: number; how: "exact" | "name" };

const CALLABLE = new Set<SymbolKind>(["function", "method", "class", "sh_function"]);
/**
 * File-level data: a name a statement of the file declares outside any type or function
 * (CODE_GRAPH.md, "Kinds of symbol"). A call whose name the language's lookup ends at such a
 * declaration, in the file's own scope or through an import, is linked to it: the declaration is
 * the proof, so no type is needed (trustmybot/tmb#332). Only a call is linked so; any other use of
 * the name is not.
 */
const FILE_DATA = new Set<SymbolKind>(["const"]);
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

/** The one item of a list, else undefined: two that share a name prove neither (trustmybot/tmb#287). */
const sole = <V>(list: readonly V[]): V | undefined => (list.length === 1 ? list[0] : undefined);

/** What a name a file imports is bound to: the file the import names, null when it names none, and the name there. */
type ImportBinding = { file: string | null; name: string };

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
  /** Each file's names bound by its own top-level imports, by the name the file uses (trustmybot/tmb#287). */
  private readonly importBindings = new Map<string, Map<string, ImportBinding | null>>();
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
        // An import made inside a function holds only there: its calls carry it themselves.
        if (target && edge.bound === undefined) {
          const map = this.importMap.get(from) ?? new Map<string, string>();
          map.set(edge.dst_name, target);
          this.importMap.set(from, map);
        }
        if (edge.bound === undefined) {
          const names = this.importBindings.get(from) ?? new Map<string, ImportBinding | null>();
          const local = edge.local ?? edge.dst_name;
          const known = names.get(local);
          // A name two imports bind to two things is bound by neither on proof.
          names.set(local, known === undefined || (known !== null && known.file === target && known.name === edge.dst_name) ? { file: target, name: edge.dst_name } : null);
          this.importBindings.set(from, names);
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

  /**
   * The top-level symbol `name` declared in `origin` that a reference may name, when it is a
   * declaration: a callable, or file-level data for a call. Never a class's method of that name.
   */
  private declarationAt(origin: Origin | null, call: boolean): number | undefined {
    if (origin === null || "namespace" in origin) return undefined;
    return sole((this.byName.get(origin.name) ?? []).filter((c) => c.path === origin.path && c.reach === undefined && c.kind !== "method" && namable(c.kind, call)))?.id;
  }

  /** The classes named `name` that `path` declares. */
  private classesAt(path: string, name: string): Candidate[] {
    return (this.byName.get(name) ?? []).filter((c) => c.path === path && c.kind === "class");
  }

  /**
   * The class named `name` as `from` sees it: its own, or the one its import binding that name
   * leads to, an import under a new name included (trustmybot/tmb#287). Null when no one class
   * is proven: the file declares two of that name, or the import names no class of the repo.
   */
  private classOf(from: string, name: string): { path: string; name: string } | null {
    const own = this.classesAt(from, name);
    if (own.length > 0) return own.length === 1 ? { path: from, name } : null;
    const bound = this.importBindings.get(from)?.get(name);
    if (bound === undefined || bound === null || bound.file === null) return null;
    const there = this.classesAt(bound.file, bound.name);
    if (there.length > 0) return there.length === 1 ? { path: bound.file, name: bound.name } : null;
    const origin = this.originOf(bound.file, bound.name);
    return origin !== null && "path" in origin && this.classesAt(origin.path, origin.name).length === 1 ? origin : null;
  }

  /** The class `cls` names, once classOf has proven it is the one class of that name in its file. */
  private classRow(cls: { path: string; name: string }): Candidate | undefined {
    return sole(this.classesAt(cls.path, cls.name));
  }

  /** The methods of the class `cls` declares under `name`. */
  private ownMethods(cls: { path: string; name: string }, name: string): Candidate[] {
    const qualified = `${cls.name}.${name}`;
    return (this.byName.get(name) ?? []).filter((c) => c.kind === "method" && c.path === cls.path && c.qualified_name === qualified);
  }

  /**
   * The method `name` of a class as the language finds it on the object itself (trustmybot/tmb#246):
   * the class's own, else its parents', in the repo. The first class that has the name decides,
   * so a field of that name stops the lookup (trustmybot/tmb#287). Undefined when there is none;
   * null when a class has the name as no one method, a parent is not a class of the repo or two
   * parents give two methods, so no answer is proof.
   */
  private methodOf(cls: { path: string; name: string }, name: string, seen: ReadonlySet<string>): number | undefined | null {
    const key = `${cls.path}\u0000${cls.name}`;
    if (seen.has(key)) return null;
    const row = this.classRow(cls);
    if (row?.fields?.includes(name)) return null;
    const own = this.ownMethods(cls, name);
    if (own.length > 0) return sole(own)?.id ?? null;
    const bases = row?.bases ?? [];
    const found = new Set<number>();
    for (const base of bases) {
      const parent = base === "" ? null : this.classOf(cls.path, base);
      if (parent === null) return null;
      const hit = this.methodOf(parent, name, new Set(seen).add(key));
      if (hit === null) return null;
      if (hit !== undefined) found.add(hit);
    }
    return found.size > 1 ? null : [...found][0];
  }

  /**
   * Whether a file of the repo declares `name` at its top level. In a language whose files can
   * share one global scope, such as a TypeScript script with no import or export, that
   * declaration is the global itself, so a built-in of that name is not proven (trustmybot/tmb#252).
   */
  declaresAtTop(name: string): boolean {
    for (const names of this.topLevel.values()) if (names.has(name)) return true;
    return false;
  }

  private readonly packages = new Map<string, boolean>();

  /**
   * Whether the module an import of `from` names is a package outside the repo (trustmybot/tmb#252).
   * With `searched`, the paths at which the language finds it in any folder it searches, it is
   * outside when no file of the repo is at one of them. Without, it is outside when the repo's
   * import settings resolve it to no file and to none of the repo's own code, the same answer
   * that makes such an import no miss.
   */
  isPackage(from: string, spec: string, searched?: readonly string[]): boolean {
    const key = searched === undefined ? `${posix.dirname(from)}\u0000${spec}` : `\u0000${searched.join("\u0000")}`;
    const known = this.packages.get(key);
    if (known !== undefined) return known;
    let outside: boolean;
    if (searched !== undefined) {
      const at = searched.map((s) => `/${s}`);
      outside = !this.anyFile((f) => at.some((s) => (s.endsWith("/") ? `/${f}`.includes(s) : `/${f}`.endsWith(s))));
    } else {
      const target = this.config.resolve(from, spec, this.fileSet);
      outside = target.file === null && !target.local;
    }
    this.packages.set(key, outside);
    return outside;
  }

  private anyFile(test: (file: string) => boolean): boolean {
    for (const file of this.fileSet) if (test(file)) return true;
    return false;
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
    const call = edge.call === 1;
    const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => CALLABLE.has(c.kind));
    // A bare or imported name is never a class's method of that name (trustmybot/tmb#242). A call
    // of it may name file-level data too (trustmybot/tmb#332).
    const declared = (this.byName.get(edge.dst_name) ?? []).filter((c) => namable(c.kind, call) && c.reach === undefined && c.kind !== "method");
    // A name bound around the reference is looked up there first, and only there (trustmybot/tmb#246).
    if (edge.bound === "value") return null;
    if (edge.bound === "self") {
      const cls = edge.hint === null ? null : this.classOf(from, edge.hint);
      return cls === null ? null : link(this.methodOf(cls, edge.dst_name, new Set()) ?? undefined, "exact");
    }
    if (edge.bound === "import") {
      const file = this.importTarget(from, { ...edge, kind: "imports" }).file;
      if (file === null) return null;
      const there = declared.filter((c) => c.path === file);
      return link(there.length > 0 ? sole(there)?.id : this.declarationAt(this.originOf(file, edge.dst_name), call), "exact");
    }
    if (edge.bound === "function") {
      const at = cands.filter((c) => c.path === from && c.reach !== "member" && String(c.line) === edge.hint);
      return link(at.length === 1 ? at[0]!.id : undefined, "exact");
    }
    // A call on `this` outside a class it can name has nothing to look in.
    if (edge.hint === "this") return null;
    if (edge.hint !== null) {
      // `ns.f()` on a name imported from a file that exports it as `export * as ns from`.
      const imported = this.importBindings.get(from)?.get(edge.hint);
      const namespace = imported?.file ? this.originOf(imported.file, imported.name) : null;
      if (namespace !== null && "namespace" in namespace) return link(this.declarationAt(this.originOf(namespace.namespace, edge.dst_name), call), "exact");
      // A receiver's type is only a name: the call links only when that name is proven to be a
      // class of this repo, defined in this file or imported from a file of it.
      const cls = this.classOf(from, edge.hint);
      if (cls === null) return null;
      return link(sole(this.ownMethods(cls, edge.dst_name))?.id, "exact");
    }
    // A name the file declares twice names neither on proof (trustmybot/tmb#287).
    const same = declared.filter((c) => c.path === from);
    // Data the file binds by an import as well is bound twice, and which binding holds depends on
    // the order they run in, which the graph does not keep: neither is proof (trustmybot/tmb#332).
    if (same.some((c) => FILE_DATA.has(c.kind)) && this.importBindings.get(from)?.has(edge.dst_name)) return null;
    if (same.length > 0) return link(sole(same)?.id, "exact");
    // A function nested in another is linked by its bare name from inside its parent, and only when
    // no other nested function of that name is in reach there.
    const nested = cands.filter((c) => c.reach === "nested" && c.path === from && c.within && edge.line >= c.within[0] && edge.line <= c.within[1]);
    if (nested.length === 1) return link(nested[0]!.id, "exact");
    const viaImport = this.importMap.get(from)?.get(edge.dst_name);
    if (viaImport) {
      const direct = declared.filter((c) => c.path === viaImport);
      // A name the imported file re-exports is linked where it is declared (trustmybot/tmb#233).
      return link(direct.length > 0 ? sole(direct)?.id : this.declarationAt(this.originOf(viaImport, edge.dst_name), call), "exact");
    }
    const viaSource = (this.sourced.get(from) ?? []).map((p) => declared.find((c) => c.path === p)).find(Boolean);
    return link(viaSource?.id, "exact");
  }
}

/**
 * The state of a call written in a function (trustmybot/tmb#252): linked to a definition of the
 * repo, to code outside the repo, or not known.
 */
export type CallState = "linked" | "outside" | "not_known";

/**
 * Where a call goes when it is not linked, on the same proof a link needs (trustmybot/tmb#252):
 * outside the repo when the language's lookup ends at one of its built-ins that no file of the
 * repo declares at its top level, or at an import of a module that names no file of the repo
 * and none of its own code; else not known.
 */
export function callState(resolver: Resolver, from: string, edge: ExtractedEdge, link: Link | null): CallState {
  if (link !== null) return "linked";
  const outside = edge.outside;
  if (outside === undefined) return "not_known";
  if (outside.kind === "builtin") return resolver.declaresAtTop(outside.name) ? "not_known" : "outside";
  return resolver.isPackage(from, outside.module, outside.searched) ? "outside" : "not_known";
}

function link(dst: number | undefined, how: Link["how"]): Link | null {
  return dst === undefined ? null : { dst, how };
}

/** Whether a reference may name a symbol of `kind`: a callable always, file-level data only from a call. */
function namable(kind: SymbolKind, call: boolean): boolean {
  return CALLABLE.has(kind) || (call && FILE_DATA.has(kind));
}
