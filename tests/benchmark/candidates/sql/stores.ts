// Research harness for trustmybot/tmb#339 (task 2): which packages talk to a data store, and of what
// kind, read from the OpenTelemetry sources with no package named by hand.
//   OTEL_SEMCONV=… OTEL_JS_CONTRIB=… OTEL_PY_CONTRIB=… bun tests/benchmark/candidates/sql/stores.ts [pkg …]
// The semantic conventions give the store systems: db.system.name (databases), messaging.system.name
// (queues), and the object-store attributes (aws.s3.*). Each contrib instrumentation names the
// packages it hooks (JS: .tav.yml keys and InstrumentationNodeModuleDefinition; Python: _instruments)
// and, in its source, the system values it sets. A package maps to the systems its instrumentation
// sets; one that sets none is no store client.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

type Kind = "database" | "queue" | "object storage";
export type Mapping = { ecosystem: "npm" | "pypi"; pkg: string; instrumentation: string; systems: Array<{ kind: Kind; system: string }> };

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
function files(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "test" || f === "tests" || f === "node_modules" ? [] : files(p, ext);
    return ext.test(f) ? [p] : [];
  });
}

// The members of one enum attribute in the semantic-conventions model, keyed by the member id with
// dots and dashes made underscores, as the generated constants spell it.
function members(file: string, attr: string): Map<string, string> {
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === `- id: ${attr}`);
  const out = new Map<string, string>();
  const indent = lines[at]!.indexOf("-");
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim().startsWith("- id:") && l.indexOf("-") <= indent) break;
    const v = /^\s*value:\s*["']?([^"'\s]+)/.exec(l);
    if (v) out.set(v[1]!.replace(/[.-]/g, "_").toUpperCase(), v[1]!);
  }
  return out;
}

export function storeMap(): Mapping[] {
  const sem = env("OTEL_SEMCONV");
  const db = members(path.join(sem, "model/db/registry.yaml"), "db.system.name");
  const mq = members(path.join(sem, "model/messaging/registry.yaml"), "messaging.system.name");
  const oldDb = existsSync(path.join(sem, "model/db/deprecated/registry-deprecated.yaml")) ? members(path.join(sem, "model/db/deprecated/registry-deprecated.yaml"), "db.system") : new Map<string, string>();
  const dbAll = new Map([...oldDb, ...db]);
  const signals = (src: string): Array<{ kind: Kind; system: string }> => {
    const out = new Map<string, { kind: Kind; system: string }>();
    const add = (kind: Kind, system: string | undefined) => system && out.set(`${kind}:${system}`, { kind, system });
    for (const m of src.matchAll(/(?:DB_?SYSTEM(?:_NAME)?_?VALUES?_|DbSystemValues\.|DBSYSTEMVALUES_)([A-Z0-9_]+)/g)) add("database", dbAll.get(m[1]!));
    for (const m of src.matchAll(/(?:MESSAGING_?SYSTEM(?:_NAME)?_?VALUES?_|MessagingSystem(?:Name)?Values\.|MESSAGINGSYSTEMVALUES_)([A-Z0-9_]+)/g)) add("queue", mq.get(m[1]!));
    const key = (v: string) => v.replace(/[.-]/g, "_").toUpperCase();
    for (const m of src.matchAll(/(?:db\.system(?:\.name)?|DB_SYSTEM|_?DATABASE_SYSTEM|database_system)["'\]]*\s*[:=,]\s*["']([a-z0-9_.]+)["']/g)) add("database", dbAll.get(key(m[1]!)));
    for (const m of src.matchAll(/(?:messaging\.system|MESSAGING_SYSTEM)["'\]]*\s*[:=,]\s*["']([a-z0-9_.]+)["']/g)) add("queue", mq.get(key(m[1]!)));
    if (/aws\.s3\./.test(src)) add("object storage", "aws.s3");
    // An instrumentation that sets the system from the connection at run time (an ORM over any
    // engine) still marks a database; its system is unknown from the package alone.
    if (![...out.values()].some((x) => x.kind === "database") && /_set_db_system\(|ATTR_DB_SYSTEM|DB_SYSTEM\]/.test(src)) add("database", "?");
    return [...out.values()];
  };

  const out: Mapping[] = [];
  const js = path.join(env("OTEL_JS_CONTRIB"), "packages");
  for (const d of readdirSync(js).filter((d) => d.startsWith("instrumentation-"))) {
    const dir = path.join(js, d);
    const pkgs = new Set<string>();
    const tav = path.join(dir, ".tav.yml");
    if (existsSync(tav)) for (const m of readFileSync(tav, "utf8").matchAll(/^["']?([@a-z0-9][^"':\s]*)["']?:\s*$/gm)) pkgs.add(m[1]!);
    const src = files(path.join(dir, "src"), /\.ts$/).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const m of src.matchAll(/new InstrumentationNodeModuleDefinition\(\s*["']([^"']+)["']/g)) pkgs.add(m[1]!);
    const sys = signals(src);
    for (const pkg of pkgs) out.push({ ecosystem: "npm", pkg, instrumentation: d, systems: sys });
  }
  const py = path.join(env("OTEL_PY_CONTRIB"), "instrumentation");
  for (const d of readdirSync(py).filter((d) => d.startsWith("opentelemetry-instrumentation-"))) {
    const all = files(path.join(py, d, "src"), /\.py$/);
    const pkgFile = all.find((f) => f.endsWith("package.py"));
    if (!pkgFile) continue;
    const pkgs = new Set<string>();
    for (const block of readFileSync(pkgFile, "utf8").matchAll(/^_instruments\w*[^=\n]*=\s*(\([^)]*\)|["'][^"'\n]*["'])/gm))
      for (const m of block[1]!.matchAll(/["']([A-Za-z0-9_.\-]+)/g)) pkgs.add(m[1]!.toLowerCase());
    const sys = signals(all.map((f) => readFileSync(f, "utf8")).join("\n"));
    for (const pkg of pkgs) out.push({ ecosystem: "pypi", pkg, instrumentation: d, systems: sys });
  }
  return out;
}

if (import.meta.main) {
  const map = storeMap();
  for (const eco of ["npm", "pypi"] as const) {
    const rows = map.filter((m) => m.ecosystem === eco);
    const stores = rows.filter((m) => m.systems.length > 0);
    const kinds = (k: Kind) => stores.filter((m) => m.systems.some((s) => s.kind === k)).length;
    console.log(`${eco}: ${rows.length} packages instrumented, ${stores.length} map to a store (database ${kinds("database")}, queue ${kinds("queue")}, object storage ${kinds("object storage")})`);
    console.log(`  ${stores.map((m) => `${m.pkg}=${m.systems.map((s) => s.system).join("+")}`).join(" ")}`);
  }
  for (const p of process.argv.slice(2)) {
    const hits = map.filter((m) => m.pkg === p.toLowerCase() || m.pkg === p);
    console.log(`probe ${p}: ${hits.length ? hits.map((h) => `${h.ecosystem} via ${h.instrumentation} -> ${h.systems.map((s) => `${s.kind}:${s.system}`).join(", ") || "no store"}`).join("; ") : "not listed"}`);
  }
}
