// Opens the project's database file, or refuses it with a named cause. The caller passes
// the path; the store never works out where the file lives.
import { Database, SQLiteError } from "bun:sqlite";
import { existsSync } from "node:fs";
import { runningProgram } from "../../program.ts";
import { version as tmbVersion } from "../../version.ts";
import { SCHEMA_STEPS, SCHEMA_VERSION } from "./schema.ts";
import { SHAPE_WRITER_KEY, type ShapeWriter, Store } from "./store.ts";

const BUSY_TIMEOUT_MS = 5000;

export type StoreOpenFailure = "missing" | "unreadable" | "newer";

export class StoreOpenError extends Error {
  override name = "StoreOpenError";
  constructor(
    readonly failure: StoreOpenFailure,
    message: string,
    /** For a newer database: the tmb that wrote its shape, when it says. */
    readonly writer: ShapeWriter | null = null,
  ) {
    super(message);
  }
}

/** The tmb that is running, as it signs a shape it writes. */
export function currentWriter(): ShapeWriter {
  return { version: tmbVersion, program: runningProgram(tmbVersion).name };
}

export type OpenResult = { ok: true; store: Store } | { ok: false; error: StoreOpenError };

function failed(failure: StoreOpenFailure, message: string, writer: ShapeWriter | null = null): OpenResult {
  return { ok: false, error: new StoreOpenError(failure, message, writer) };
}

/** The tmb a newer database names as the writer of its shape; null when it names none. */
function readShapeWriter(db: Database): ShapeWriter | null {
  try {
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(SHAPE_WRITER_KEY) as { value: string } | null;
    if (!row) return null;
    const writer = JSON.parse(row.value) as Partial<ShapeWriter>;
    return typeof writer.version === "string" && typeof writer.program === "string" ? { version: writer.version, program: writer.program } : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the schema version and whether the file holds any table, the first reads that fail on a non-database file. */
function readHeader(db: Database): { version: number; tables: number } {
  const { user_version: version } = db.query("PRAGMA user_version").get() as { user_version: number };
  const { tables } = db.query("SELECT count(*) AS tables FROM sqlite_master").get() as { tables: number };
  return { version, tables };
}

function isBusy(error: unknown): boolean {
  return error instanceof SQLiteError && (error.code === "SQLITE_BUSY" || error.code?.startsWith("SQLITE_BUSY_") === true);
}

/**
 * Puts the database in WAL mode. The switch needs the file to itself, and SQLite answers
 * busy at once, without waiting, when another process opening the same new file holds it
 * too. So it is tried again until the busy timeout runs out. A database already in WAL
 * mode needs no switch and answers at once.
 */
function useWal(db: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.run("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      Bun.sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
}

/**
 * Runs every schema step the database still lacks in one transaction, so it is never left
 * between versions. The version is read again under the write lock: another process may
 * have upgraded the file since it was first read.
 */
function upgrade(db: Database, writer: ShapeWriter): void {
  db.transaction(() => {
    const { user_version: from } = db.query("PRAGMA user_version").get() as { user_version: number };
    if (from >= SCHEMA_VERSION) return;
    for (const step of SCHEMA_STEPS.slice(from)) db.run(step);
    // The shape is signed by the tmb that wrote it, so an older one that meets it can say which.
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(SHAPE_WRITER_KEY, JSON.stringify({ ...writer, shape: SCHEMA_VERSION }));
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}

/**
 * Opens the trajectory database at `dbPath`. With `create`, a missing file is made and
 * given the current schema; a database an older tmb made is upgraded. Refuses a missing file without `create`, a file that is not
 * a readable tmb database, and a database made by a newer tmb, naming the tmb that wrote it.
 * `writer` signs a shape this open writes; the running tmb unless given.
 */
export function openStore(dbPath: string, options: { create: boolean; writer?: ShapeWriter }): OpenResult {
  if (!existsSync(dbPath) && !options.create) return failed("missing", `no tmb database at ${dbPath}`);

  let db: Database;
  try {
    db = new Database(dbPath, { create: options.create, readwrite: true, strict: true });
  } catch (error) {
    return failed("unreadable", `cannot open ${dbPath}: ${describe(error)}`);
  }

  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    let header: { version: number; tables: number };
    try {
      header = readHeader(db);
    } catch (error) {
      db.close();
      return failed("unreadable", `${dbPath} is not a readable SQLite database: ${describe(error)}`);
    }

    if (header.version > SCHEMA_VERSION) {
      const writer = readShapeWriter(db);
      db.close();
      const by = writer === null ? "made by a newer tmb" : `made by a newer tmb (${writer.program} ${writer.version} wrote it)`;
      const remedy = writer === null ? "" : `; run ${writer.program} in this project, or a tmb at least as new as ${writer.version}`;
      return failed(
        "newer",
        `${dbPath} has schema version ${header.version}, ${by}; this tmb (${tmbVersion}) reads up to version ${SCHEMA_VERSION}${remedy}`,
        writer,
      );
    }
    if (header.version === 0 && header.tables > 0) {
      db.close();
      return failed("unreadable", `${dbPath} is a SQLite database but not a tmb one: it has tables and no schema version`);
    }
    if (header.version === 0 && !options.create) {
      db.close();
      return failed("missing", `${dbPath} is empty: no tmb database has been set up in it`);
    }

    useWal(db);
    db.run("PRAGMA foreign_keys = ON");
    if (header.version < SCHEMA_VERSION) upgrade(db, options.writer ?? currentWriter());
    return { ok: true, store: new Store(db) };
  } catch (error) {
    db.close();
    return failed("unreadable", `cannot use ${dbPath}: ${describe(error)}`);
  }
}
