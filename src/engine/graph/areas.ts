// Areas: the logical parts of a project, such as login, billing or the dashboard
// (trustmybot/tmb#146). An area is a named group of files, by path patterns to include and to
// leave out; only the planner writes one. "tests" exists from the start and holds every file the
// test rule matches. Like concepts, areas are not derived from git: a rebuild keeps them and
// re-checks each one. An area that matches no file is marked broken; one whose size moved by more
// than a quarter since it was written is marked for the planner to look at.
import type { Database } from "bun:sqlite";
import { newId } from "../ids.ts";
import type { Actor } from "../store/index.ts";
import { BASE_LAYER, ensureTestsArea, TESTS_AREA } from "./db.ts";
import { isTestPath } from "./test-paths.ts";

export { TESTS_AREA };

export type AreaStatus = "ok" | "broken" | "review";

export type Area = {
  id: string;
  name: string;
  purpose: string;
  parent: string | null;
  include: string[];
  exclude: string[];
  builtin: boolean;
  status: AreaStatus;
  statusReason: string | null;
  /** How many files of the base branch it holds now. */
  files: number;
  /** How many it held when it was last written; a move of more than a quarter marks it for review. */
  filesWhenWritten: number;
  checkedSha: string | null;
  updatedAt: string;
};

type AreaRow = {
  id: string;
  name: string;
  purpose: string;
  parent_id: string | null;
  include: string;
  exclude: string;
  builtin: number;
  status: AreaStatus;
  status_reason: string | null;
  file_count: number;
  written_count: number;
  checked_sha: string | null;
  updated_at: string;
};

/** A glob over repo paths: `**` crosses folders, `*` and `?` stay within one. */
export function globMatcher(pattern: string): (path: string) => boolean {
  const clean = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c === "*" && clean[i + 1] === "*") {
      // `**/` matches no folder too; a trailing `**` matches everything below.
      if (clean[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern that names a folder holds everything in it.
  const regex = new RegExp(`^${re}(?:/.*)?$`);
  return (path) => regex.test(path);
}

function load(db: Database, row: AreaRow): Area {
  const parent = row.parent_id === null ? null : (db.query("SELECT name FROM areas WHERE id = ?").get(row.parent_id) as { name: string } | null)?.name ?? null;
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    parent,
    include: JSON.parse(row.include) as string[],
    exclude: JSON.parse(row.exclude) as string[],
    builtin: row.builtin === 1,
    status: row.status,
    statusReason: row.status_reason,
    files: row.file_count,
    filesWhenWritten: row.written_count,
    checkedSha: row.checked_sha,
    updatedAt: row.updated_at,
  };
}

/** The files of a layer an area's rule holds: for "tests" the test rule plus its own patterns. */
function membersOf(area: Pick<Area, "include" | "exclude" | "builtin">, files: readonly string[]): string[] {
  const include = area.include.map(globMatcher);
  const exclude = area.exclude.map(globMatcher);
  return files.filter((file) => (area.builtin && isTestPath(file)) || include.some((m) => m(file))).filter((file) => !exclude.some((m) => m(file)));
}

function layerFiles(db: Database, layer: string): string[] {
  return (db.query("SELECT path FROM files WHERE layer = ? ORDER BY path").all(layer) as { path: string }[]).map((row) => row.path);
}

function rows(db: Database): AreaRow[] {
  return db.query("SELECT * FROM areas ORDER BY builtin DESC, name").all() as AreaRow[];
}

export function listAreas(db: Database): Area[] {
  return rows(db).map((row) => load(db, row));
}

export function getArea(db: Database, idOrName: string): Area | null {
  const row = db.query("SELECT * FROM areas WHERE id = ? OR name = ?").get(idOrName, idOrName) as AreaRow | null;
  return row === null ? null : load(db, row);
}

/** Why an area cannot be written as asked, or null when it can. */
export type AreaRefusal = { reason: string };

/**
 * Writes an area, replacing the one of the same name. Each include pattern must match a file of
 * the base branch, the parent must exist and be top-level, and "tests" keeps its built-in rule.
 */
export function upsertArea(
  db: Database,
  actor: Actor,
  input: { name: string; purpose: string; include: string[]; exclude: string[]; parent?: string },
  commit: string,
): { area: Area } | AreaRefusal {
  ensureTestsArea(db);
  const files = layerFiles(db, BASE_LAYER);
  const existing = getArea(db, input.name);
  const builtin = existing?.builtin === true;
  if (!builtin && input.include.length === 0) return { reason: `the area ${input.name} needs at least one pattern to include` };
  const empty = input.include.filter((pattern) => !files.some(globMatcher(pattern)));
  if (empty.length > 0) return { reason: `these patterns match no file of the base branch: ${empty.join(", ")}` };
  let parentId: string | null = null;
  if (input.parent !== undefined) {
    if (builtin) return { reason: `the area ${TESTS_AREA} is built in and has no parent` };
    const parent = getArea(db, input.parent);
    if (parent === null) return { reason: `no area ${input.parent} to nest under; write it first` };
    if (parent.name === input.name) return { reason: "an area cannot be its own parent" };
    if (parent.parent !== null) return { reason: `the area ${parent.name} is nested in ${parent.parent} already; areas nest one level deep` };
    parentId = parent.id;
  }
  if (existing !== null && parentId !== null) {
    const children = db.query("SELECT name FROM areas WHERE parent_id = ?").all(existing.id) as { name: string }[];
    if (children.length > 0) return { reason: `the area ${input.name} has areas nested in it (${children.map((c) => c.name).join(", ")}), so it cannot be nested itself` };
  }
  const count = membersOf({ include: input.include, exclude: input.exclude, builtin }, files).length;
  if (count === 0) return { reason: `the area ${input.name} would hold no file: its exclude patterns leave out every file it includes` };
  const now = new Date().toISOString();
  const who = JSON.stringify(actor);
  const include = JSON.stringify(input.include);
  const exclude = JSON.stringify(input.exclude);
  if (existing !== null) {
    db.run(
      "UPDATE areas SET purpose = ?, parent_id = ?, include = ?, exclude = ?, status = 'ok', status_reason = NULL, file_count = ?, written_count = ?, checked_sha = ?, updated_by = ?, updated_at = ? WHERE id = ?",
      [input.purpose, parentId, include, exclude, count, count, commit, who, now, existing.id],
    );
  } else {
    db.run(
      "INSERT INTO areas (id, name, purpose, parent_id, include, exclude, builtin, status, file_count, written_count, checked_sha, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'ok', ?, ?, ?, ?, ?, ?, ?)",
      [newId(), input.name, input.purpose, parentId, include, exclude, count, count, commit, who, who, now, now],
    );
  }
  return { area: getArea(db, input.name)! };
}

/** Removes an area; "tests" is built in and stays, and an area with areas nested in it is removed after them. */
export function removeArea(db: Database, name: string): { removed: string } | AreaRefusal {
  const area = getArea(db, name);
  if (area === null) return { reason: `no area ${name} in the code graph` };
  if (area.builtin) return { reason: `the area ${TESTS_AREA} is built in and cannot be removed; write its patterns to change what it holds` };
  const children = db.query("SELECT name FROM areas WHERE parent_id = ? ORDER BY name").all(area.id) as { name: string }[];
  if (children.length > 0) return { reason: `the area ${area.name} has areas nested in it (${children.map((c) => c.name).join(", ")}); remove them or move them first` };
  db.run("DELETE FROM areas WHERE id = ?", [area.id]);
  return { removed: area.name };
}

/** Re-checks every area against the base layer at `commit`; called inside the build's transaction. */
export function recheckAreas(db: Database, commit: string): void {
  ensureTestsArea(db);
  const files = layerFiles(db, BASE_LAYER);
  for (const row of rows(db)) {
    const area = load(db, row);
    const count = membersOf(area, files).length;
    const moved = Math.abs(count - area.filesWhenWritten);
    let status: AreaStatus = "ok";
    let reason: string | null = null;
    if (count === 0 && !area.builtin) {
      status = "broken";
      reason = `matches no file at ${commit.slice(0, 12)}`;
    } else if (!area.builtin && moved * 4 > area.filesWhenWritten) {
      status = "review";
      reason = `holds ${count} files at ${commit.slice(0, 12)}, ${area.filesWhenWritten} when it was written; look at its patterns`;
    }
    db.run("UPDATE areas SET status = ?, status_reason = ?, file_count = ?, checked_sha = ? WHERE id = ?", [status, reason, count, commit, row.id]);
  }
}

/**
 * The areas of each path, its main area first: a nested area before its parent, then the area
 * whose matching pattern is the most literal (the most characters before its first wildcard),
 * then the name that sorts first. "tests" has no pattern of its own unless one was written, so
 * it comes after any area that names the file by a pattern.
 */
export function areasOf(db: Database, paths: readonly string[]): Map<string, string[]> {
  const areas = listAreas(db);
  const depth = (area: Area) => (area.parent === null ? 0 : 1);
  const out = new Map<string, string[]>();
  for (const path of paths) {
    const held: { name: string; depth: number; literal: number }[] = [];
    for (const area of areas) {
      if (membersOf(area, [path]).length === 0) continue;
      const literal = Math.max(-1, ...area.include.filter((p) => globMatcher(p)(path)).map((p) => p.split(/[*?]/)[0]!.length));
      held.push({ name: area.name, depth: depth(area), literal });
    }
    held.sort((a, b) => b.depth - a.depth || b.literal - a.literal || a.name.localeCompare(b.name));
    out.set(path, held.map((h) => h.name));
  }
  return out;
}

/** The files of a layer in no area, and how many there are; `limit` caps the list. */
export function unplacedFiles(db: Database, layer: string, limit = 50): { count: number; files: string[] } {
  const areas = listAreas(db);
  const files = layerFiles(db, layer);
  const placed = new Set(areas.flatMap((area) => membersOf(area, files)));
  const unplaced = files.filter((file) => !placed.has(file));
  return { count: unplaced.length, files: unplaced.slice(0, limit) };
}

/** A filter over paths for search and scope: only the files in `area` (with its nested areas), and none in `skip`. */
export function areaFilter(db: Database, layer: string, options: { area?: string; skip?: string[] }): ((path: string) => boolean) | null {
  if (options.area === undefined && (options.skip ?? []).length === 0) return null;
  const areas = listAreas(db);
  const named = (name: string): Area => {
    const area = areas.find((a) => a.name === name);
    if (area === undefined) throw new UnknownAreaError(name, areas.map((a) => a.name));
    return area;
  };
  const files = layerFiles(db, layer);
  const withChildren = (area: Area) => [area, ...areas.filter((a) => a.parent === area.name)];
  const only = options.area === undefined ? null : new Set(withChildren(named(options.area)).flatMap((a) => membersOf(a, files)));
  const skip = new Set((options.skip ?? []).flatMap((name) => withChildren(named(name)).flatMap((a) => membersOf(a, files))));
  return (path) => (only === null || only.has(path)) && !skip.has(path);
}

export class UnknownAreaError extends Error {
  constructor(
    readonly area: string,
    readonly known: string[],
  ) {
    super(`no area ${area} in the code graph; the areas are ${known.join(", ")}`);
  }
}
