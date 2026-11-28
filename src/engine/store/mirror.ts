// The rows the record mirrors from the remote, and where each poll of the remote stopped
// (trustmybot/tmb#70). The syncer, or a change tmb first wrote to the remote, decides what changed;
// this file only finds rows by the remote's own id and writes through the event log, so the
// remote's changes are events like any other.
// sync_state is the one exception: it is not folded from events, and a poll that finds nothing
// writes nothing but it.
import type { Actor } from "./actor.ts";
import type { EventLog } from "./event-log.ts";
import { tableOf } from "./projections.ts";

/** The record kinds that mirror an item on the remote. */
export type MirrorKind = "issue" | "discussion" | "milestone" | "pull_request";

/** A mirrored row as stored: its columns by name. */
export type MirroredRow = Record<string, string | number | null> & { id: string };

/** One list of one remote, as the syncer keeps it between polls. */
export type SyncRow = {
  remote: string;
  list: string;
  tag: string | null;
  since: string | null;
  resume: string | null;
  syncedAt: string | null;
  fullPassAt: string | null;
  waitUntil: string | null;
  claimedBy: string | null;
  claimUntil: string | null;
  lastError: string | null;
};

type SyncStateRow = {
  remote: string;
  list: string;
  tag: string | null;
  since: string | null;
  resume: string | null;
  synced_at: string | null;
  full_pass_at: string | null;
  wait_until: string | null;
  claimed_by: string | null;
  claim_until: string | null;
  last_error: string | null;
};

const toSyncRow = (row: SyncStateRow): SyncRow => ({
  remote: row.remote,
  list: row.list,
  tag: row.tag,
  since: row.since,
  resume: row.resume,
  syncedAt: row.synced_at,
  fullPassAt: row.full_pass_at,
  waitUntil: row.wait_until,
  claimedBy: row.claimed_by,
  claimUntil: row.claim_until,
  lastError: row.last_error,
});

/** Why a claim on a remote was not given: another poll holds it, or it ran too recently. */
export type ClaimRefusal = { held: "claimed" | "floor" | "wait"; until: string };

export class MirrorRepository {
  constructor(private readonly log: EventLog) {}

  /** The repo row for a path inside the project, `.` for the project folder itself; made on first use. */
  repoId(actor: Actor, path: string): string {
    const row = this.log.db.query("SELECT id FROM repos WHERE path = ?").get(path) as { id: string } | null;
    return row?.id ?? this.log.create(actor, "repo", { path });
  }

  /** The row that mirrors the remote's item with this id, wherever the item now lives; null when none does. */
  findMirrored(kind: MirrorKind, remoteId: string): MirroredRow | null {
    return this.log.db.query(`SELECT * FROM ${tableOf(kind)} WHERE remote_id = ? ORDER BY id LIMIT 1`).get(remoteId) as MirroredRow | null;
  }

  /** The row of a kind with this record id, with its remote columns; null when there is none. */
  rowOf(kind: MirrorKind, id: string): MirroredRow | null {
    return this.log.db.query(`SELECT * FROM ${tableOf(kind)} WHERE id = ?`).get(id) as MirroredRow | null;
  }

  /** The milestone mirrored from this remote under this title and not gone from it; null when there is none. */
  milestoneTitled(remote: string, title: string): MirroredRow | null {
    return this.log.db
      .query("SELECT * FROM milestones WHERE remote = ? AND title = ? AND remote_id IS NOT NULL AND remote_gone_at IS NULL ORDER BY id LIMIT 1")
      .get(remote, title) as MirroredRow | null;
  }

  /** The issue the record holds with this number on this remote; null when it holds none. */
  issueIdOn(remote: string, number: number): string | null {
    const row = this.log.db.query("SELECT id FROM issues WHERE remote = ? AND remote_url LIKE ? ORDER BY id LIMIT 1").get(remote, `%/issues/${number}`) as { id: string } | null;
    return row?.id ?? null;
  }

  /** The feature branch or task that opened the pull request at this address, by the address it kept. */
  openerOf(url: string): { featureId: string | null; taskId: string | null } {
    const feature = this.log.db.query("SELECT id FROM features WHERE pr_url = ? ORDER BY id LIMIT 1").get(url) as { id: string } | null;
    if (feature !== null) return { featureId: feature.id, taskId: null };
    const task = this.log.db.query("SELECT id FROM tasks WHERE pr_url = ? ORDER BY id LIMIT 1").get(url) as { id: string } | null;
    return { featureId: null, taskId: task?.id ?? null };
  }

  /** The rows of a kind mirrored from one remote that are not marked gone, with their address. */
  presentMirrored(kind: Exclude<MirrorKind, "discussion">, remote: string): { id: string; remoteId: string; url: string | null; state: string }[] {
    const url = kind === "issue" ? "remote_url" : kind === "pull_request" ? "url" : "NULL";
    return this.log.db
      .query(`SELECT id, remote_id AS remoteId, ${url} AS url, state FROM ${tableOf(kind)} WHERE remote = ? AND remote_id IS NOT NULL AND remote_gone_at IS NULL ORDER BY id`)
      .all(remote) as { id: string; remoteId: string; url: string | null; state: string }[];
  }

  createMirrored(actor: Actor, kind: MirrorKind, data: Record<string, unknown>): string {
    return this.log.create(actor, kind, data);
  }

  /**
   * Records a change the remote holds on a mirrored row: one the syncer read, or one tmb wrote to
   * the remote first. A local row, or a note or a decision, never changes this way.
   */
  updateMirrored(actor: Actor, kind: MirrorKind, id: string, data: Record<string, unknown>): void {
    const row = this.rowOf(kind, id);
    if (row === null) throw new Error(`no ${kind} ${id}`);
    if (row.remote_id === null) throw new Error(`the ${kind} ${id} is local: the syncer never changes it`);
    if (kind === "discussion" && row.kind !== "comment") throw new Error(`the ${row.kind} ${id} is local: only a comment follows the remote`);
    this.log.update(actor, kind, id, data);
  }

  // --- sync_state -------------------------------------------------------------------------

  syncRows(remote?: string): SyncRow[] {
    const rows = (
      remote === undefined
        ? this.log.db.query("SELECT * FROM sync_state ORDER BY remote, list").all()
        : this.log.db.query("SELECT * FROM sync_state WHERE remote = ? ORDER BY list").all(remote)
    ) as SyncStateRow[];
    return rows.map(toSyncRow);
  }

  /** Writes one list's row as given, outside the events: a poll that finds nothing writes only this. */
  putSyncRow(row: SyncRow): void {
    this.log.db
      .query(
        `INSERT INTO sync_state (remote, list, tag, since, resume, synced_at, full_pass_at, wait_until, claimed_by, claim_until, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (remote, list) DO UPDATE SET tag = excluded.tag, since = excluded.since, resume = excluded.resume,
           synced_at = excluded.synced_at, full_pass_at = excluded.full_pass_at, wait_until = excluded.wait_until,
           claimed_by = excluded.claimed_by, claim_until = excluded.claim_until, last_error = excluded.last_error`,
      )
      .run(row.remote, row.list, row.tag, row.since, row.resume, row.syncedAt, row.fullPassAt, row.waitUntil, row.claimedBy, row.claimUntil, row.lastError);
  }

  /**
   * Takes the short claim on a remote's lists for `by` until `until`, in one transaction, so two
   * sessions never poll one remote at once. A claim left by a poll that died runs out by itself.
   * After a poll, the claim's end stays as the floor: no triggered poll before it, and a forced one
   * waits only for a live claim. The remote's own wait is never skipped.
   */
  claim(remote: string, lists: readonly string[], by: string, until: string, now: string, force: boolean): ClaimRefusal | null {
    return this.log.transaction(() => {
      const rows = new Map(this.syncRows(remote).map((row) => [row.list, row]));
      for (const row of rows.values()) {
        if (row.waitUntil !== null && row.waitUntil > now) return { held: "wait", until: row.waitUntil };
        if (row.claimUntil !== null && row.claimUntil > now) {
          if (row.claimedBy !== null) return { held: "claimed", until: row.claimUntil };
          if (!force) return { held: "floor", until: row.claimUntil };
        }
      }
      for (const list of lists) {
        const row = rows.get(list) ?? emptySyncRow(remote, list);
        this.putSyncRow({ ...row, claimedBy: by, claimUntil: until });
      }
      return null;
    });
  }

  /**
   * Gives back the claims `by` still holds, for a poll given up before it ended: with no claim and
   * no floor left from it, the next trigger polls at once.
   */
  releaseClaims(by: string): void {
    this.log.db.query("UPDATE sync_state SET claimed_by = NULL, claim_until = NULL WHERE claimed_by = ?").run(by);
  }
}

export function emptySyncRow(remote: string, list: string): SyncRow {
  return { remote, list, tag: null, since: null, resume: null, syncedAt: null, fullPassAt: null, waitUntil: null, claimedBy: null, claimUntil: null, lastError: null };
}
