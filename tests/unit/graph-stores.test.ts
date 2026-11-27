// The list of store packages (trustmybot/tmb#339) is generated, never written by hand: it joins the
// OpenTelemetry semantic conventions' store systems with the instrumentations that say which
// package reaches which system (CODE_GRAPH.md, "Data sources"). The fixtures are small source
// trees of their own, with names no real package has; each expectation is read off the rule.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { STORES_FILE, STORE_SOURCES, sourceFolders, storeLists, storesText } from "../../src/engine/graph/stores.gen.ts";

setDefaultTimeout(30_000);

let root: string;

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const SEMCONV = {
  db: [
    "groups:",
    "  - id: registry.db",
    "    attributes:",
    "      - id: db.system.name",
    "        type:",
    "          members:",
    "            - id: acmedb",
    "              value: \"acmedb\"",
    "            - id: zeta.sql",
    "              value: \"zeta.sql\"",
    "            - id: litefile",
    "              value: \"litefile\"",
    "      - id: db.client.state",
    "        type:",
    "          members:",
    "            - id: idle",
    "              value: \"idle\"",
    "",
  ].join("\n"),
  dbOld: [
    "groups:",
    "  - id: registry.db.deprecated",
    "    attributes:",
    "      - id: db.system",
    "        deprecated:",
    "          reason: renamed",
    "          renamed_to: db.system.name",
    "        type:",
    "          members:",
    "            - id: oldbase",
    "              value: \"oldbase\"",
    "",
  ].join("\n"),
  mq: [
    "groups:",
    "  - id: registry.messaging",
    "    attributes:",
    "      - id: messaging.system.name",
    "        type:",
    "          members:",
    "            - id: ripple",
    "              value: 'ripple'",
    "",
  ].join("\n"),
};

/** One JS instrumentation: the packages its tests run against and the source that sets the system. */
function jsInstrumentation(dir: string, name: string, tav: string[], src: string): void {
  const at = path.join(dir, "packages", `instrumentation-${name}`);
  write(path.join(at, ".tav.yml"), tav.map((p) => `"${p}":\n  versions: "*"\n`).join(""));
  write(path.join(at, "src", "instrumentation.ts"), src);
}

/** One Python instrumentation: its package.py and the source that sets the system. */
function pyInstrumentation(dir: string, name: string, packagePy: string, src: string): void {
  const at = path.join(dir, "instrumentation", `opentelemetry-instrumentation-${name}`, "src", "opentelemetry", "instrumentation", name.replace(/-/g, "_"));
  write(path.join(at, "package.py"), packagePy);
  write(path.join(at, "__init__.py"), src);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "tmb-stores-"));
  const sem = path.join(root, "semconv");
  write(path.join(sem, "model/db/registry.yaml"), SEMCONV.db);
  write(path.join(sem, "model/db/deprecated/registry-deprecated.yaml"), SEMCONV.dbOld);
  write(path.join(sem, "model/messaging/registry.yaml"), SEMCONV.mq);

  const js = path.join(root, "js");
  // One system, named by the conventions' generated constant.
  jsInstrumentation(js, "acme", ["acme-client"], "span.setAttribute(ATTR_DB_SYSTEM_NAME, DB_SYSTEM_NAME_VALUE_ACMEDB);\n");
  // A hook definition names a package the tests do not list.
  jsInstrumentation(js, "acme-pool", [], "new InstrumentationNodeModuleDefinition('acme-pool', ['*']);\nattrs[ATTR_DB_SYSTEM_NAME] = 'acmedb';\n");
  // A queue, by its literal value.
  jsInstrumentation(js, "ripplejs", ["ripplejs"], "attrs = { [ATTR_MESSAGING_SYSTEM]: 'ripple' };\n");
  // Several systems from one instrumentation: the package alone does not say which.
  jsInstrumentation(js, "cloudkit", ["@cloud/kit-files", "@cloud/kit-core"], "a[ATTR_DB_SYSTEM_NAME] = DB_SYSTEM_NAME_VALUE_ZETA_SQL;\nb[ATTR_MESSAGING_SYSTEM] = MESSAGING_SYSTEM_VALUE_RIPPLE;\n");
  // The system is read at run time, from the connection.
  jsInstrumentation(js, "anyorm", ["anyorm"], "attrs[ATTR_DB_SYSTEM_NAME] = connection.options.type;\n");
  // A system the conventions do not name, and an instrumentation of no store.
  jsInstrumentation(js, "sockets", ["socketry"], "attrs[ATTR_MESSAGING_SYSTEM] = 'socketry';\n");
  jsInstrumentation(js, "web", ["webby"], "span.setAttribute('http.method', 'GET');\n");
  // A system named only in a comment is not set.
  jsInstrumentation(js, "notes", ["notekeeper"], "// `messaging.system` could be 'ripple' here\nconst x = 1;\n");
  // A string equal to a system's value, but not written as a system, names no system.
  jsInstrumentation(js, "wire", ["wirefetch"], "const protocol = 'litefile';\nspan.setAttribute(ATTR_NETWORK_PROTOCOL_NAME, protocol);\n");
  // Another attribute named for a system, set at run time, is no store's.
  jsInstrumentation(js, "llm", ["llmkit"], "attrs[ATTR_GEN_AI_SYSTEM] = provider.name;\n");
  write(path.join(js, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/acme-client": { dependencies: { "acme-pool": "^1" } } } }));

  const py = path.join(root, "py");
  pyInstrumentation(py, "ripplepy", "_instruments = (\"Ripple_Py >= 1.0\",)\n", "attrs[SpanAttributes.MESSAGING_SYSTEM] = MessagingSystemValues.RIPPLE.value\n");
  // Required together: the instrumentation needs both, and the source does not say which it instruments.
  pyInstrumentation(py, "ormkit", "_instruments = (\"orm-kit >= 0.1\", \"schema-kit >= 1.0\")\n", "_set_db_system(attrs, DbSystemValues.LITEFILE.value, mode)\n");
  // Any one of several drivers: each alone lets it run.
  pyInstrumentation(py, "litedrv", "_instruments_a = \"lite-a ~= 1.0\"\n_instruments_b = \"lite-b ~= 1.0\"\n_instruments = ()\n_instruments_any = (_instruments_a, _instruments_b)\n", "_DATABASE_SYSTEM = \"litefile\"\n");
  // A deprecated value of the old system attribute still names a system.
  pyInstrumentation(py, "oldpy", "_instruments = (\"oldbase-client\",)\n", "_set_db_system(attrs, \"oldbase\", mode)\n");
  // Several systems; and a package that depends on it reaches them too.
  pyInstrumentation(py, "cloudcore", "_instruments_core = (\"cloud-core ~= 1.0\",)\n_instruments = ()\n_instruments_any = (*_instruments_core,)\n", "a[SpanAttributes.DB_SYSTEM] = DbSystemValues.ZETA_SQL.value\nb[SpanAttributes.MESSAGING_SYSTEM] = \"ripple\"\n");
  pyInstrumentation(py, "cloudqueue", "_instruments = (\"cloud-sdk ~= 1.0\",)\n", "attrs[SpanAttributes.MESSAGING_SYSTEM] = MessagingSystemNameValues.RIPPLE.value\n");
  // The system is read at run time.
  pyInstrumentation(py, "anydb", "_instruments = (\"anydb >= 1\",)\n", "_set_db_system(attrs, self.vendor, mode)\n");
  write(
    path.join(py, "uv.lock"),
    [
      "[[package]]",
      'name = "cloud-sdk"',
      'version = "1.0"',
      "dependencies = [",
      '    { name = "cloud-core" },',
      '    { name = "unrelated" },',
      "]",
      "",
      "[[package]]",
      'name = "cloud-core"',
      'version = "1.0"',
      "",
    ].join("\n"),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const lists = () => storeLists({ semconv: path.join(root, "semconv"), js: path.join(root, "js"), py: path.join(root, "py") });

describe("the store packages", () => {
  test("a package whose instrumentation sets one database system reaches that database", () => {
    const { npm } = lists();
    expect(npm.one.get("acme-client")).toEqual({ kind: "database", system: "acmedb" });
    expect(npm.one.get("acme-pool")).toEqual({ kind: "database", system: "acmedb" });
  });

  test("a messaging system is a queue", () => {
    const { npm, pypi } = lists();
    expect(npm.one.get("ripplejs")).toEqual({ kind: "queue", system: "ripple" });
    // A PyPI name is kept as the registry normalises it.
    expect(pypi.one.get("ripple-py")).toEqual({ kind: "queue", system: "ripple" });
  });

  test("a value of the deprecated system attribute still names its system", () => {
    expect(lists().pypi.one.get("oldbase-client")).toEqual({ kind: "database", system: "oldbase" });
  });

  test("an instrumentation that sets no system of the conventions gives no store package", () => {
    const { npm } = lists();
    for (const p of ["socketry", "webby", "notekeeper", "wirefetch", "llmkit"]) {
      expect(npm.one.has(p)).toBe(false);
      expect(npm.several.has(p)).toBe(false);
    }
  });

  test("a package that reaches several systems, or one read at run time, serves several stores", () => {
    const { npm, pypi } = lists();
    for (const p of ["@cloud/kit-files", "@cloud/kit-core", "anyorm"]) {
      expect(npm.one.has(p)).toBe(false);
      expect(npm.several.has(p)).toBe(true);
    }
    expect(pypi.several.has("cloud-core")).toBe(true);
    expect(pypi.several.has("anydb")).toBe(true);
  });

  test("a package reaches the stores of the listed packages it depends on, as the source's lock file says", () => {
    const { npm, pypi } = lists();
    // cloud-sdk's own instrumentation sets one queue, but it depends on cloud-core, which serves several.
    expect(pypi.one.has("cloud-sdk")).toBe(false);
    expect(pypi.several.has("cloud-sdk")).toBe(true);
    // A dependency on a package of the same one store changes nothing.
    expect(npm.one.get("acme-client")).toEqual({ kind: "database", system: "acmedb" });
    // A dependency the instrumentations do not list adds nothing.
    expect(pypi.one.has("unrelated")).toBe(false);
  });

  test("packages an instrumentation requires together are not listed: the source does not say which it instruments", () => {
    const { pypi } = lists();
    for (const p of ["orm-kit", "schema-kit"]) {
      expect(pypi.one.has(p)).toBe(false);
      expect(pypi.several.has(p)).toBe(false);
    }
  });

  test("each package of which any one lets the instrumentation run is listed", () => {
    const { pypi } = lists();
    expect(pypi.one.get("lite-a")).toEqual({ kind: "database", system: "litefile" });
    expect(pypi.one.get("lite-b")).toEqual({ kind: "database", system: "litefile" });
  });
});

describe("the generated file", () => {
  test("says it is generated and names each source with its commit", () => {
    const text = readFileSync(STORES_FILE, "utf8");
    expect(text).toContain("Generated by stores.gen.ts");
    expect(text).toContain("Do not edit");
    for (const s of STORE_SOURCES) {
      expect(text).toContain(s.url);
      expect(text).toContain(s.commit);
    }
  });

  const folders = sourceFolders();
  test.skipIf("skip" in folders)(`is what stores.gen.ts writes from the pinned sources${"skip" in folders ? ` (skipped: ${folders.skip})` : ""}`, () => {
    if ("error" in folders) throw new Error(folders.error);
    if ("skip" in folders) return;
    expect(readFileSync(STORES_FILE, "utf8")).toBe(storesText(storeLists(folders.folders)));
  });
});
