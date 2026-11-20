// How a JavaScript or TypeScript import that does not start with a dot names a file of the repo
// (trustmybot/tmb#147): through a tsconfig's or jsconfig's `paths` and `baseUrl`, by the nearest
// config above the importing file as TypeScript resolves it, or through the name of a package
// whose package.json is in the repo. Every config is read at the indexed commit. Nothing is
// guessed: an import that names no file of the repo stays unresolved.
import { posix } from "node:path";

/** The config files an index reads besides the source: every package.json, tsconfig*.json and jsconfig*.json. */
export function isImportConfigPath(relPath: string): boolean {
  const name = posix.basename(relPath);
  return name === "package.json" || /^[tj]sconfig(\..+)?\.json$/.test(name);
}

/** The files a specifier may name, in the order Node and TypeScript try them; `.js` names its `.ts` source too. */
export function fileCandidates(base: string): string[] {
  const stem = base.replace(/\.(m?js|jsx|ts|tsx)$/, "");
  return [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}.jsx`,
    `${stem}.mjs`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
    `${stem}/index.js`,
    `${stem}/index.jsx`,
  ];
}

function firstFile(base: string, fileSet: ReadonlySet<string>): string | null {
  const normal = posix.normalize(base);
  if (normal.startsWith("..")) return null;
  for (const candidate of fileCandidates(normal)) if (fileSet.has(candidate)) return candidate;
  return null;
}

/** JSON with comments and trailing commas, as tsconfig files are written; null when it is not an object. */
export function parseJsonc(text: string): Record<string, unknown> | null {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  try {
    const value: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One tsconfig's or jsconfig's resolution settings, with every path relative to the repo's top. */
type CompilerPaths = { baseUrl: string | null; paths: { pattern: string; targets: string[] }[] };

/** One package of the repo: its name, its folder and the files its package.json names as its entry. */
type RepoPackage = { name: string; dir: string; entries: string[]; exports: Map<string, string> };

/** What an import resolved to: the file, or null; `local` when it named the repo's own code, so a miss counts. */
export type ImportTarget = { file: string | null; local: boolean };

const isString = (value: unknown): value is string => typeof value === "string";

/** The first string an `exports` condition object leads to, in the order a TypeScript build reads them. */
function exportTarget(value: unknown): string | null {
  if (isString(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item);
      if (target !== null) return target;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const conditions = value as Record<string, unknown>;
  for (const key of ["source", "types", "import", "module", "default", "require", "node"]) {
    if (key in conditions) {
      const target = exportTarget(conditions[key]);
      if (target !== null) return target;
    }
  }
  return null;
}

function packageOf(dir: string, json: Record<string, unknown>): RepoPackage | null {
  if (!isString(json.name) || json.name === "") return null;
  const exports = new Map<string, string>();
  const raw = json.exports;
  if (isString(raw) || Array.isArray(raw)) {
    const target = exportTarget(raw);
    if (target !== null) exports.set(".", target);
  } else if (typeof raw === "object" && raw !== null) {
    const entries = Object.entries(raw as Record<string, unknown>);
    // An exports object keyed by conditions, not subpaths, is the package's one entry.
    if (entries.every(([key]) => !key.startsWith("."))) {
      const target = exportTarget(raw);
      if (target !== null) exports.set(".", target);
    } else {
      for (const [key, value] of entries) {
        const target = exportTarget(value);
        if (target !== null && !key.includes("*")) exports.set(key, target);
      }
    }
  }
  const entries = [json.source, json.types, json.typings, exports.get("."), json.module, json.main].filter(isString);
  return { name: json.name, dir, entries, exports };
}

export class ImportConfig {
  /** Each folder that holds a tsconfig.json (else a jsconfig.json), with its settings after `extends`. */
  private readonly configs = new Map<string, CompilerPaths>();
  private readonly packages = new Map<string, RepoPackage>();

  /** `files` maps each config file's repo path to its text. */
  constructor(files: ReadonlyMap<string, string>) {
    const parsed = new Map<string, Record<string, unknown>>();
    for (const [file, text] of files) {
      const json = parseJsonc(text);
      if (json !== null) parsed.set(file, json);
    }
    const ambiguous = new Set<string>();
    for (const [file, json] of parsed) {
      if (posix.basename(file) !== "package.json") continue;
      const pkg = packageOf(posix.dirname(file), json);
      if (pkg === null) continue;
      // Two packages of one name: an import of it names neither for sure.
      if (this.packages.has(pkg.name)) ambiguous.add(pkg.name);
      else this.packages.set(pkg.name, pkg);
    }
    for (const name of ambiguous) this.packages.delete(name);
    for (const file of parsed.keys()) {
      const name = posix.basename(file);
      if (name !== "tsconfig.json" && name !== "jsconfig.json") continue;
      const dir = posix.dirname(file);
      // A folder with both: TypeScript reads the tsconfig.
      if (name === "jsconfig.json" && parsed.has(posix.join(dir, "tsconfig.json"))) continue;
      this.configs.set(dir, this.compilerPaths(file, parsed, new Set()));
    }
  }

  /** A config's baseUrl and paths, each from the nearest file in its `extends` chain that sets it. */
  private compilerPaths(file: string, parsed: ReadonlyMap<string, Record<string, unknown>>, seen: Set<string>): CompilerPaths {
    seen.add(file);
    const json = parsed.get(file);
    const dir = posix.dirname(file);
    let inherited: CompilerPaths = { baseUrl: null, paths: [] };
    const extendsList = json === undefined ? [] : Array.isArray(json.extends) ? json.extends.filter(isString) : isString(json.extends) ? [json.extends] : [];
    for (const parent of extendsList) {
      // Only a config of the repo, named by a relative path, is followed; a package's config is not in the graph.
      if (!parent.startsWith(".")) continue;
      const parentFile = posix.normalize(posix.join(dir, parent.endsWith(".json") ? parent : `${parent}.json`));
      if (seen.has(parentFile) || !parsed.has(parentFile)) continue;
      const from = this.compilerPaths(parentFile, parsed, seen);
      inherited = { baseUrl: from.baseUrl ?? inherited.baseUrl, paths: from.paths.length > 0 ? from.paths : inherited.paths };
    }
    const options = json?.compilerOptions;
    if (typeof options !== "object" || options === null) return inherited;
    const { baseUrl, paths } = options as Record<string, unknown>;
    const ownBase = isString(baseUrl) ? posix.normalize(posix.join(dir, baseUrl)) : null;
    const result: CompilerPaths = { baseUrl: ownBase ?? inherited.baseUrl, paths: inherited.paths };
    if (typeof paths === "object" && paths !== null && !Array.isArray(paths)) {
      // Paths are relative to baseUrl when there is one, else to the config that sets them.
      const root = result.baseUrl ?? dir;
      result.paths = Object.entries(paths as Record<string, unknown>)
        .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
        .map(([pattern, targets]) => ({ pattern, targets: targets.filter(isString).map((t) => posix.join(root, t)) }));
    }
    return result;
  }

  /** The config that governs a file: the nearest folder above it with one. */
  private configFor(fromFile: string): CompilerPaths | null {
    for (let dir = posix.dirname(fromFile); ; dir = posix.dirname(dir)) {
      const config = this.configs.get(dir);
      if (config !== undefined) return config;
      if (dir === "." || dir === "/" || dir === "") return null;
    }
  }

  /** Resolves a specifier that does not start with a dot. */
  resolve(fromFile: string, spec: string, fileSet: ReadonlySet<string>): ImportTarget {
    const config = this.configFor(fromFile);
    let local = false;
    if (config !== null) {
      const match = matchPaths(config.paths, spec);
      if (match !== null) {
        local = true;
        for (const target of match.targets) {
          const file = firstFile(target.replace("*", match.star), fileSet);
          if (file !== null) return { file, local };
        }
      }
      if (config.baseUrl !== null) {
        const file = firstFile(posix.join(config.baseUrl, spec), fileSet);
        if (file !== null) return { file, local: true };
      }
    }
    const pkg = this.packageNamed(spec);
    if (pkg !== null) return { file: this.packageFile(pkg.pkg, pkg.subpath, fileSet), local: true };
    return { file: null, local };
  }

  private packageNamed(spec: string): { pkg: RepoPackage; subpath: string } | null {
    // A scoped name has two parts: @scope/name.
    const parts = spec.split("/");
    const nameParts = spec.startsWith("@") ? 2 : 1;
    if (parts.length < nameParts) return null;
    const pkg = this.packages.get(parts.slice(0, nameParts).join("/"));
    return pkg === undefined ? null : { pkg, subpath: parts.slice(nameParts).join("/") };
  }

  private packageFile(pkg: RepoPackage, subpath: string, fileSet: ReadonlySet<string>): string | null {
    if (subpath === "") {
      for (const entry of pkg.entries) {
        const file = firstFile(posix.join(pkg.dir, entry), fileSet);
        if (file !== null) return file;
      }
      return firstFile(posix.join(pkg.dir, "index"), fileSet);
    }
    const exported = pkg.exports.get(`./${subpath}`);
    if (exported !== undefined) return firstFile(posix.join(pkg.dir, exported), fileSet);
    return firstFile(posix.join(pkg.dir, subpath), fileSet);
  }
}

/** The `paths` pattern a specifier matches, as TypeScript picks it: an exact one first, else the longest prefix before its `*`. */
function matchPaths(paths: CompilerPaths["paths"], spec: string): { targets: string[]; star: string } | null {
  const exact = paths.find((p) => !p.pattern.includes("*") && p.pattern === spec);
  if (exact !== undefined) return { targets: exact.targets, star: "" };
  let best: { targets: string[]; star: string; prefix: number } | null = null;
  for (const { pattern, targets } of paths) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.length >= prefix.length + suffix.length && spec.startsWith(prefix) && spec.endsWith(suffix) && (best === null || prefix.length > best.prefix)) {
      best = { targets, star: spec.slice(prefix.length, spec.length - suffix.length), prefix: prefix.length };
    }
  }
  return best;
}
