// Research harness for trustmybot/tmb#339, not product code: each SQL parser candidate, and
// today's patterns, as one function from SQL text to the tables it names, each with what the
// statement does to it: "define" (CREATE TABLE or VIEW), "read", "write", or "trigger" (the table
// a trigger fires on). Each candidate's own answer is read as it gives it; where a parser returns
// only a syntax tree, the walker below maps the tree's statement fields to those four, and that
// mapping is part of what tmb would have to write for it.
//
// The candidates are installed outside the repo: CANDIDATES_DIR names a folder whose node_modules
// holds them (see README.md in this folder), and SQLGLOT_PYTHON a Python that has sqlglot.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { Collector } from "../../../../src/engine/graph/languages/contract.ts";
import { extractSqlDdl, sqlRefs } from "../../../../src/engine/graph/languages/sql/index.ts";
import { isHole, type Unit } from "./strings.ts";

export type Op = "define" | "read" | "write" | "trigger";
/** Internal: a FROM table of a DELETE that names its targets by alias; written when an alias names it, else read. */
type WalkOp = Op | "from-target";
export type Answer = { ok: boolean; refs: string[]; error?: string; qualified?: string[] };
export type Dialect = "sqlite" | "postgres" | "mysql" | "bigquery" | "snowflake" | "tsql";
export type Candidate = {
  name: string;
  /** The dialects the candidate names itself; any other is read as `fallback`. */
  dialects: Partial<Record<Dialect, string>>;
  fallback: string;
  run(sql: string, dialect: string): Promise<Answer>;
};

const CANDIDATES_DIR = process.env.CANDIDATES_DIR ?? "/private/tmp/claude-501/tt/w339r/cand";
const requireCandidate = createRequire(path.join(CANDIDATES_DIR, "package.json"));
const modulePath = (spec: string): string => path.join(CANDIDATES_DIR, "node_modules", spec);

/** A table's name as a node would hold it: its last part, unquoted, case folded; a hole is "?". */
export function tableName(raw: string): string {
  const parts = splitQualified(raw.trim());
  const last = parts[parts.length - 1] ?? raw;
  return isHole(last) ? "?" : last.toLowerCase();
}
function splitQualified(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  const close: Record<string, string> = { '"': '"', "`": "`", "[": "]" };
  for (const ch of raw) {
    if (quote) {
      if (ch === close[quote]) quote = null;
      else cur += ch;
    } else if (ch in close) quote = ch;
    else if (ch === ".") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  // A whole quoted path, `proj.dataset.table` in one pair of backticks, is a dotted name too.
  return out.flatMap((p) => (raw.startsWith("`") && out.length === 1 ? p.split(".") : [p]));
}
const ref = (op: Op, raw: string): string => `${op}:${tableName(raw)}`;

function answer(refs: Iterable<string>, qualified: Iterable<string> = []): Answer {
  return { ok: true, refs: [...new Set(refs)].sort(), qualified: [...new Set(qualified)].sort() };
}
const failed = (e: unknown): Answer => ({ ok: false, refs: [], error: String((e as Error)?.message ?? e).slice(0, 200) });

// ---------------------------------------------------------------------------------------------
// Today's patterns, from src/engine/graph/languages/sql/index.ts, called as the graph calls them.

/** What the graph does today for a unit: a .sql file gets extractSqlDdl only; a TypeScript or bash string gets sqlRefs, and extractSqlDdl when it holds CREATE TABLE; a Python string gets nothing. */
export function today(unit: Pick<Unit, "from" | "sql">, everywhere = false): Answer {
  const out: string[] = [];
  const add = (c: Collector): void => {
    for (const s of c.symbols) if (s.kind === "sql_table") out.push(ref("define", s.qualified_name));
    for (const e of c.edges) {
      if (e.kind === "reads_table") out.push(ref("read", e.dst_name));
      else if (e.kind === "writes_table" || e.kind === "indexes") out.push(ref("write", e.dst_name));
      else if (e.kind === "triggers_on") out.push(ref("trigger", e.dst_name));
    }
  };
  const lang = everywhere && unit.from === "python" ? "typescript" : unit.from;
  if (lang === "file") {
    const c = new Collector();
    extractSqlDdl(unit.sql, c, 0);
    add(c);
  } else if (lang === "typescript" || lang === "bash") {
    for (const [kind, table] of sqlRefs(unit.sql)) out.push(ref(kind === "reads_table" ? "read" : "write", table));
    if (/CREATE\s+(VIRTUAL\s+)?TABLE/i.test(unit.sql)) {
      const c = new Collector();
      extractSqlDdl(unit.sql, c, null);
      add(c);
    }
  }
  return answer(out);
}

// ---------------------------------------------------------------------------------------------
// node-sql-parser: tableList gives "op::db::table" for every table a statement names.

const NSP_OP: Record<string, Op> = { select: "read", insert: "write", update: "write", delete: "write", replace: "write", alter: "write", drop: "write", truncate: "write", create: "define" };
let nsp: { tableList(sql: string, opt: object): string[] } | null = null;
export const nodeSqlParser: Candidate = {
  name: "node-sql-parser",
  dialects: { sqlite: "Sqlite", postgres: "PostgresQL", mysql: "MySQL", bigquery: "BigQuery", snowflake: "Snowflake", tsql: "TransactSQL" },
  fallback: "Sqlite",
  async run(sql, dialect) {
    try {
      if (!nsp) nsp = new (requireCandidate("node-sql-parser").Parser)();
      const list = nsp!.tableList(sql, { database: dialect });
      const refs: string[] = [];
      const qualified: string[] = [];
      for (const item of list) {
        const [op, db, table] = item.split("::") as [string, string, string];
        refs.push(`${NSP_OP[op.toLowerCase()] ?? `other-${op}`}:${tableName(table)}`);
        if (db !== "null") qualified.push(`${db}.${table}`);
      }
      return answer(refs, qualified);
    } catch (e) {
      return failed(e);
    }
  },
};

// ---------------------------------------------------------------------------------------------
// A walker shared by the parsers that return a JSON tree: each table reference is found by the
// parser's own node shape, and its role by the field path from the nearest statement node.

type Rules = {
  /** The statement node's key, when `node` is a statement (an object keyed by its kind). */
  statement(node: Record<string, unknown>): string | null;
  /** The name a node refers to as a table, or null. */
  table(node: Record<string, unknown>, path: string[]): string | null;
  /** The role of a table at `path` (keys from the statement node, array indices dropped). */
  role(path: string, stmt: Record<string, unknown>): WalkOp;
  /** A table the store links to another (a foreign key's REFERENCES): inside the store, no link. */
  inStore?(path: string): boolean;
  /** The CTE names a statement node binds. */
  ctes(node: Record<string, unknown>): string[];
  /** Aliases a statement node gives its own target, alias → name. */
  stmtAliases?(node: Record<string, unknown>): Array<[string, string]>;
  /** Aliases a table node gives, alias → name. */
  alias?(node: Record<string, unknown>): [string, string] | null;
};

function walkTree(root: unknown, rules: Rules): Answer {
  const found: Array<{ op: WalkOp; name: string }> = [];
  const ctes = new Set<string>();
  const aliases = new Map<string, string>();
  const visit = (node: unknown, rel: string[], stmt: Record<string, unknown> | null): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n, rel, stmt);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const kind = rules.statement(obj);
    if (kind !== null) {
      for (const c of rules.ctes(obj)) ctes.add(c.toLowerCase());
      for (const [al, n] of rules.stmtAliases?.(obj) ?? []) aliases.set(al.toLowerCase(), n);
      for (const [k, v] of Object.entries(obj)) visit(v, [k], obj);
      return;
    }
    const name = rules.table(obj, rel);
    if (name !== null && stmt && !rules.inStore?.(rel.join("."))) {
      found.push({ op: rules.role(rel.join("."), stmt), name });
      const a = rules.alias?.(obj);
      if (a) aliases.set(a[0].toLowerCase(), a[1]);
    }
    for (const [k, v] of Object.entries(obj)) visit(v, [...rel, k], stmt);
  };
  visit(root, [], null);
  const refs: string[] = [];
  const qualified: string[] = [];
  for (const { op, name } of found) {
    let n = name;
    if (op !== "read" && op !== "from-target" && aliases.has(tableName(n))) n = aliases.get(tableName(n))!;
    if (ctes.has(tableName(n)) && !n.includes(".")) continue;
    refs.push(`${op}:${tableName(n)}`);
    if (splitQualified(n).length > 1) qualified.push(n);
  }
  return answer(refs, qualified);
}

/** A multi-table DELETE's FROM table is its target when an alias in the target list names it, else it is read. */
function resolveFromTargets(refs: string[]): string[] {
  const writes = new Set(refs.filter((r) => r.startsWith("write:")).map((r) => r.slice("write:".length)));
  return refs.map((r) => (r.startsWith("from-target:") ? (writes.has(r.slice("from-target:".length)) ? `write:${r.slice("from-target:".length)}` : `read:${r.slice("from-target:".length)}`) : r));
}

// sqlparser-rs (datafusion-sqlparser-rs), through @guanmingchiu/sqlparser-ts's wasm build.
const identParts = (v: unknown): string | null =>
  Array.isArray(v) && v.length > 0 && v.every((e) => e && typeof e === "object" && "Identifier" in e)
    ? v.map((e) => (e as { Identifier: { value: string } }).Identifier.value).join(".")
    : null;
const SQLPARSER_STATEMENTS = new Set(["Query", "Insert", "Update", "Delete", "Merge", "CreateTable", "CreateView", "CreateIndex", "AlterTable", "Drop", "Truncate", "CreateTrigger", "CopyIntoSnowflake"]);
const sqlparserRules: Rules = {
  statement: (n) => {
    const keys = Object.keys(n);
    return keys.length === 1 && SQLPARSER_STATEMENTS.has(keys[0]!) ? keys[0]! : null;
  },
  table(n, rel) {
    // A table factor: `Table` with a name and no arguments (with arguments it is a table function).
    if ("name" in n && "args" in n && "alias" in n) return n.args ? null : identParts(n.name);
    if ("TableName" in n && rel[0] === "Insert") return identParts(n.TableName);
    for (const [k, v] of Object.entries(n)) {
      const names = identParts(v);
      if (names === null) continue;
      if (rel.length === 1 && rel[0] === "CreateTable" && k === "name") return names;
      if (rel.length === 1 && rel[0] === "CreateView" && k === "name") return names;
      if (rel.length === 1 && rel[0] === "CreateIndex" && k === "table_name") return names;
      if (rel.length === 1 && rel[0] === "AlterTable" && k === "name") return names;
      if (rel.length === 1 && rel[0] === "CreateTrigger" && k === "table_name") return names;
      if (rel.length === 1 && rel[0] === "CopyIntoSnowflake" && k === "into") return names;
    }
    return null;
  },
  role(p, stmt) {
    if (/^Insert\.table/.test(p) || /^Update\.table\.relation/.test(p) || /^Merge\.table/.test(p) || /^Truncate/.test(p)) return "write";
    if (/^Delete\.from\.\w+\.relation/.test(p)) return ((stmt.Delete as { tables?: unknown[] })?.tables?.length ?? 0) > 0 ? "from-target" : "write";
    if (/^(CreateIndex|AlterTable|CopyIntoSnowflake|Drop)$/.test(p)) return "write";
    if (/^(CreateTable|CreateView)$/.test(p)) return "define";
    if (p === "CreateTrigger") return "trigger";
    return "read";
  },
  ctes: (n) => {
    const q = n.Query as { with?: { cte_tables?: Array<{ alias: { name: { value: string } } }> } } | undefined;
    return q?.with?.cte_tables?.map((c) => c.alias.name.value) ?? [];
  },
  alias: (n) => {
    const a = (n.alias as { name?: { value?: string } } | null)?.name?.value;
    const name = identParts(n.name);
    return a && name ? [a, name] : null;
  },
};
/** sqlparser-rs gives DROP's and DELETE's multi-table names as plain lists; read them from the statement. */
function sqlparserExtra(ast: unknown[]): string[] {
  const out: string[] = [];
  for (const s of ast as Array<Record<string, Record<string, unknown>>>) {
    if (s.Drop && String(s.Drop.object_type) === "Table") for (const n of (s.Drop.names as unknown[]) ?? []) out.push(ref("write", identParts(n) ?? ""));
    if (s.Truncate) for (const t of (s.Truncate.table_names as Array<{ name: unknown }>) ?? []) out.push(ref("write", identParts(t.name) ?? ""));
    if (s.Delete) for (const t of (s.Delete.tables as unknown[]) ?? []) out.push(`write-alias:${identParts(t) ?? ""}`);
  }
  return out;
}
let sqlparserTs: { init?(): Promise<void>; parse(sql: string, dialect: string): unknown[] } | null = null;
export const sqlparserRs: Candidate = {
  name: "sqlparser-rs (wasm)",
  dialects: { sqlite: "sqlite", postgres: "postgresql", mysql: "mysql", bigquery: "bigquery", snowflake: "snowflake", tsql: "mssql" },
  fallback: "generic",
  async run(sql, dialect) {
    try {
      if (!sqlparserTs) {
        sqlparserTs = await import(modulePath("@guanmingchiu/sqlparser-ts/dist/index.mjs"));
        await sqlparserTs!.init?.();
      }
      const ast = sqlparserTs!.parse(sql, dialect);
      const a = walkTree(ast, sqlparserRules);
      const extra = sqlparserExtra(ast);
      // A multi-table DELETE names its targets by alias: each is the table that alias names.
      const aliasRefs = extra.filter((r) => r.startsWith("write-alias:")).map((r) => r.slice("write-alias:".length));
      const aliasMap = new Map<string, string>();
      const collect = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(collect);
        if (!n || typeof n !== "object") return;
        const al = sqlparserRules.alias!(n as Record<string, unknown>);
        if (al) aliasMap.set(al[0].toLowerCase(), al[1]);
        for (const v of Object.values(n)) collect(v);
      };
      if (aliasRefs.length) collect(ast);
      const refs = [...a.refs.filter((r) => !r.startsWith("from-target:")), ...extra.filter((r) => !r.startsWith("write-alias:")), ...aliasRefs.map((al) => ref("write", aliasMap.get(al.toLowerCase()) ?? al))];
      const fromTargets = a.refs.filter((r) => r.startsWith("from-target:"));
      return answer(resolveFromTargets([...refs, ...fromTargets]), a.qualified);
    } catch (e) {
      return failed(e);
    }
  },
};

// polyglot-sql: a Rust port of sqlglot, compiled to wasm.
const POLYGLOT_STATEMENTS = new Set(["select", "union", "intersect", "except", "insert", "update", "delete", "merge", "copy", "create_table", "create_view", "create_index", "alter_table", "drop_table", "truncate", "create_trigger"]);
const polyglotRules: Rules = {
  statement: (n) => {
    const keys = Object.keys(n);
    return keys.length === 1 && POLYGLOT_STATEMENTS.has(keys[0]!) ? keys[0]! : null;
  },
  table(n) {
    const nm = n.name as { name?: unknown } | null;
    if (!nm || typeof nm !== "object" || typeof nm.name !== "string" || !("schema" in n)) return null;
    const part = (k: string): string | null => {
      const v = n[k] as { name?: string; quoted?: boolean } | null;
      return v?.name ? (v.quoted ? `"${v.name}"` : v.name) : null;
    };
    const quoted = (nm as { quoted?: boolean }).quoted ? `"${nm.name}"` : (nm.name as string);
    return [part("catalog"), part("schema"), quoted].filter(Boolean).join(".");
  },
  role(p, stmt) {
    if (/^(insert\.table|update\.table|delete\.table|delete\.tables|truncate\.table|create_index\.table|alter_table\.name|drop_table\.names|(merge|copy)\.this(\.(alias|this|table))*)$/.test(p)) {
      if (p === "delete.table" && ((stmt.delete as { tables?: unknown[] })?.tables?.length ?? 0) > 0) return "from-target";
      return "write";
    }
    if (/^(create_table|create_view)\.name$/.test(p)) return "define";
    if (p === "create_trigger.table") return "trigger";
    return "read";
  },
  inStore: (p) => /(^|\.)(References|references|ForeignKey)(\.|$)/.test(p),
  ctes(n) {
    const body = Object.values(n)[0] as { with?: { ctes?: Array<{ alias?: { name?: string } }> } } | null;
    return body?.with?.ctes?.map((c) => c.alias?.name ?? "").filter(Boolean) ?? [];
  },
  alias(n) {
    const a = (n.alias as { name?: string } | null)?.name;
    const nm = (n.name as { name?: string } | null)?.name;
    return a && nm ? [a, nm] : null;
  },
  stmtAliases(n) {
    const body = Object.values(n)[0] as { alias?: { name?: string }; table?: { name?: { name?: string } } } | null;
    return body?.alias?.name && body.table?.name?.name ? [[body.alias.name, body.table.name.name]] : [];
  },
};
let polyglot: { init?(): Promise<void>; parse(sql: string, dialect: string): { success: boolean; ast?: unknown; error?: string } } | null = null;
export const polyglotSql: Candidate = {
  name: "polyglot-sql",
  dialects: { sqlite: "sqlite", postgres: "postgresql", mysql: "mysql", bigquery: "bigquery", snowflake: "snowflake", tsql: "tsql" },
  fallback: "generic",
  async run(sql, dialect) {
    try {
      if (!polyglot) {
        polyglot = await import(modulePath("@polyglot-sql/sdk/dist/index.node.js"));
        await polyglot!.init?.();
      }
      const r = polyglot!.parse(sql, dialect);
      if (!r.success) return failed(r.error);
      const a = walkTree(r.ast, polyglotRules);
      return { ...a, refs: [...new Set(resolveFromTargets(a.refs))].sort() };
    } catch (e) {
      return failed(e);
    }
  },
};

// libpg_query, PostgreSQL's own parser, through libpg-query's wasm build. PostgreSQL only.
const PG_STATEMENTS = new Set(["SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt", "CreateStmt", "ViewStmt", "CreateTableAsStmt", "IndexStmt", "AlterTableStmt", "DropStmt", "TruncateStmt", "CreateTrigStmt", "CopyStmt"]);
const pgRules: Rules = {
  statement: (n) => {
    const keys = Object.keys(n);
    return keys.length === 1 && PG_STATEMENTS.has(keys[0]!) ? keys[0]! : null;
  },
  table(n) {
    if (typeof n.relname !== "string") return null;
    return [n.catalogname, n.schemaname, n.relname].filter((x) => typeof x === "string").join(".");
  },
  role(p) {
    if (/^(InsertStmt|UpdateStmt|DeleteStmt|MergeStmt|IndexStmt|AlterTableStmt|TruncateStmt)\.relations?$/.test(p)) return "write";
    if (/^CopyStmt\.relation$/.test(p)) return "write";
    if (/^(CreateStmt\.relation|ViewStmt\.view|CreateTableAsStmt\.into\.rel)$/.test(p)) return "define";
    if (p === "CreateTrigStmt.relation") return "trigger";
    return "read";
  },
  inStore: (p) => /(^|\.)pktable$/.test(p),
  ctes(n) {
    const body = Object.values(n)[0] as { withClause?: { ctes?: Array<{ CommonTableExpr: { ctename: string } }> } } | null;
    return body?.withClause?.ctes?.map((c) => c.CommonTableExpr.ctename) ?? [];
  },
  alias(n) {
    const a = (n.alias as { aliasname?: string } | null)?.aliasname;
    return a && typeof n.relname === "string" ? [a, n.relname] : null;
  },
};
function pgDrops(ast: { stmts?: Array<{ stmt: Record<string, Record<string, unknown>> }> }): string[] {
  const out: string[] = [];
  for (const { stmt } of ast.stmts ?? []) {
    const d = stmt.DropStmt;
    if (!d || d.removeType !== "OBJECT_TABLE") continue;
    for (const o of (d.objects as Array<{ List: { items: Array<{ String: { sval: string } }> } }>) ?? []) {
      out.push(ref("write", o.List.items.map((i) => i.String.sval).join(".")));
    }
  }
  return out;
}
let pg: { parse(sql: string): Promise<unknown>; loadModule?(): Promise<void> } | null = null;
export const libpgQuery: Candidate = {
  name: "libpg-query (wasm)",
  dialects: { postgres: "postgres" },
  fallback: "postgres",
  async run(sql) {
    try {
      if (!pg) {
        pg = await import(modulePath("libpg-query/wasm/index.js"));
        await pg!.loadModule?.();
      }
      const ast = (await pg!.parse(sql)) as { stmts?: Array<{ stmt: Record<string, Record<string, unknown>> }> };
      const a = walkTree(ast.stmts?.map((s) => s.stmt) ?? [], pgRules);
      return answer(resolveFromTargets([...a.refs, ...pgDrops(ast)]), a.qualified);
    } catch (e) {
      return failed(e);
    }
  },
};

// tree-sitter-sql (DerekStride), a tree-sitter grammar, run on the tree-sitter runtime tmb carries.
// The grammar gives a syntax tree with error recovery; the roles come from the node types.
import type { Node, Parser as TsParser } from "web-tree-sitter";
let tsSql: TsParser | null = null;
const TREE_SITTER_SQL_WASM = process.env.TREE_SITTER_SQL_WASM ?? path.join(CANDIDATES_DIR, "tree-sitter-sql.wasm");
export const treeSitterSql: Candidate = {
  name: "tree-sitter-sql",
  dialects: {},
  fallback: "any",
  async run(sql) {
    try {
      if (!tsSql) {
        const { Parser, Language } = await import("web-tree-sitter");
        await Parser.init();
        tsSql = new Parser();
        tsSql.setLanguage(await Language.load(new Uint8Array(await Bun.file(TREE_SITTER_SQL_WASM).arrayBuffer())));
      }
      const tree = tsSql!.parse(sql);
      if (!tree) return failed("no tree");
      const refs: string[] = [];
      const qualified: string[] = [];
      const ctes = new Set<string>();
      const aliases = new Map<string, string>();
      for (const c of tree.rootNode.descendantsOfType("cte")) {
        const id = c?.namedChildren.find((x) => x?.type === "identifier");
        if (id) ctes.add(tableName(id.text));
      }
      for (const r of tree.rootNode.descendantsOfType("relation")) {
        const o = r?.namedChildren.find((x) => x?.type === "object_reference");
        const al = r?.namedChildren.find((x) => x?.type === "identifier");
        if (o && al) aliases.set(al.text.toLowerCase(), o.text);
      }
      const hasError = tree.rootNode.hasError;
      for (const o of tree.rootNode.descendantsOfType("object_reference")) {
        if (!o) continue;
        const op = treeSitterRole(o);
        if (op === null) continue;
        let n = o.text;
        if (op === "write" && aliases.has(n.toLowerCase())) n = aliases.get(n.toLowerCase())!;
        if (op === "read" && ctes.has(tableName(n))) continue;
        refs.push(`${op}:${tableName(n)}`);
        if (splitQualified(n).length > 1) qualified.push(n);
      }
      tree.delete();
      const a = answer(refs, qualified);
      return hasError ? { ...a, ok: false, error: "tree has errors (refs from error recovery)" } : a;
    } catch (e) {
      return failed(e);
    }
  },
};
function prevKeyword(o: Node): string | null {
  let s = o.previousSibling;
  while (s && !s.type.startsWith("keyword_")) s = s.previousSibling;
  return s?.type ?? null;
}
function treeSitterRole(o: Node): Op | null {
  const p = o.parent;
  if (!p) return null;
  switch (p.type) {
    case "relation":
      // `UPDATE t …`: the relation directly under `update`, before SET, is the target.
      return p.parent?.type === "update" && prevKeyword(p) === "keyword_update" ? "write" : "read";
    case "create_table":
    case "create_view":
    case "create_materialized_view":
      return prevKeyword(o) === "keyword_as" ? "read" : "define";
    case "insert":
    case "alter_table":
    case "drop_table":
      return "write";
    case "create_index":
      return prevKeyword(o) === "keyword_on" ? "write" : null;
    case "create_trigger":
      return prevKeyword(o) === "keyword_on" ? "trigger" : null;
    case "from":
      // `DELETE FROM t`: the name directly under `from`, not in a relation, is the target.
      return p.parent?.namedChildren.some((c) => c?.type === "delete") ? "write" : "read";
    case "statement":
      return prevKeyword(o) === "keyword_truncate" || prevKeyword(o) === "keyword_table" ? "write" : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// sqlglot, Python's reference SQL parser. Not carriable in a Bun binary; read as a second judge.

export const sqlglot = {
  name: "sqlglot (Python, judge)",
  dialects: { sqlite: "sqlite", postgres: "postgres", mysql: "mysql", bigquery: "bigquery", snowflake: "snowflake", tsql: "tsql" } as Partial<Record<Dialect, string>>,
  fallback: "sqlite",
  /** Runs many at once: one Python process for the batch. */
  batch(items: Array<{ sql: string; dialect: string }>): Answer[] {
    const py = process.env.SQLGLOT_PYTHON ?? "/private/tmp/claude-501/tt/w339r/py/bin/python";
    const r = spawnSync(py, ["-I", path.join(import.meta.dir, "sqlglot_tables.py")], { input: items.map((i) => JSON.stringify(i)).join("\n"), maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`sqlglot: ${r.stderr}`);
    return r.stdout
      .toString()
      .trim()
      .split("\n")
      .map((l) => {
        const a = JSON.parse(l) as Answer;
        return a.ok ? answer(a.refs.map((x) => `${x.slice(0, x.indexOf(":"))}:${tableName(x.slice(x.indexOf(":") + 1))}`), a.qualified) : a;
      });
  },
};

export const CANDIDATES: Candidate[] = [nodeSqlParser, sqlparserRs, polyglotSql, libpgQuery, treeSitterSql];

/** The candidate's own name for a dialect. */
export const dialectFor = (c: { dialects: Partial<Record<Dialect, string>>; fallback: string }, d: string): string => c.dialects[d as Dialect] ?? c.fallback;
