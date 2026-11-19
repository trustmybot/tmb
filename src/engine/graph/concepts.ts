// Concepts: flows and rules written by agents, each anchored to the files and symbols that
// carry it out. They are the one part of the graph not derived from git, so a rebuild keeps
// them and re-checks each: one whose code is gone is marked broken, never dropped.
import type { Database } from "bun:sqlite";
import { newId } from "../ids.ts";
import type { Actor } from "../store/index.ts";
import { BASE_LAYER } from "./db.ts";

export const CONCEPT_KINDS = ["flow", "rule"] as const;
export type ConceptKind = (typeof CONCEPT_KINDS)[number];

/** A file, or a symbol in it, written `path` or `path#QualifiedName`. */
export type Anchor = { path: string; qualifiedName: string };

export type Concept = {
  id: string;
  name: string;
  kind: ConceptKind;
  body: string;
  status: "verified" | "broken";
  statusReason: string | null;
  checkedSha: string | null;
  anchors: (Anchor & { present: boolean })[];
  updatedAt: string;
};

export function parseAnchor(text: string): Anchor {
  const hash = text.indexOf("#");
  const path = (hash < 0 ? text : text.slice(0, hash)).trim().replace(/^\.\//, "");
  return { path, qualifiedName: hash < 0 ? "" : text.slice(hash + 1).trim() };
}

export const anchorText = (anchor: Anchor): string => (anchor.qualifiedName ? `${anchor.path}#${anchor.qualifiedName}` : anchor.path);

/** Whether the anchor's file, and its symbol when it names one, is in the layer. */
export function anchorPresent(db: Database, anchor: Anchor, layer = BASE_LAYER): boolean {
  if (anchor.qualifiedName === "") return db.query("SELECT 1 FROM files WHERE layer = ? AND path = ?").get(layer, anchor.path) !== null;
  return db.query("SELECT 1 FROM symbols WHERE layer = ? AND path = ? AND qualified_name = ?").get(layer, anchor.path, anchor.qualifiedName) !== null;
}

type ConceptRow = {
  id: string;
  name: string;
  kind: ConceptKind;
  body: string;
  status: "verified" | "broken";
  status_reason: string | null;
  checked_sha: string | null;
  updated_at: string;
};

function load(db: Database, row: ConceptRow): Concept {
  const anchors = db
    .query("SELECT path, qualified_name, present FROM concept_anchors WHERE concept_id = ? ORDER BY ordinal")
    .all(row.id) as { path: string; qualified_name: string; present: number }[];
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    body: row.body,
    status: row.status,
    statusReason: row.status_reason,
    checkedSha: row.checked_sha,
    anchors: anchors.map((a) => ({ path: a.path, qualifiedName: a.qualified_name, present: a.present === 1 })),
    updatedAt: row.updated_at,
  };
}

/**
 * Writes a concept, replacing the one of the same name. Every anchor must be in the current
 * base graph: a concept is anchored only on proof. Returns the concept and the anchors not found.
 */
export function upsertConcept(
  db: Database,
  actor: Actor,
  input: { name: string; kind: ConceptKind; body: string; anchors: Anchor[] },
  commit: string,
): { concept: Concept | null; missing: string[] } {
  const missing = input.anchors.filter((anchor) => !anchorPresent(db, anchor)).map(anchorText);
  if (missing.length > 0) return { concept: null, missing };
  const now = new Date().toISOString();
  const who = JSON.stringify(actor);
  const id = db.transaction(() => {
    const existing = db.query("SELECT id FROM concepts WHERE name = ?").get(input.name) as { id: string } | null;
    const conceptId = existing?.id ?? newId();
    if (existing) {
      db.run("UPDATE concepts SET kind = ?, body = ?, status = 'verified', status_reason = NULL, checked_at = ?, checked_sha = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
        input.kind,
        input.body,
        now,
        commit,
        who,
        now,
        conceptId,
      ]);
      db.run("DELETE FROM concept_anchors WHERE concept_id = ?", [conceptId]);
    } else {
      db.run(
        "INSERT INTO concepts (id, name, kind, body, status, checked_at, checked_sha, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?)",
        [conceptId, input.name, input.kind, input.body, now, commit, who, who, now, now],
      );
    }
    input.anchors.forEach((anchor, ordinal) => {
      db.run("INSERT INTO concept_anchors (concept_id, ordinal, path, qualified_name, present) VALUES (?, ?, ?, ?, 1)", [conceptId, ordinal, anchor.path, anchor.qualifiedName]);
    });
    return conceptId;
  })();
  return { concept: getConcept(db, id), missing: [] };
}

export function getConcept(db: Database, idOrName: string): Concept | null {
  const row = db.query("SELECT * FROM concepts WHERE id = ? OR name = ?").get(idOrName, idOrName) as ConceptRow | null;
  return row === null ? null : load(db, row);
}

/** Every concept, or those whose name or body holds each word of `query`; broken ones first. */
export function listConcepts(db: Database, query?: string): Concept[] {
  const rows = db.query("SELECT * FROM concepts ORDER BY status = 'verified', name").all() as ConceptRow[];
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => words.every((w) => `${row.name} ${row.body}`.toLowerCase().includes(w))).map((row) => load(db, row));
}

/** Concepts anchored to any of `paths`. */
export function conceptsOn(db: Database, paths: readonly string[]): Concept[] {
  if (paths.length === 0) return [];
  const rows = db
    .query(`SELECT DISTINCT c.* FROM concepts c JOIN concept_anchors a ON a.concept_id = c.id WHERE a.path IN (${paths.map(() => "?").join(", ")}) ORDER BY c.name`)
    .all(...paths) as ConceptRow[];
  return rows.map((row) => load(db, row));
}

/** Re-checks every concept against the base layer at `commit`; called inside the build's transaction. */
export function recheckConcepts(db: Database, commit: string): void {
  const now = new Date().toISOString();
  const anchors = db.query("SELECT concept_id, ordinal, path, qualified_name FROM concept_anchors").all() as {
    concept_id: string;
    ordinal: number;
    path: string;
    qualified_name: string;
  }[];
  const gone = new Map<string, string[]>();
  for (const a of anchors) {
    const anchor = { path: a.path, qualifiedName: a.qualified_name };
    const present = anchorPresent(db, anchor);
    db.run("UPDATE concept_anchors SET present = ? WHERE concept_id = ? AND ordinal = ?", [present ? 1 : 0, a.concept_id, a.ordinal]);
    if (!present) gone.set(a.concept_id, [...(gone.get(a.concept_id) ?? []), anchorText(anchor)]);
  }
  for (const { id } of db.query("SELECT id FROM concepts").all() as { id: string }[]) {
    const missing = gone.get(id);
    db.run("UPDATE concepts SET status = ?, status_reason = ?, checked_at = ?, checked_sha = ? WHERE id = ?", [
      missing ? "broken" : "verified",
      missing ? `gone at ${commit.slice(0, 12)}: ${missing.join(", ")}` : null,
      now,
      commit,
      id,
    ]);
  }
}
