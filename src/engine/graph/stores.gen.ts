// Writes stores.ts (trustmybot/tmb#339): which installed packages reach a data store, and which
// store. Nothing is typed out by hand. It joins two sources of the OpenTelemetry project, each at a
// pinned commit (CODE_GRAPH.md, "Data sources"):
//   - the semantic conventions, whose system attributes list the store systems and their kind:
//     a database system or a messaging system (a queue);
//   - the JavaScript and Python contrib instrumentations, each of which names the packages it
//     instruments and, in its code, the systems it sets on the spans around their calls.
// The rules of the join:
//   - A package an instrumentation instruments is one its tests run against (.tav.yml) or one its
//     hook definitions load (JavaScript), or one that alone lets it run: the single entry of
//     `_instruments`, or any entry of `_instruments_any` (Python). Packages it requires together
//     are not listed, since the source does not say which of them it instruments.
//   - An instrumentation reaches each system of the conventions its code names, by value or by the
//     conventions' generated constant. One that names none, and writes a system attribute only
//     from a value it computes, reads the system at run time.
//   - A package reaches the systems of every listed package it depends on, as the source's own
//     lock file records.
//   - A package that reaches one known system is a store package of that system. One that reaches
//     several, or one read at run time, serves several stores: the package alone does not say
//     which, so a call into it gives no data source.
// Run it after a pin below moves: `bun src/engine/graph/stores.gen.ts`. It fetches each source at
// its commit into a cache folder (one shallow, sparse fetch each), or reads the folders the
// variables name. A test fails when stores.ts is not what this writes, and is skipped, saying why,
// without the sources.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The file this writes, beside it. */
export const STORES_FILE = path.join(import.meta.dir, "stores.ts");

export type StoreSource = { name: "semconv" | "js" | "py"; url: string; commit: string; env: string; paths: readonly string[] };

/** The sources, each at its pinned commit, with the paths of it the join reads. */
export const STORE_SOURCES: readonly StoreSource[] = [
  { name: "semconv", url: "https://github.com/open-telemetry/semantic-conventions.git", commit: "054189a0330c4fb05f8e8e80d84f89765e49fb6f", env: "TMB_STORE_SOURCE_SEMCONV", paths: ["/model/"] },
  {
    name: "js",
    url: "https://github.com/open-telemetry/opentelemetry-js-contrib.git",
    commit: "e4e9e44a9a670f5f2519fb0d001ee571276114bf",
    env: "TMB_STORE_SOURCE_JS",
    paths: ["/packages/*/.tav.yml", "/packages/*/src/", "/package-lock.json"],
  },
  {
    name: "py",
    url: "https://github.com/open-telemetry/opentelemetry-python-contrib.git",
    commit: "79d3150eab4f47aec3e91709b24539b0058c9e19",
    env: "TMB_STORE_SOURCE_PY",
    paths: ["/instrumentation/*/src/", "/uv.lock"],
  },
];

export type StoreFolders = Record<StoreSource["name"], string>;

/** The kind of store each system attribute of the conventions names. */
const SYSTEM_ATTRIBUTES: Readonly<Record<string, StoreKind>> = { "db.system.name": "database", "messaging.system.name": "queue" };

export type StoreKind = "database" | "queue";
/** A store an instrumentation reaches; a null system is one it reads at run time. */
export type Reach = { kind: StoreKind; system: string | null };
export type Instrumentation = { name: string; packages: string[]; reaches: Reach[] };
export type StoreList = { one: Map<string, { kind: StoreKind; system: string }>; several: Set<string> };

// ---- The semantic conventions -------------------------------------------------------------------

type Systems = { byValue: Map<string, StoreKind>; byConstant: Map<StoreKind, Map<string, string>> };

function walk(dir: string, keep: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? walk(p, keep) : keep(p) ? [p] : [];
    });
}

/** The name the conventions' generated constants give a value: its dots and dashes made underscores, upper case. */
const constantName = (value: string): string => value.replace(/[.-]/g, "_").toUpperCase();

type YamlAttribute = { id?: string; deprecated?: { renamed_to?: string }; type?: { members?: { value?: unknown }[] } };

/** Every value of a system attribute in the conventions, and of a deprecated attribute renamed to one. */
export function conventionSystems(semconv: string): Systems {
  const byValue = new Map<string, StoreKind>();
  const byConstant = new Map<StoreKind, Map<string, string>>();
  for (const file of walk(path.join(semconv, "model"), (f) => f.endsWith(".yaml"))) {
    const doc = Bun.YAML.parse(readFileSync(file, "utf8")) as { groups?: { attributes?: YamlAttribute[] }[] } | null;
    for (const attr of (doc?.groups ?? []).flatMap((g) => g.attributes ?? [])) {
      const kind = SYSTEM_ATTRIBUTES[attr.id ?? ""] ?? SYSTEM_ATTRIBUTES[attr.deprecated?.renamed_to ?? ""];
      if (kind === undefined) continue;
      for (const m of attr.type?.members ?? []) {
        if (typeof m.value !== "string") continue;
        byValue.set(m.value, kind);
        if (!byConstant.has(kind)) byConstant.set(kind, new Map());
        byConstant.get(kind)!.set(constantName(m.value), m.value);
      }
    }
  }
  return { byValue, byConstant };
}

// ---- An instrumentation's code ------------------------------------------------------------------

/** A generated constant of a system value: its attribute's kind, then the value's constant name. */
const SYSTEM_CONSTANT = /\b(?:(DB)|(MESSAGING))_?SYSTEM(?:_?NAME)?_?VALUES?_([A-Z0-9_]+)|\b(?:(Db)|(Messaging))System(?:Name)?Values\.([A-Z0-9_]+)/g;
/** A name that holds a system attribute's key, or a system: `ATTR_DB_SYSTEM_NAME`, `SpanAttributes.DB_SYSTEM`, `_DATABASE_SYSTEM`. */
const KEY = String.raw`\w*(?:DB|DATABASE|MESSAGING)_SYSTEM(?:_NAME)?\b`;
const EXPR = String.raw`([^,;)}\n]*)`;
/**
 * The ways code writes a system: as an object's key or an index (`[KEY]: v`, `a[KEY] = v`), as a
 * dict key (`{SpanAttributes.DB_SYSTEM: v}`), through a setter (`setAttribute(KEY, v)`,
 * `_set_db_system(a, v)`), or as the value of a name that holds the system (`_DATABASE_SYSTEM = v`).
 */
const SYSTEM_WRITES: readonly RegExp[] = [
  new RegExp(String.raw`(${KEY})\s*\]\s*[:=](?![:=])\s*${EXPR}`, "g"),
  new RegExp(String.raw`\b(${KEY})\s*:(?![:=])\s*${EXPR}`, "g"),
  new RegExp(String.raw`\bset_?[aA]ttribute\(\s*[\w.]*?(${KEY})\s*,\s*${EXPR}`, "g"),
  new RegExp(String.raw`\b_set_(db)_system\(\s*[^,]+,\s*${EXPR}`, "g"),
  new RegExp(String.raw`^[ \t]*(${KEY})\s*(?::[^=\n]*)?=(?!=)\s*${EXPR}`, "gm"),
];
const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const QUOTED = /^(['"])(.*)\1$/;

/** The code without its comments, so a value named in a comment is not taken as set. */
function withoutComments(text: string, line: "//" | "#"): string {
  const block = line === "//" ? text.replace(/\/\*[\s\S]*?\*\//g, "") : text;
  return block.replace(line === "//" ? /(^|\s)\/\/.*$/gm : /(^|\s)#.*$/gm, "$1");
}

/** The stores an instrumentation's code reaches. */
export function reaches(code: string, systems: Systems): Reach[] {
  const out = new Map<string, Reach>();
  const add = (kind: StoreKind, system: string | null): void => void out.set(`${kind}:${system}`, { kind, system });
  for (const m of code.matchAll(SYSTEM_CONSTANT)) {
    const kind: StoreKind = m[1] || m[4] ? "database" : "queue";
    const value = systems.byConstant.get(kind)?.get(m[3] ?? m[6]!);
    if (value !== undefined) add(kind, value);
  }
  const writes = SYSTEM_WRITES.flatMap((re) =>
    [...code.matchAll(re)].map((m) => ({ kind: (/MESSAGING/i.test(m[1]!) ? "queue" : "database") as StoreKind, value: m[2]!.trim() })),
  );
  for (const w of writes) {
    const literal = QUOTED.exec(w.value)?.[2];
    const kind = literal === undefined ? undefined : systems.byValue.get(literal);
    if (kind !== undefined) add(kind, literal!);
  }
  if (out.size > 0) return [...out.values()];
  // It names no system. Written only from values it computes, the system is read at run time.
  const computed = (value: string): boolean => value !== "" && !QUOTED.test(value) && !new RegExp(`^(?:${SYSTEM_CONSTANT.source})`).test(value);
  if (writes.length === 0 || !writes.every((w) => computed(w.value))) return [];
  for (const w of writes) add(w.kind, null);
  return [...out.values()];
}

// ---- The JavaScript instrumentations ------------------------------------------------------------

const TAV_KEY = /^["']?([@a-z0-9][^"':\s]*)["']?:\s*$/gm;
const HOOK_DEFINITION = /new InstrumentationNodeModuleDefinition\(\s*(['"])([^'"]+)\1/g;

export function jsInstrumentations(js: string, systems: Systems): Instrumentation[] {
  const root = path.join(js, "packages");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => d.startsWith("instrumentation-"))
    .sort()
    .map((name) => {
      const dir = path.join(root, name);
      const packages = new Set<string>();
      const tav = path.join(dir, ".tav.yml");
      if (existsSync(tav)) for (const m of readFileSync(tav, "utf8").matchAll(TAV_KEY)) packages.add(m[1]!);
      const code = walk(path.join(dir, "src"), (f) => f.endsWith(".ts"))
        .map((f) => withoutComments(readFileSync(f, "utf8"), "//"))
        .join("\n");
      for (const m of code.matchAll(HOOK_DEFINITION)) packages.add(m[2]!);
      return { name, packages: [...packages].sort(), reaches: reaches(code, systems) };
    });
}

/** Each package's dependencies, as npm's lock file records them. */
export function npmLockDependencies(lockText: string): Map<string, Set<string>> {
  const lock = JSON.parse(lockText) as { packages?: Record<string, { dependencies?: Record<string, string> }> };
  const out = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const at = key.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const name = key.slice(at + "node_modules/".length);
    if (!out.has(name)) out.set(name, new Set());
    for (const dep of Object.keys(entry.dependencies ?? {})) out.get(name)!.add(dep);
  }
  return out;
}

// ---- The Python instrumentations ----------------------------------------------------------------

/** A distribution's name as the package index normalises it (PEP 503). */
export const pypiName = (requirement: string): string =>
  (/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1] ?? requirement).toLowerCase().replace(/[-_.]+/g, "-");

const ASSIGNMENT = /^(_instruments\w*)\s*(?::[^=\n]*)?=\s*/gm;

/** The value of each `_instruments…` name in package.py, as requirement strings, names resolved. */
function instrumentsNames(text: string): Map<string, string[]> {
  const raw = new Map<string, string>();
  for (const m of text.matchAll(ASSIGNMENT)) {
    const start = m.index! + m[0].length;
    let end = start;
    let depth = 0;
    for (; end < text.length; end++) {
      const c = text[end]!;
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "\n" && depth <= 0) break;
    }
    raw.set(m[1]!, text.slice(start, end));
  }
  const resolved = new Map<string, string[]>();
  const resolve = (name: string, seen: Set<string>): string[] => {
    if (resolved.has(name)) return resolved.get(name)!;
    const expr = raw.get(name);
    if (expr === undefined || seen.has(name)) return [];
    seen.add(name);
    const out = [...expr.matchAll(STRING_LITERAL)].map((s) => s[2]!);
    for (const ref of expr.replace(STRING_LITERAL, "").matchAll(/\b(_instruments\w*)\b/g)) out.push(...resolve(ref[1]!, seen));
    resolved.set(name, out);
    return out;
  };
  for (const name of raw.keys()) resolve(name, new Set());
  return resolved;
}

/** The packages that alone let an instrumentation run: none when it requires several together. */
function alonePackages(packagePy: string): string[] {
  const names = instrumentsNames(packagePy);
  const all = names.get("_instruments") ?? [];
  const any = names.get("_instruments_any") ?? [];
  const required = all.length + (any.length > 0 ? 1 : 0);
  if (required !== 1) return [];
  return [...new Set((all.length === 1 ? all : any).map(pypiName))].sort();
}

export function pyInstrumentations(py: string, systems: Systems): Instrumentation[] {
  const root = path.join(py, "instrumentation");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => d.startsWith("opentelemetry-instrumentation-"))
    .sort()
    .flatMap((name) => {
      const files = walk(path.join(root, name, "src"), (f) => f.endsWith(".py"));
      const packagePy = files.find((f) => path.basename(f) === "package.py");
      if (packagePy === undefined) return [];
      const code = files.map((f) => withoutComments(readFileSync(f, "utf8"), "#")).join("\n");
      return [{ name, packages: alonePackages(readFileSync(packagePy, "utf8")), reaches: reaches(code, systems) }];
    });
}

/** Each package's dependencies, as uv's lock file records them. */
export function uvLockDependencies(lockText: string): Map<string, Set<string>> {
  const lock = Bun.TOML.parse(lockText) as { package?: { name: string; dependencies?: { name: string }[] }[] };
  const out = new Map<string, Set<string>>();
  for (const p of lock.package ?? []) {
    const name = pypiName(p.name);
    if (!out.has(name)) out.set(name, new Set());
    for (const d of p.dependencies ?? []) out.get(name)!.add(pypiName(d.name));
  }
  return out;
}

// ---- The join -----------------------------------------------------------------------------------

/** The store packages of one registry. */
export function joinStores(instrumentations: Instrumentation[], dependencies: Map<string, Set<string>>): StoreList {
  const own = new Map<string, Map<string, Reach>>();
  for (const i of instrumentations) {
    if (i.reaches.length === 0) continue;
    for (const p of i.packages) {
      if (!own.has(p)) own.set(p, new Map());
      for (const r of i.reaches) own.get(p)!.set(`${r.kind}:${r.system}`, r);
    }
  }
  const one = new Map<string, { kind: StoreKind; system: string }>();
  const several = new Set<string>();
  for (const pkg of [...own.keys()].sort()) {
    const all = new Map<string, Reach>();
    const seen = new Set<string>();
    const visit = (p: string): void => {
      if (seen.has(p)) return;
      seen.add(p);
      for (const [k, r] of own.get(p) ?? []) all.set(k, r);
      for (const d of dependencies.get(p) ?? []) visit(d);
    };
    visit(pkg);
    const stores = [...all.values()];
    const only = stores[0]!;
    if (stores.length === 1 && only.system !== null) one.set(pkg, { kind: only.kind, system: only.system });
    else several.add(pkg);
  }
  return { one, several };
}

/** The store packages of npm and of PyPI, from the sources in these folders. */
export function storeLists(folders: StoreFolders): { npm: StoreList; pypi: StoreList } {
  const systems = conventionSystems(folders.semconv);
  const read = (file: string, parse: (text: string) => Map<string, Set<string>>) => (existsSync(file) ? parse(readFileSync(file, "utf8")) : new Map<string, Set<string>>());
  return {
    npm: joinStores(jsInstrumentations(folders.js, systems), read(path.join(folders.js, "package-lock.json"), npmLockDependencies)),
    pypi: joinStores(pyInstrumentations(folders.py, systems), read(path.join(folders.py, "uv.lock"), uvLockDependencies)),
  };
}

// ---- The file -----------------------------------------------------------------------------------

/** The text of stores.ts. */
export function storesText(lists: { npm: StoreList; pypi: StoreList }): string {
  const one = (l: StoreList) => [...l.one].map(([p, s]) => `    [${JSON.stringify(p)}, ${JSON.stringify(s.kind)}, ${JSON.stringify(s.system)}],`);
  const several = (l: StoreList) => [...l.several].map((p) => `    ${JSON.stringify(p)},`);
  return [
    "// Generated by stores.gen.ts. Do not edit. Its sources, each at a pinned commit:",
    ...STORE_SOURCES.map((s) => `//   ${s.url} ${s.commit}`),
    "// The packages of each registry whose calls reach a data store, by the join stores.gen.ts states.",
    "",
    'export type StoreKind = "database" | "queue";',
    "export type Store = { readonly kind: StoreKind; readonly system: string };",
    "",
    "const ONE: Readonly<Record<\"npm\" | \"pypi\", readonly (readonly [string, StoreKind, string])[]>> = {",
    "  npm: [",
    ...one(lists.npm),
    "  ],",
    "  pypi: [",
    ...one(lists.pypi),
    "  ],",
    "};",
    "",
    "const SEVERAL: Readonly<Record<\"npm\" | \"pypi\", readonly string[]>> = {",
    "  npm: [",
    ...several(lists.npm),
    "  ],",
    "  pypi: [",
    ...several(lists.pypi),
    "  ],",
    "};",
    "",
    "const stores = (entries: readonly (readonly [string, StoreKind, string])[]): ReadonlyMap<string, Store> => new Map(entries.map(([p, kind, system]) => [p, { kind, system }]));",
    "",
    "/** Each registry's packages whose calls reach one store: its kind and system. A PyPI name is normalised as the index does. */",
    "export const STORE_PACKAGES = { npm: stores(ONE.npm), pypi: stores(ONE.pypi) } as const;",
    "",
    "/** Each registry's packages that serve several stores, or one named only at run time: the package alone does not say which. */",
    "export const SEVERAL_STORE_PACKAGES = { npm: new Set(SEVERAL.npm) as ReadonlySet<string>, pypi: new Set(SEVERAL.pypi) as ReadonlySet<string> } as const;",
    "",
  ].join("\n");
}

// ---- The sources' folders -----------------------------------------------------------------------

const cacheFolder = (s: StoreSource): string => path.join(homedir(), ".cache", "tmb", "stores", `${s.name}-${s.commit.slice(0, 7)}`);
const folderOf = (s: StoreSource): string => {
  const fromEnv = process.env[s.env]?.trim();
  return fromEnv ? path.resolve(fromEnv) : cacheFolder(s);
};

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 600_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** The sources' folders when each holds its pinned commit, else why the check cannot run. */
export function sourceFolders(): { folders: StoreFolders } | { skip: string } | { error: string } {
  const folders = {} as StoreFolders;
  for (const s of STORE_SOURCES) {
    const folder = folderOf(s);
    const how = `run \`bun src/engine/graph/stores.gen.ts\` to fetch the sources, or set ${s.env} to a checkout of ${s.url} at ${s.commit.slice(0, 7)}`;
    if (!existsSync(folder)) {
      if (process.env[s.env]?.trim()) return { error: `${s.env} names ${folder}, which does not exist; ${how}` };
      return { skip: `no copy of ${s.url} at ${folder}; ${how}` };
    }
    const head = git(folder, ["rev-parse", "HEAD"]);
    if (!head.ok || head.out !== s.commit) return { error: `${folder} is not at ${s.commit.slice(0, 7)}; ${how}` };
    folders[s.name] = folder;
  }
  return { folders };
}

/** Fetches one source's pinned commit alone, with only the paths the join reads. */
function fetchSource(s: StoreSource, folder: string): void {
  mkdirSync(folder, { recursive: true });
  if (git(folder, ["rev-parse", "HEAD"]).out === s.commit) return;
  const steps: string[][] = [
    ["init", "--quiet"],
    ["sparse-checkout", "set", "--no-cone", ...s.paths],
    ["fetch", "--quiet", "--depth", "1", "--filter=blob:none", s.url, s.commit],
    ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "FETCH_HEAD"],
  ];
  for (const args of steps) {
    const r = git(folder, args);
    if (!r.ok) throw new Error(`git ${args.join(" ")} failed in ${folder}: ${r.out}`);
  }
}

if (import.meta.main) {
  const folders = {} as StoreFolders;
  for (const s of STORE_SOURCES) {
    folders[s.name] = folderOf(s);
    fetchSource(s, folders[s.name]);
  }
  const lists = storeLists(folders);
  writeFileSync(STORES_FILE, storesText(lists));
  for (const r of ["npm", "pypi"] as const) console.log(`${r}: ${lists[r].one.size} packages of one store, ${lists[r].several.size} of several`);
}
